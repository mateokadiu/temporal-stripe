import { proxyActivities, setHandler, condition, log } from '@temporalio/workflow';
import type { StripeRefundActivities } from '../activities/interface.js';
import {
  initialRefundStateFromArgs,
  type RefundWorkflowState,
  type StripeRefundArgs,
} from '../state.js';
import {
  disputeClosedSignal,
  disputeOpenedSignal,
  refundRequestSignal,
  refundStateQuery,
  type DisputeClosedSignalInput,
  type DisputeOpenedSignalInput,
  type RefundRequestSignalInput,
} from './refund-signals.js';

const activities = proxyActivities<StripeRefundActivities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    maximumInterval: '1m',
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

interface RefundPending {
  refund: RefundRequestSignalInput[];
  disputeOpened?: DisputeOpenedSignalInput;
  disputeClosed?: DisputeClosedSignalInput;
}

/**
 * Refund / chargeback workflow. Started by the consumer post-capture and lives
 * for as long as Stripe might generate dispute events against the original PI
 * (the chargeback window for cards is typically 60-120 days depending on
 * scheme). Kept deliberately separate from `stripeOrderWorkflow` so the order
 * lifecycle can terminate cleanly at capture while this one keeps listening.
 *
 * Scaffold only in this commit — the refund + dispute branches land in the
 * follow-up commits.
 */
export async function stripeRefundWorkflow(args: StripeRefundArgs): Promise<RefundWorkflowState> {
  let state = initialRefundStateFromArgs(args);
  const pending: RefundPending = { refund: [] };

  setHandler(refundRequestSignal, (input) => {
    pending.refund.push(input);
  });
  setHandler(disputeOpenedSignal, (input) => {
    pending.disputeOpened = input;
  });
  setHandler(disputeClosedSignal, (input) => {
    pending.disputeClosed = input;
  });
  setHandler(refundStateQuery, () => state);

  // The workflow exits once the captured amount is fully refunded AND no
  // dispute is open. Until then it sits and waits for signals — refunds can
  // arrive over days/weeks (chargeback window).
  while (!isTerminal(state)) {
    log.info('refund workflow waiting', {
      orderId: state.orderId,
      paymentIntentId: state.paymentIntentId,
      refundedAmountCents: state.refundedAmountCents,
      capturedAmountCents: state.capturedAmountCents,
      status: state.status,
    });

    await condition(
      () =>
        pending.refund.length > 0 || Boolean(pending.disputeOpened) || Boolean(pending.disputeClosed),
    );

    // Dispute-open events take priority — once a dispute is open we may need
    // to short-circuit pending refund requests, since Stripe will refuse to
    // refund a disputed charge.
    if (pending.disputeOpened) {
      // Wired up in commit 4.
      pending.disputeOpened = undefined;
      continue;
    }
    if (pending.disputeClosed) {
      pending.disputeClosed = undefined;
      continue;
    }
    if (pending.refund.length > 0) {
      const next = pending.refund.shift()!;
      state = await runRefund(state, next);
      continue;
    }
  }

  return state;
}

async function runRefund(
  state: RefundWorkflowState,
  input: RefundRequestSignalInput,
): Promise<RefundWorkflowState> {
  // Default to refunding the entire remaining balance — this is the common
  // case for "cancel after capture" flows.
  const remaining = state.capturedAmountCents - state.refundedAmountCents;
  const amountCents = input.amountCents ?? remaining;

  // Guard against overflow — Stripe would reject it anyway, but failing fast
  // gives the consumer a clean state transition instead of a cryptic API error.
  if (amountCents <= 0 || amountCents > remaining) {
    const failed: RefundWorkflowState = { ...state, status: 'failed' };
    await activities.persistRefundContext(failed);
    await activities.onRefundFailure(failed, {
      name: 'StripeOrderError',
      message: `refund: amountCents ${amountCents} out of range (remaining: ${remaining})`,
    });
    return failed;
  }

  const previousStatus = state.status;
  state = { ...state, status: 'refunding' };
  try {
    const result = await activities.refundPaymentIntent({
      paymentIntentId: state.paymentIntentId,
      stripeAccountId: state.stripeAccountId,
      amountCents,
      reverseTransfer: input.reverseTransfer ?? state.reverseTransfer,
      refundApplicationFee: input.refundApplicationFee ?? state.refundApplicationFee,
      reason: input.reason,
      metadata: {
        ...state.metadata,
        ...(input.notes ? { refundNotes: input.notes } : {}),
      },
    });
    const refundedAmountCents = state.refundedAmountCents + result.amountCents;
    const nextStatus =
      refundedAmountCents >= state.capturedAmountCents ? 'fully_refunded' : 'partially_refunded';
    const next: RefundWorkflowState = {
      ...state,
      refundedAmountCents,
      refunds: [
        ...state.refunds,
        {
          refundId: result.refundId,
          amountCents: result.amountCents,
          at: Date.now(),
          reason: input.reason,
        },
      ],
      status: nextStatus,
    };
    await activities.persistRefundContext(next);
    await activities.onRefunded(next, { id: result.refundId, amountCents: result.amountCents });
    return next;
  } catch (err) {
    // Roll back the transient `refunding` status if we want to allow retries,
    // but for a failed Stripe call we land in `failed`. Consumer can decide to
    // restart the workflow.
    void previousStatus;
    const failed: RefundWorkflowState = { ...state, status: 'failed' };
    await activities.persistRefundContext(failed);
    await activities.onRefundFailure(failed, errorPayload(err));
    return failed;
  }
}

function errorPayload(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'UnknownError', message: String(err) };
}

function isTerminal(state: RefundWorkflowState): boolean {
  return state.status === 'failed' || state.status === 'fully_refunded';
}
