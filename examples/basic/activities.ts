import Stripe from 'stripe';
import { makeStripeActivities } from '@temporal-stripe/core/activities';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? 'sk_test_dummy');

// In a real app, persistContext writes to your orders table. Here we log so
// you can watch the workflow loop in your worker terminal.
export const activities = makeStripeActivities(stripe, {
  async persistContext(ctx) {
    console.log('[persistContext]', {
      orderId: ctx.orderId,
      paymentIntentId: ctx.paymentIntentId,
      status: ctx.status,
      reauthorizationCount: ctx.reauthorizationCount,
    });
  },
  async onReauthorized(ctx, pi) {
    console.log('[onReauthorized]', { orderId: ctx.orderId, newPi: pi.id });
  },
  async onCaptured(ctx, charge) {
    console.log('[onCaptured]', { orderId: ctx.orderId, charge: charge.id, amount: charge.amountCents });
  },
  async onCanceled(ctx, reason) {
    console.log('[onCanceled]', { orderId: ctx.orderId, reason });
  },
  async onFailure(ctx, err) {
    console.error('[onFailure]', { orderId: ctx.orderId, err });
  },
});
