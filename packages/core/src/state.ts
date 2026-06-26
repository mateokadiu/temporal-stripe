import { z } from 'zod';

export const StripeOrderArgsSchema = z.object({
  orderId: z.string().min(1),
  paymentIntentId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  stripeAccountId: z.string().min(1),
  customerId: z.string().min(1),
  initialAmountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  initialCardBrand: z.string().min(1),
  authCreatedAt: z.number().int().positive(),
  captureBefore: z.number().int().positive().nullable(),
  reauthorizationCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string()).optional(),
});
// z.input — `reauthorizationCount` and `metadata` are optional in caller input;
// `initialStateFromArgs` applies defaults.
export type StripeOrderArgs = z.input<typeof StripeOrderArgsSchema>;

export interface CaptureLogEntry {
  chargeId: string;
  amountCents: number;
  /** epoch ms */
  at: number;
  isFinal: boolean;
}

/** Workflow-local mutable state. Persisted via the consumer-provided
 *  `persistContext` activity after every successful state transition. */
export interface WorkflowState {
  orderId: string;
  paymentIntentId: string;
  paymentMethodId: string;
  stripeAccountId: string;
  customerId: string;
  /** Authorized amount on the active PI. */
  amountCents: number;
  /** Sum of amounts captured so far — accumulates across multicapture slices. */
  capturedAmountCents: number;
  /** Audit log of every capture slice the workflow has executed. */
  captures: CaptureLogEntry[];
  currency: string;
  cardBrand: string;
  authCreatedAt: number;
  captureBefore: number | null;
  reauthorizationCount: number;
  metadata: Record<string, string>;
  status: WorkflowStatus;
}

export type WorkflowStatus =
  | 'authorized'
  | 'reauthorizing'
  | 'revising'
  | 'capturing'
  | 'captured'
  | 'canceling'
  | 'canceled'
  | 'failed';

export type CancelReason = 'customer' | 'admin' | 'fraud' | 'timeout' | 'unrecoverable_error';

export const StripeRefundArgsSchema = z.object({
  orderId: z.string().min(1),
  /** Original PI that's being refunded — already captured. */
  paymentIntentId: z.string().min(1),
  /** Connect account that owns the PI. */
  stripeAccountId: z.string().min(1),
  /** Captured amount in cents — the maximum that can be refunded. */
  capturedAmountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  /** Refund the application fee proportionally? Default off; opt in per refund. */
  refundApplicationFee: z.boolean().optional(),
  /** Reverse the destination transfer? Default off. */
  reverseTransfer: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
});
export type StripeRefundArgs = z.input<typeof StripeRefundArgsSchema>;

export type RefundStatus =
  | 'idle'
  | 'refunding'
  | 'partially_refunded'
  | 'fully_refunded'
  | 'disputed'
  | 'dispute_closed'
  | 'failed';

export interface RefundLogEntry {
  refundId: string;
  amountCents: number;
  /** epoch ms */
  at: number;
  reason?: string;
  /** When the refund was issued as part of a dispute resolution. */
  disputeId?: string;
}

export interface DisputeLogEntry {
  disputeId: string;
  amountCents: number;
  /** 'opened' | 'closed' */
  event: 'opened' | 'closed';
  /** Closed-state status (won/lost/warning_closed). Absent on 'opened'. */
  closedStatus?: string;
  /** epoch ms */
  at: number;
}

/** Workflow-local mutable state for the refund/chargeback workflow. */
export interface RefundWorkflowState {
  orderId: string;
  paymentIntentId: string;
  stripeAccountId: string;
  currency: string;
  /** Original captured amount — the ceiling on cumulative refunds. */
  capturedAmountCents: number;
  /** Sum of all successful refunds so far. */
  refundedAmountCents: number;
  refundApplicationFee: boolean;
  reverseTransfer: boolean;
  metadata: Record<string, string>;
  status: RefundStatus;
  refunds: RefundLogEntry[];
  disputes: DisputeLogEntry[];
}

export function initialRefundStateFromArgs(args: StripeRefundArgs): RefundWorkflowState {
  return {
    orderId: args.orderId,
    paymentIntentId: args.paymentIntentId,
    stripeAccountId: args.stripeAccountId,
    currency: args.currency,
    capturedAmountCents: args.capturedAmountCents,
    refundedAmountCents: 0,
    refundApplicationFee: args.refundApplicationFee ?? false,
    reverseTransfer: args.reverseTransfer ?? false,
    metadata: args.metadata ?? {},
    status: 'idle',
    refunds: [],
    disputes: [],
  };
}

export function initialStateFromArgs(args: StripeOrderArgs): WorkflowState {
  return {
    orderId: args.orderId,
    paymentIntentId: args.paymentIntentId,
    paymentMethodId: args.paymentMethodId,
    stripeAccountId: args.stripeAccountId,
    customerId: args.customerId,
    amountCents: args.initialAmountCents,
    capturedAmountCents: 0,
    captures: [],
    currency: args.currency,
    cardBrand: args.initialCardBrand,
    authCreatedAt: args.authCreatedAt,
    captureBefore: args.captureBefore,
    reauthorizationCount: args.reauthorizationCount ?? 0,
    metadata: args.metadata ?? {},
    status: 'authorized',
  };
}
