import type { CancelReason, WorkflowState } from '../state.js';

export interface ReauthorizeInput {
  orderId: string;
  oldPaymentIntentId: string;
  paymentMethodId: string;
  stripeAccountId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface ReauthorizeResult {
  newPaymentIntentId: string;
  authCreatedAt: number;
  captureBefore: number | null;
  cardBrand: string;
}

export interface CaptureInput {
  paymentIntentId: string;
  stripeAccountId: string;
  amountToCaptureCents?: number;
  applicationFeeCents?: number;
}

export interface CaptureResult {
  chargeId: string;
  amountCapturedCents: number;
}

export interface CancelInput {
  paymentIntentId: string;
  stripeAccountId: string;
  reason: CancelReason;
}

export interface ReviseInput extends ReauthorizeInput {
  newAmountCents: number;
}

export type ReviseResult = ReauthorizeResult;

export interface RefundInput {
  paymentIntentId: string;
  stripeAccountId: string;
  amountCents?: number;
  reverseTransfer?: boolean;
  refundApplicationFee?: boolean;
}

export interface RefundResult {
  refundId: string;
  amountCents: number;
}

/**
 * All methods are non-optional so `proxyActivities<StripeOrderActivities>` can
 * call them through Temporal without optional-chain gymnastics. The default
 * `makeStripeActivities` helper fills in no-op implementations for the
 * notification hooks (`onCaptured`, etc.) when the consumer doesn't provide
 * them — that's the layer where "optional" lives.
 */
export interface StripeOrderActivities {
  reauthorizePayment(input: ReauthorizeInput): Promise<ReauthorizeResult>;
  capturePaymentIntent(input: CaptureInput): Promise<CaptureResult>;
  cancelPaymentIntent(input: CancelInput): Promise<void>;
  revisePaymentIntent(input: ReviseInput): Promise<ReviseResult>;
  refundPaymentIntent(input: RefundInput): Promise<RefundResult>;

  /** Persist the new state to your DB after every transition. */
  persistContext(ctx: WorkflowState): Promise<void>;

  /** Notification hooks — workflow doesn't care about return values. */
  onCaptured(ctx: WorkflowState, charge: { id: string; amountCents: number }): Promise<void>;
  onCanceled(ctx: WorkflowState, reason: CancelReason): Promise<void>;
  onReauthorized(
    ctx: WorkflowState,
    pi: { id: string; captureBefore: number | null },
  ): Promise<void>;
  onFailure(ctx: WorkflowState, err: { name: string; message: string }): Promise<void>;
}
