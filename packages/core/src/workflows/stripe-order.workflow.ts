import { proxyActivities, setHandler, condition, sleep, log } from '@temporalio/workflow';
import type { StripeOrderActivities } from '../activities/interface.js';
import { initialStateFromArgs, type StripeOrderArgs, type WorkflowState } from '../state.js';
import { getReauthTimerMs } from './reauth-timer.js';
import {
  captureSignal,
  cancelSignal,
  multicaptureSignal,
  reauthorizeSignal,
  reviseSignal,
  stateQuery,
  type CaptureSignalInput,
  type CancelSignalInput,
  type MulticaptureSignalInput,
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
  multicapture: MulticaptureSignalInput[];
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
  const pending: Pending = { multicapture: [] };

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
  setHandler(multicaptureSignal, (input) => {
    pending.multicapture.push(input);
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
      condition(
        () =>
          Boolean(pending.capture || pending.cancel || pending.revise || pending.reauthAdmin) ||
          pending.multicapture.length > 0,
      ),
      sleep(timerMs).then(() => 'timer' as const),
    ]);

    // Priority order:
    //   1. cancel — explicit kill wins over everything
    //   2. revise — re-amount BEFORE a possibly-queued capture so the user
    //               captures at the new amount, not the old
    //   3. admin reauth — same reasoning: run a queued non-terminal reauth
    //                     before a terminal capture
    //   4. multicapture — slice captures before a terminal full capture (the
    //                     final slice carries isFinal and ends the loop)
    //   5. capture — terminal action
    //   6. timer — implicit reauth deadline reached
    if (pending.cancel) {
      state = await runCancel(state, pending.cancel);
      pending.cancel = undefined;
      break;
    }
    if (pending.revise) {
      state = await runRevise(state, pending.revise);
      pending.revise = undefined;
      continue;
    }
    if (pending.reauthAdmin) {
      state = await runReauthorize(state);
      pending.reauthAdmin = false;
      continue;
    }
    if (pending.multicapture.length > 0) {
      const slice = pending.multicapture.shift()!;
      state = await runMulticapture(state, slice);
      if (state.status === 'captured' || state.status === 'failed') break;
      continue;
    }
    if (pending.capture) {
      state = await runCapture(state, pending.capture);
      pending.capture = undefined;
      break;
    }
    if (settled === 'timer') {
      state = await runReauthorize(state);
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
    const next: WorkflowState = {
      ...state,
      capturedAmountCents: state.capturedAmountCents + result.amountCapturedCents,
      captures: [
        ...state.captures,
        {
          chargeId: result.chargeId,
          amountCents: result.amountCapturedCents,
          at: Date.now(),
          isFinal: true,
        },
      ],
      status: 'captured',
    };
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

async function runMulticapture(
  state: WorkflowState,
  input: MulticaptureSignalInput,
): Promise<WorkflowState> {
  const remaining = state.amountCents - state.capturedAmountCents;
  if (input.amountCents <= 0 || input.amountCents > remaining) {
    const failed: WorkflowState = { ...state, status: 'failed' };
    await activities.persistContext(failed);
    await activities.onFailure(failed, {
      name: 'StripeOrderError',
      message: `multicapture: amountCents ${input.amountCents} out of range (remaining: ${remaining})`,
    });
    return failed;
  }
  // Activity wiring lands in the next commit. For this commit, just append
  // the slice to the audit log so downstream code can rely on the shape.
  const isFinal = input.isFinal ?? false;
  const next: WorkflowState = {
    ...state,
    capturedAmountCents: state.capturedAmountCents + input.amountCents,
    captures: [
      ...state.captures,
      {
        chargeId: 'pending',
        amountCents: input.amountCents,
        at: Date.now(),
        isFinal,
      },
    ],
    status: isFinal ? 'captured' : 'authorized',
  };
  await activities.persistContext(next);
  if (isFinal) {
    await activities.onCaptured(next, { id: 'pending', amountCents: input.amountCents });
  }
  return next;
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
