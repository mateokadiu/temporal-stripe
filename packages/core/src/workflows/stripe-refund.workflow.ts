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
      pending.refund.shift();
      continue;
    }
  }

  return state;
}

function isTerminal(state: RefundWorkflowState): boolean {
  return state.status === 'failed' || state.status === 'fully_refunded';
}
