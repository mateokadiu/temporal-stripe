import { proxyActivities, setHandler, condition, sleep, log } from '@temporalio/workflow';
import type { StripeOrderActivities } from '../activities/interface.js';
import { initialStateFromArgs, type StripeOrderArgs, type WorkflowState } from '../state.js';
import { getReauthTimerMs } from './reauth-timer.js';
import {
  captureSignal,
  cancelSignal,
  reauthorizeSignal,
  reviseSignal,
  stateQuery,
  type CaptureSignalInput,
  type CancelSignalInput,
  type ReviseSignalInput,
} from './signals.js';

const activities = proxyActivities<StripeOrderActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    maximumInterval: '1m',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

interface Pending {
  capture?: CaptureSignalInput;
  cancel?: CancelSignalInput;
  revise?: ReviseSignalInput;
  reauthAdmin?: boolean;
}

/**
 * Owns one PaymentIntent from authorization through capture or cancellation.
 *
 * Implementation is intentionally a single loop racing a timer against any
 * inbound signal. State transitions are persisted by the consumer-provided
 * `persistContext` activity. Hooks (`onReauthorized`, `onCaptured`, etc.) let
 * the consumer mirror state into their own DB / queue.
 *
 * Phase 1 ships the reauth + capture + cancel branches. Phase 2 fills in
 * `revise` and `refund` (refund runs in a sibling workflow — see PLAN §7.3).
 */
export async function stripeOrderWorkflow(args: StripeOrderArgs): Promise<WorkflowState> {
  let state = initialStateFromArgs(args);
  const pending: Pending = {};

  setHandler(captureSignal, (input) => {
    pending.capture = input;
  });
  setHandler(cancelSignal, (input) => {
    pending.cancel = input;
  });
  setHandler(reauthorizeSignal, () => {
    pending.reauthAdmin = true;
  });
  setHandler(reviseSignal, (input) => {
    pending.revise = input;
  });
  setHandler(stateQuery, () => state);

  while (state.status !== 'captured' && state.status !== 'canceled' && state.status !== 'failed') {
    const timerMs = getReauthTimerMs({
      cardBrand: state.cardBrand,
      authCreatedAt: state.authCreatedAt,
      captureBefore: state.captureBefore,
    });

    log.info('waiting for next event', {
      orderId: state.orderId,
      timerMs,
      reauthorizationCount: state.reauthorizationCount,
    });

    // Race: any pending signal returns immediately; else sleep until the
    // reauth deadline and reauthorize then.
    const settled = await Promise.race([
      condition(() => Boolean(pending.capture || pending.cancel || pending.revise || pending.reauthAdmin)),
      sleep(timerMs).then(() => 'timer' as const),
    ]);

    if (pending.cancel) {
      state = await runCancel(state, pending.cancel);
      pending.cancel = undefined;
      break;
    }
    if (pending.capture) {
      state = await runCapture(state, pending.capture);
      pending.capture = undefined;
      break;
    }
    if (pending.revise) {
      state = await runRevise(state, pending.revise);
      pending.revise = undefined;
      continue;
    }
    if (pending.reauthAdmin || settled === 'timer') {
      state = await runReauthorize(state);
      pending.reauthAdmin = false;
      continue;
    }
  }

  return state;
}

async function runReauthorize(state: WorkflowState): Promise<WorkflowState> {
  state = { ...state, status: 'reauthorizing' };
  try {
    const result = await activities.reauthorizePayment({
      orderId: state.orderId,
      oldPaymentIntentId: state.paymentIntentId,
      paymentMethodId: state.paymentMethodId,
      stripeAccountId: state.stripeAccountId,
      customerId: state.customerId,
      amountCents: state.amountCents,
      currency: state.currency,
      metadata: state.metadata,
    });
    const next: WorkflowState = {
      ...state,
      paymentIntentId: result.newPaymentIntentId,
      authCreatedAt: result.authCreatedAt,
      captureBefore: result.captureBefore,
      cardBrand: result.cardBrand,
      reauthorizationCount: state.reauthorizationCount + 1,
      status: 'authorized',
    };
    await activities.persistContext(next);
    await activities.onReauthorized(next, {
      id: result.newPaymentIntentId,
      captureBefore: result.captureBefore,
    });
    return next;
  } catch (err) {
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, errorPayload(err));
    return failed;
  }
}

async function runCapture(state: WorkflowState, input: CaptureSignalInput): Promise<WorkflowState> {
  state = { ...state, status: 'capturing' };
  try {
    const result = await activities.capturePaymentIntent({
      paymentIntentId: state.paymentIntentId,
      stripeAccountId: state.stripeAccountId,
      amountToCaptureCents: input.amountToCaptureCents,
      applicationFeeCents: input.applicationFeeCents,
    });
    const next: WorkflowState = { ...state, status: 'captured' };
    await activities.persistContext(next);
    await activities.onCaptured(next, { id: result.chargeId, amountCents: result.amountCapturedCents });
    return next;
  } catch (err) {
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, errorPayload(err));
    return failed;
  }
}

async function runCancel(state: WorkflowState, input: CancelSignalInput): Promise<WorkflowState> {
  state = { ...state, status: 'canceling' };
  try {
    await activities.cancelPaymentIntent({
      paymentIntentId: state.paymentIntentId,
      stripeAccountId: state.stripeAccountId,
      reason: input.reason,
    });
    const next: WorkflowState = { ...state, status: 'canceled' };
    await activities.persistContext(next);
    await activities.onCanceled(next, input.reason);
    return next;
  } catch (err) {
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, errorPayload(err));
    return failed;
  }
}

async function runRevise(state: WorkflowState, input: ReviseSignalInput): Promise<WorkflowState> {
  if (input.newAmountCents > state.amountCents) {
    // Increase not supported — Stripe requires a fresh auth flow for an
    // increase. Surface as failure; consumer can decide how to recover.
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, {
      name: 'StripeOrderError',
      message: 'revise: newAmountCents > current amount; increase not supported',
    });
    return failed;
  }
  state = { ...state, status: 'revising' };
  try {
    const result = await activities.revisePaymentIntent({
      orderId: state.orderId,
      oldPaymentIntentId: state.paymentIntentId,
      paymentMethodId: state.paymentMethodId,
      stripeAccountId: state.stripeAccountId,
      customerId: state.customerId,
      amountCents: state.amountCents,
      newAmountCents: input.newAmountCents,
      currency: state.currency,
      metadata: { ...state.metadata, revisionReason: input.reason ?? '' },
    });
    const next: WorkflowState = {
      ...state,
      paymentIntentId: result.newPaymentIntentId,
      amountCents: input.newAmountCents,
      authCreatedAt: result.authCreatedAt,
      captureBefore: result.captureBefore,
      cardBrand: result.cardBrand,
      reauthorizationCount: state.reauthorizationCount + 1,
      status: 'authorized',
    };
    await activities.persistContext(next);
    await activities.onReauthorized(next, {
      id: result.newPaymentIntentId,
      captureBefore: result.captureBefore,
    });
    return next;
  } catch (err) {
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, errorPayload(err));
    return failed;
  }
}

function errorPayload(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: String(err) };
}
