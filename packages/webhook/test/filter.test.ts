import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import {
  filterReauthorizationCancels,
  isReauthorizationCancel,
  isStripeInitiatedCancel,
  REAUTHORIZATION_METADATA_KEY,
  REAUTHORIZATION_METADATA_VALUE,
  shouldRouteToCancelHandler,
} from '../src/index.js';

function makeEvent(opts: {
  type: Stripe.Event['type'];
  metadata?: Record<string, string>;
  cancellationReason?: string;
}): Stripe.Event {
  const pi = {
    id: 'pi_test',
    metadata: opts.metadata ?? {},
    cancellation_reason: opts.cancellationReason ?? null,
  };
  return {
    type: opts.type,
    data: { object: pi as unknown as Stripe.PaymentIntent },
  } as Stripe.Event;
}

describe('isReauthorizationCancel', () => {
  it('returns true for canceled PIs tagged by our reauth flow', () => {
    const e = makeEvent({
      type: 'payment_intent.canceled',
      metadata: { [REAUTHORIZATION_METADATA_KEY]: REAUTHORIZATION_METADATA_VALUE },
    });
    expect(isReauthorizationCancel(e)).toBe(true);
  });

  it('returns false for unrelated event types', () => {
    expect(isReauthorizationCancel(makeEvent({ type: 'payment_intent.succeeded' }))).toBe(false);
  });

  it('returns false when metadata key is absent', () => {
    expect(isReauthorizationCancel(makeEvent({ type: 'payment_intent.canceled' }))).toBe(false);
  });

  it('returns false when metadata key has a different value', () => {
    expect(
      isReauthorizationCancel(
        makeEvent({
          type: 'payment_intent.canceled',
          metadata: { [REAUTHORIZATION_METADATA_KEY]: 'something-else' },
        }),
      ),
    ).toBe(false);
  });
});

describe('isStripeInitiatedCancel', () => {
  it.each(['automatic', 'expired', 'failed_invoice', 'void_invoice'])(
    'true for cancellation_reason=%s',
    (reason) => {
      expect(
        isStripeInitiatedCancel(
          makeEvent({ type: 'payment_intent.canceled', cancellationReason: reason }),
        ),
      ).toBe(true);
    },
  );

  it('false for requested_by_customer', () => {
    expect(
      isStripeInitiatedCancel(
        makeEvent({ type: 'payment_intent.canceled', cancellationReason: 'requested_by_customer' }),
      ),
    ).toBe(false);
  });
});

describe('shouldRouteToCancelHandler', () => {
  it('false for reauth-tagged cancels', () => {
    expect(
      shouldRouteToCancelHandler(
        makeEvent({
          type: 'payment_intent.canceled',
          metadata: { [REAUTHORIZATION_METADATA_KEY]: REAUTHORIZATION_METADATA_VALUE },
        }),
      ),
    ).toBe(false);
  });

  it('false for stripe-initiated cancels', () => {
    expect(
      shouldRouteToCancelHandler(
        makeEvent({ type: 'payment_intent.canceled', cancellationReason: 'expired' }),
      ),
    ).toBe(false);
  });

  it('true for genuine customer cancels', () => {
    expect(
      shouldRouteToCancelHandler(
        makeEvent({
          type: 'payment_intent.canceled',
          cancellationReason: 'requested_by_customer',
        }),
      ),
    ).toBe(true);
  });

  it('false for non-cancel event types', () => {
    expect(
      shouldRouteToCancelHandler(makeEvent({ type: 'payment_intent.succeeded' })),
    ).toBe(false);
  });
});

describe('filterReauthorizationCancels', () => {
  it('returns null for reauth-tagged cancels', () => {
    const e = makeEvent({
      type: 'payment_intent.canceled',
      metadata: { [REAUTHORIZATION_METADATA_KEY]: REAUTHORIZATION_METADATA_VALUE },
    });
    expect(filterReauthorizationCancels(e)).toBeNull();
  });

  it('returns the event for everything else', () => {
    const e = makeEvent({ type: 'payment_intent.succeeded' });
    expect(filterReauthorizationCancels(e)).toBe(e);
  });
});
