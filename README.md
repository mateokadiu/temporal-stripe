# temporal-stripe

Temporal workflows for the parts of the Stripe Connect lifecycle that aren't in Stripe's docs and that almost everyone hand-rolls and gets wrong.

```
npm i @temporal-stripe/core
npm i @temporal-stripe/webhook   # tiny, no Temporal dep
```

| Package | What it does |
|---|---|
| [`@temporal-stripe/core`](./packages/core) | Workflow + activities + signals for the PaymentIntent lifecycle (reauth, capture, refund, revise) |
| [`@temporal-stripe/webhook`](./packages/webhook) | Tiny helpers to filter our own reauth-initiated `payment_intent.canceled` events |

---

## The problem

Stripe expires manual-capture PaymentIntents:

| Brand | Default expiry |
|---|---|
| Visa | **5 days** |
| Mastercard, Amex, others | **7 days** |
| With `request_extended_authorization: true` and issuer-approved | up to 30 days (`capture_before` field) |

If you ship physical goods, run a fraud hold, schedule delivery, or have any process longer than a few hours between auth and capture — **the auth will expire on you in production**. The fix is "reauthorization": tag the old PI, cancel it, create a new one against the saved payment method, keep going.

That sounds like six lines of code. It's six lines of code and twelve edge cases:

- the original PI must've been created with `setup_future_usage: 'off_session'` for the payment method to be reusable;
- cancelling fires `payment_intent.canceled` — your "order canceled" handler will fire on *your own reauth* unless you tag and filter it;
- the new PI's expiry timer needs to be recomputed from the new charge's `capture_before` and card brand;
- revisions (drop the order total) re-amount the PI — same reauth flow, different trigger;
- partial captures with Connect get tangled with application fees;
- admin "reauth this now" overrides have to coexist with the timer;
- and the timer itself has to survive worker restarts.

Temporal solves the "survive restarts" part. This library solves the rest.

---

## What you get

A single `stripeOrderWorkflow` that owns one PaymentIntent end-to-end, with a small set of signals and a clean activity interface:

```
   ┌─ Temporal workflow ─────────────────────┐
   │                                         │
   │   ┌─── race ──────────────────────┐     │
   │   │  reauth timer (Visa: 4d, etc) │ →  reauthorize  → loop
   │   │  capture signal               │ →  capture      → done
   │   │  cancel signal                │ →  cancel       → done
   │   │  reauthorize signal (admin)   │ →  reauthorize  → loop
   │   │  revise signal                │ →  re-amount    → loop
   │   └───────────────────────────────┘     │
   │                                         │
   └─────────────────────────────────────────┘
                    │
            ┌───────▼────────┐
            │ your activities│ — you implement persistContext + 4 lifecycle hooks
            └────────────────┘
```

The library never assumes a DB schema. You provide `persistContext(ctx)` and the lifecycle hooks (`onReauthorized`, `onCaptured`, `onCanceled`, `onFailure`); the workflow calls them at the right moments.

### Signal reference

| Signal | Payload | What it does |
|---|---|---|
| `capture` | `{ amountToCaptureCents?, applicationFeeCents? }` | Capture (full or partial). Terminal. |
| `cancel` | `{ reason: 'customer' \| 'admin' \| 'fraud' \| 'timeout' \| 'unrecoverable_error', notes? }` | Cancel the PI. Terminal. |
| `reauthorize` | — | Force an immediate reauth, bypassing the timer. Loops. |
| `revise` | `{ newAmountCents, reason? }` | Drop the PI to a smaller amount via tag-cancel-recreate. Loops. Increases are rejected. |

If multiple signals are pending in the same workflow tick, priority is **cancel > revise > admin reauth > capture**. That way a "drop the price *then* capture" sequence sent in quick succession lands at the new amount.

### Activity contract

```ts
interface StripeOrderActivities {
  reauthorizePayment(input): Promise<{ newPaymentIntentId; authCreatedAt; captureBefore; cardBrand }>;
  capturePaymentIntent(input): Promise<{ chargeId; amountCapturedCents }>;
  cancelPaymentIntent(input): Promise<void>;
  revisePaymentIntent(input): Promise<{ newPaymentIntentId; authCreatedAt; captureBefore; cardBrand }>;
  refundPaymentIntent(input): Promise<{ refundId; amountCents }>;
  persistContext(ctx): Promise<void>;
  onCaptured(ctx, charge): Promise<void>;
  onCanceled(ctx, reason): Promise<void>;
  onReauthorized(ctx, pi): Promise<void>;
  onFailure(ctx, err): Promise<void>;
}
```

`makeStripeActivities(stripe, opts)` returns a ready-to-go implementation of every method against the official `stripe` SDK. You only need to supply `persistContext` (and any hooks you care about); everything Stripe-related is wired for you.

---

## Quick start

In one shell — Temporal dev server (no Docker required if you have the [Temporal CLI](https://docs.temporal.io/cli)):

```bash
temporal server start-dev
```

In another — wire and run the worker:

```ts
import { Worker } from '@temporalio/worker';
import Stripe from 'stripe';
import { makeStripeActivities } from '@temporal-stripe/core/activities';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const activities = makeStripeActivities(stripe, {
  async persistContext(ctx) {
    await db.orders.update({
      where: { id: ctx.orderId },
      data: {
        paymentIntentId: ctx.paymentIntentId,
        authCreatedAt: ctx.authCreatedAt,
        captureBefore: ctx.captureBefore,
        cardBrand: ctx.cardBrand,
        reauthorizationCount: ctx.reauthorizationCount,
        status: ctx.status,
      },
    });
  },
});

const worker = await Worker.create({
  workflowsPath: require.resolve('@temporal-stripe/core/workflows'),
  activities,
  taskQueue: 'stripe-orders',
});
await worker.run();
```

Start a workflow when an order is placed:

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

// later: capture
await client.workflow.getHandle(`stripe-order:${orderId}`).signal('capture', {});
```

Filter your own reauth-cancels in your Stripe webhook:

```ts
import { isReauthorizationCancel } from '@temporal-stripe/webhook';

if (event.type === 'payment_intent.canceled') {
  if (isReauthorizationCancel(event)) return; // our own reauth, skip
  // ... real cancel handling
}
```

A fully runnable demo lives in [`examples/basic`](./examples/basic).

---

## Requirements

- Node 20+
- A Temporal server: self-hosted is fine; `temporal server start-dev` for local; the OSS Temporal Server in Docker for staging/production; **Temporal Cloud not required**.
- `stripe` SDK 17+

## Status

Pre-1.0. The PaymentIntent-lifecycle surface (capture/cancel/reauth/revise) is stable in v0.x. Refund support is currently activity-level — a dedicated `stripeRefundWorkflow` for long-tail refund/chargeback handling is planned for v0.2.

See [PLAN.md](./PLAN.md) for the full architecture + phase roadmap.

## Contributing

PRs welcome. The core invariant: workflow code stays deterministic — no `Date.now()`, no `Math.random()`, no Node built-ins. Activities can do anything.

```bash
pnpm install
pnpm build       # tsup, dual ESM+CJS
pnpm typecheck
pnpm test        # 31 tests across both packages
```

## License

MIT.
