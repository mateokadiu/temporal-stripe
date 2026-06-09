# temporal-stripe

Temporal workflows for the Stripe Connect lifecycle. Solves the parts that aren't in Stripe's docs and that everyone hand-rolls:

- **Reauthorization before auth expiry** — Visa expires at 5 days, others at 7. The library races a Temporal timer against capture/cancel signals and cancels-then-recreates the PaymentIntent before time runs out.
- **Capture, refund, revision** — typed activities with sane Connect defaults.
- **Webhook filtering** — your own reauth-initiated `payment_intent.canceled` events don't fire your "order canceled" handler.

Two packages:

| Package | What it does |
|---|---|
| `@temporal-stripe/core` | Workflow + activities + signals + types |
| `@temporal-stripe/webhook` | Tiny helpers to filter out your own reauth cancels in webhook handlers |

## Quick start

```bash
pnpm add @temporal-stripe/core stripe @temporalio/worker @temporalio/client
```

Worker:

```ts
import { Worker } from '@temporalio/worker';
import Stripe from 'stripe';
import { makeStripeActivities } from '@temporal-stripe/core/activities';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const activities = makeStripeActivities(stripe, {
  async persistContext(ctx) {
    // your DB update
  },
});

const worker = await Worker.create({
  workflowsPath: require.resolve('@temporal-stripe/core/workflows'),
  activities,
  taskQueue: 'stripe-orders',
});
await worker.run();
```

Client (start a workflow when an order is placed):

```ts
import { Client } from '@temporalio/client';
import { stripeOrderWorkflow } from '@temporal-stripe/core';

const client = new Client();
await client.workflow.start(stripeOrderWorkflow, {
  taskQueue: 'stripe-orders',
  workflowId: `stripe-order:${orderId}`,
  args: [{
    orderId,
    paymentIntentId: pi.id,
    paymentMethodId: pi.payment_method as string,
    stripeAccountId: connectAcct.id,
    customerId: customer.id,
    initialAmountCents: pi.amount,
    currency: pi.currency,
    initialCardBrand: 'visa',
    authCreatedAt: Date.now(),
    captureBefore: null,
  }],
});

// Capture later — anywhere in your app:
await client.workflow.getHandle(`stripe-order:${orderId}`).signal('capture');
```

Webhook (filter reauth cancels):

```ts
import { isReauthorizationCancel } from '@temporal-stripe/webhook';

if (event.type === 'payment_intent.canceled') {
  if (isReauthorizationCancel(event)) return; // skip — our own reauth
  // ... your real cancel logic
}
```

A runnable end-to-end demo lives in `examples/basic/`.

## Why this exists

If you ship physical goods, run a fraud hold, or otherwise can't capture inside Visa's 5-day window, you've already lost auths in production or you will. The reauth pattern (tag old PI → cancel → recreate on saved payment method) is six lines of code and a dozen edge cases. This packages it.

See [`PLAN.md`](./PLAN.md) for the full architecture, activity interfaces, test strategy, and decisions log.

## Status

Early. v0.x. API may shift. See [`PLAN.md`](./PLAN.md) §10 for the phase roadmap.

## Requirements

- Node 20+
- A Temporal server (self-hosted is fine — `temporal server start-dev` works for local; production uses the OSS server in Docker / k8s, no Cloud subscription required)
- Stripe SDK 17+

## License

MIT.
