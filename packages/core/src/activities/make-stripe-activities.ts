import type Stripe from 'stripe';
import { REAUTHORIZATION_METADATA_KEY, REAUTHORIZATION_METADATA_VALUE } from '../constants.js';
import { StripeOrderError, ERROR_CODES } from '../errors.js';
import type {
  CaptureInput,
  CaptureResult,
  CancelInput,
  ReauthorizeInput,
  ReauthorizeResult,
  RefundInput,
  RefundResult,
  ReviseInput,
  ReviseResult,
  StripeOrderActivities,
} from './interface.js';

export interface MakeStripeActivitiesOptions {
  persistContext: StripeOrderActivities['persistContext'];
  onCaptured?: StripeOrderActivities['onCaptured'];
  onCanceled?: StripeOrderActivities['onCanceled'];
  onReauthorized?: StripeOrderActivities['onReauthorized'];
  onFailure?: StripeOrderActivities['onFailure'];

  /** Override the cancellation_reason used when our reauth flow cancels the
   *  old PaymentIntent. Default: 'abandoned'. */
  reauthCancellationReason?: Stripe.PaymentIntentCancelParams.CancellationReason;
}

const noopHook = async (): Promise<void> => {
  // intentional no-op
};

/**
 * Wraps the official Stripe SDK with the activity contract this workflow
 * expects. Most consumers can call this directly; if you need to instrument
 * a specific activity (e.g. wrap reauth in your own retry logic), you can
 * override individual fields on the returned object.
 */
export function makeStripeActivities(
  stripe: Stripe,
  opts: MakeStripeActivitiesOptions,
): StripeOrderActivities {
  const reauthReason = opts.reauthCancellationReason ?? 'abandoned';

  async function tagAndCancel(piId: string, stripeAccount: string): Promise<void> {
    await stripe.paymentIntents.update(
      piId,
      { metadata: { [REAUTHORIZATION_METADATA_KEY]: REAUTHORIZATION_METADATA_VALUE } },
      { stripeAccount },
    );
    await stripe.paymentIntents.cancel(
      piId,
      { cancellation_reason: reauthReason },
      { stripeAccount },
    );
  }

  async function createReauthorizedIntent(
    input: ReauthorizeInput,
    extraMetadata: Record<string, string>,
  ): Promise<ReauthorizeResult> {
    const created = await stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency,
        customer: input.customerId,
        payment_method: input.paymentMethodId,
        capture_method: 'manual',
        off_session: true,
        confirm: true,
        metadata: {
          ...input.metadata,
          ...extraMetadata,
          reauthOf: input.oldPaymentIntentId,
        },
      },
      { stripeAccount: input.stripeAccountId },
    );
    const charge = created.latest_charge
      ? typeof created.latest_charge === 'string'
        ? await stripe.charges.retrieve(created.latest_charge, { stripeAccount: input.stripeAccountId })
        : created.latest_charge
      : null;
    const captureBeforeSec = charge?.payment_method_details?.card?.capture_before;
    const cardBrand = charge?.payment_method_details?.card?.brand ?? 'unknown';
    return {
      newPaymentIntentId: created.id,
      authCreatedAt: Date.now(),
      captureBefore: captureBeforeSec ? captureBeforeSec * 1000 : null,
      cardBrand,
    };
  }

  const activities: StripeOrderActivities = {
    persistContext: opts.persistContext,
    onCaptured: opts.onCaptured ?? noopHook,
    onCanceled: opts.onCanceled ?? noopHook,
    onReauthorized: opts.onReauthorized ?? noopHook,
    onFailure: opts.onFailure ?? noopHook,

    async reauthorizePayment(input: ReauthorizeInput): Promise<ReauthorizeResult> {
      try {
        await tagAndCancel(input.oldPaymentIntentId, input.stripeAccountId);
        return await createReauthorizedIntent(input, {});
      } catch (err) {
        throw new StripeOrderError(
          ERROR_CODES.REAUTH_FAILED,
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async capturePaymentIntent(input: CaptureInput): Promise<CaptureResult> {
      const captured = await stripe.paymentIntents.capture(
        input.paymentIntentId,
        {
          ...(input.amountToCaptureCents !== undefined
            ? { amount_to_capture: input.amountToCaptureCents }
            : {}),
          ...(input.applicationFeeCents !== undefined
            ? { application_fee_amount: input.applicationFeeCents }
            : {}),
        },
        { stripeAccount: input.stripeAccountId },
      );
      const chargeId =
        typeof captured.latest_charge === 'string'
          ? captured.latest_charge
          : captured.latest_charge?.id;
      if (!chargeId) {
        throw new StripeOrderError(
          ERROR_CODES.INVARIANT_VIOLATED,
          'capture: latest_charge missing on captured PaymentIntent',
        );
      }
      return {
        chargeId,
        amountCapturedCents: captured.amount_received ?? captured.amount,
      };
    },

    async cancelPaymentIntent(input: CancelInput): Promise<void> {
      await stripe.paymentIntents.cancel(
        input.paymentIntentId,
        { cancellation_reason: 'requested_by_customer' },
        { stripeAccount: input.stripeAccountId },
      );
    },

    async revisePaymentIntent(input: ReviseInput): Promise<ReviseResult> {
      try {
        await tagAndCancel(input.oldPaymentIntentId, input.stripeAccountId);
        return await createReauthorizedIntent(
          { ...input, amountCents: input.newAmountCents },
          { revisedFrom: input.oldPaymentIntentId },
        );
      } catch (err) {
        throw new StripeOrderError(
          ERROR_CODES.REAUTH_FAILED,
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async refundPaymentIntent(input: RefundInput): Promise<RefundResult> {
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
          ...(input.reverseTransfer !== undefined ? { reverse_transfer: input.reverseTransfer } : {}),
          ...(input.refundApplicationFee !== undefined
            ? { refund_application_fee: input.refundApplicationFee }
            : {}),
        },
        { stripeAccount: input.stripeAccountId },
      );
      return { refundId: refund.id, amountCents: refund.amount };
    },
  };

  return activities;
}
