import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { CancelReason, WorkflowState } from '../state.js';

export interface CaptureSignalInput {
  /** Optional partial capture amount (cents). Omit for full capture. */
  amountToCaptureCents?: number;
  /** Application-fee override for Connect. Omit to keep PI's existing value. */
  applicationFeeCents?: number;
}

export interface CancelSignalInput {
  reason: CancelReason;
  notes?: string;
}

export interface ReviseSignalInput {
  /** New PI amount in cents. Must be <= current amount. */
  newAmountCents: number;
  /** Optional human-readable reason kept on the new PI's metadata. */
  reason?: string;
}

export interface MulticaptureSignalInput {
  /** Cents to capture in this call. The PI accumulates captures up to the authorized amount. */
  amountCents: number;
  /** When true, mark this as the final capture — Stripe releases any remaining hold. */
  isFinal?: boolean;
  /** Application-fee override for Connect, applied to this slice. */
  applicationFeeCents?: number;
}

export const captureSignal = defineSignal<[CaptureSignalInput]>('capture');
export const cancelSignal = defineSignal<[CancelSignalInput]>('cancel');
export const reauthorizeSignal = defineSignal<[]>('reauthorize');
export const reviseSignal = defineSignal<[ReviseSignalInput]>('revise');
export const multicaptureSignal = defineSignal<[MulticaptureSignalInput]>('multicapture');

export const stateQuery = defineQuery<WorkflowState>('state');
