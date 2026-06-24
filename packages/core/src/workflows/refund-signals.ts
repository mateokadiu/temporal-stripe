import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { RefundWorkflowState } from '../state.js';

export interface RefundRequestSignalInput {
  /** Amount to refund in cents. Omit for a full refund of the remaining balance. */
  amountCents?: number;
  /** Stripe-supported reason. Free-form notes belong in `notes`. */
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  /** Human-readable note attached to the refund's metadata. */
  notes?: string;
  /** Override Connect defaults. */
  reverseTransfer?: boolean;
  refundApplicationFee?: boolean;
}

export interface DisputeOpenedSignalInput {
  disputeId: string;
  /** Disputed amount in cents (Stripe sends this on dispute.created). */
  amountCents: number;
  reason?: string;
}

export interface DisputeClosedSignalInput {
  disputeId: string;
  /** Stripe dispute status, e.g. 'won', 'lost', 'warning_closed'. */
  status: string;
}

export const refundRequestSignal = defineSignal<[RefundRequestSignalInput]>('refundRequest');
export const disputeOpenedSignal = defineSignal<[DisputeOpenedSignalInput]>('disputeOpened');
export const disputeClosedSignal = defineSignal<[DisputeClosedSignalInput]>('disputeClosed');

export const refundStateQuery = defineQuery<RefundWorkflowState>('refundState');
