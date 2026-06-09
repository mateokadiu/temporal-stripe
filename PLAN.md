# `@temporal-stripe` — Implementation Plan

> Temporal workflows for the Stripe Connect lifecycle that almost everyone hand-rolls and gets wrong: **reauthorization before auth expiry**, multi-capture, partial refunds, order revisions, and the webhook gymnastics that come with them. Public OSS, MIT.

**Status:** Draft — pending decisions in §11 before Phase 0 starts.

---

## 1. Goals & non-goals

### Goals
- A drop-in `runStripeOrderWorkflow()` Temporal workflow that owns the full lifecycle of a `capture_method: 'manual'` PaymentIntent from creation through capture (or cancellation).
- **Automatic reauthorization** before the auth expires: Visa at 5 days, all other brands at 7 days, with Stripe's `capture_before` (extended auth) honored when present.
- Type-safe activities for capture, full + partial refund, **order revision** (decrease amount → reauth at new amount), multicapture / incremental authorization.
- A **webhook filter** companion package so the `payment_intent.canceled` events generated *by our own reauth* don't trigger consumers' "order canceled" handlers.
- BYO storage — consumers provide update functions; the SDK never assumes a DB schema.
- BYO Stripe — `stripe` is a peer dep.
- Idiomatic Temporal patterns: signals for admin overrides, queries for state introspection, time-skipping tests in CI.
- **Public, OSS, MIT.** Lives on GitHub from day one. npm under `@temporal-stripe/*`.

### Non-goals (for v1)
- No payment-method tokenization (Stripe handles that).
- No fraud rules engine — consumers attach their own `runInitialFraudCheck` activity.
- No subscription/recurring-charge support (those don't use manual capture the same way).
- No UI components — this is a workflow library.
- No support for `capture_method: 'automatic'` orders — they don't need reauth.
- No multi-currency conversion logic — pass the right currency in.
- No alternative payment processors — Stripe Connect only.

---

## 2. The problem

When you take payment with `capture_method: 'manual'` (auth-only, defer settle), Stripe's PaymentIntent **expires** if you don't capture in time:

| Brand | Default expiry |
|---|---|
| Visa | 5 days |
| Mastercard, Amex, others | 7 days |
| With `request_extended_authorization=true` and granted by issuer | up to 30 days; honoured via `capture_before` field |

For most marketplaces this is fine — they capture within hours. For **anything that ships physical goods** (e-commerce with retailer fulfillment), **anything with a review hold** (fraud / compliance), or **anything multi-leg** (BOPIS, scheduled delivery), captures routinely fall outside the window. When auth expires, the money is lost — you have to either capture early (and risk a refund later) or **reauthorize**: cancel the old PI and create a new one on the saved payment method, keeping the customer's flow uninterrupted.

The reauth flow itself has half a dozen sharp edges:
- The original PI must have been created with `setup_future_usage: 'off_session'` for the payment method to be reusable.
- Cancelling the old PI fires a `payment_intent.canceled` webhook — your downstream "order canceled" handler will fire on your own reauth unless you tag and filter it.
- The new PI's expiry timer must be recomputed from the new charge's `capture_before` and the card brand (which can change if the payment method is updated).
- Revisions (decrease order total) re-amount the PI — same reauth flow, different trigger.
- Manual overrides (admin says "reauth now") must coexist with the timer.

Everyone who ships this builds the same code. This package is that code, productized.

---

## 3. Architecture

```
   ┌────────────────────────────────────────────────────────────────────────┐
   │ Consumer app                                                           │
   │                                                                        │
   │  ┌────────────────────────┐   start    ┌─────────────────────────────┐ │
   │  │ Order flow              │──────────▶│ Temporal client             │ │
   │  │  - on order_placed:     │  + signals │  startWorkflow(            │ │
   │  │     start workflow      │           │    'stripeOrderWorkflow',  │ │
   │  │  - on capture decision: │           │    args...)                │ │
   │  │     signal(workflow,    │           └─────────────┬───────────────┘ │
   │  │       'capture')        │                         │                 │
   │  │  - on cancel decision:  │                         ▼                 │
   │  │     signal(workflow,    │              ┌──────────────────────┐     │
   │  │       'cancel')         │              │ Temporal Server      │     │
   │  └────────────────────────┘              │ (or self-hosted)     │     │
   │                                          └──────────┬───────────┘     │
   └─────────────────────────────────────────────────────┼─────────────────┘
                                                         │
                                          ┌──────────────▼─────────────┐
                                          │ Worker                     │
                                          │                            │
                                          │  Workflow: stripeOrderWorkflow │
                                          │   - getReauthTimerMs(ctx)  │
                                          │   - race signal vs timer   │
                                          │   - dispatch to activities │
                                          │                            │
                                          │  Activities:               │
                                          │   - createPaymentIntent    │
                                          │   - reauthorizePayment     │
                                          │   - capturePaymentIntent   │
                                          │   - refundPaymentIntent    │
                                          │   - revisePaymentIntent    │
                                          │   - tagCancelOld           │
                                          │   - persistContext         │
                                          └──────────────┬─────────────┘
                                                         │
                                          ┌──────────────▼──────────────┐
                                          │ Stripe API                  │
                                          │ (PaymentIntents, Charges,   │
                                          │  PaymentMethods, Refunds)   │
                                          └─────────────────────────────┘
```

**The workflow loop** (simplified):
```ts
while (true) {
  const timerMs = getReauthTimerMs(ctx);
  const winner = await Promise.race([
    sleep(timerMs).then(() => 'timer'),
    captureSignal.received().then(() => 'capture'),
    cancelSignal.received().then(() => 'cancel'),
    reauthSignal.received().then(() => 'reauth-admin'),
    reviseSignal.received().then(() => 'revise'),
  ]);
  switch (winner) {
    case 'timer':
    case 'reauth-admin':
      ctx = await reauthorize(ctx); continue; // loop with fresh timer
    case 'revise':
      ctx = await revise(ctx); continue;       // also re-amounts, then loops
    case 'capture':
      ctx = await capture(ctx); return ctx;
    case 'cancel':
      ctx = await cancel(ctx); return ctx;
  }
}
```

State is held entirely in workflow-local memory (`ctx`) + persisted via the consumer-provided `persistContext` activity. No DB assumption baked in.

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.6+, ESM | Type-safe Stripe API surface; Temporal SDK is TS-first |
| Workflows | `@temporalio/workflow` 1.11+ | Deterministic execution, native signals/queries/timers |
| Worker / Client | `@temporalio/worker`, `@temporalio/client` | Standard Temporal patterns |
| Stripe SDK | `stripe` 19+ | Peer dep — consumer pins their version |
| Validation | Zod 3 | Runtime guards on inputs that cross workflow boundary |
| Tests | Vitest 2 + `@temporalio/testing` | Time-skipping for reauth tests (5-day timer in <1s) |
| Lint | ESLint 9 + `eslint-plugin-temporal` | Catches accidental non-determinism in workflow code |
| Build | tsup | Single-binary ESM + CJS dual emit |
| Monorepo | pnpm workspaces + Turborepo | Multiple packages, shared configs |
| Versioning | semantic-release | Conventional commits → automated changelog + npm publish |
| CI | GitHub Actions | Test, build, release on tag |
| Docs | Markdown + Mintlify-flavor structure (single-file initially) | Easy migration to Mintlify later if traction warrants |

---

## 5. Public API

### `@temporal-stripe/core`

```ts
// Workflow entry point (run inside a worker)
import { stripeOrderWorkflow } from '@temporal-stripe/core';
import type { StripeOrderArgs } from '@temporal-stripe/core';

// Activity contract (implement on the worker side)
import type { StripeOrderActivities } from '@temporal-stripe/core';

// Signals you send from your app
import {
  captureSignal,
  cancelSignal,
  reauthorizeSignal,
  reviseSignal,
} from '@temporal-stripe/core';

// Query handlers — read current state without signaling
import { stateQuery } from '@temporal-stripe/core';

// Activity implementations — opt in to the default Stripe-backed ones,
// or roll your own if you need to wrap them.
import { makeStripeActivities } from '@temporal-stripe/core/activities';
```

#### `StripeOrderArgs`
```ts
interface StripeOrderArgs {
  orderId: string;
  paymentIntentId: string;
  paymentMethodId: string;
  stripeAccountId: string;        // Connect account
  customerId: string;
  initialAmountCents: number;
  currency: string;               // 'usd', 'eur', etc.
  initialCardBrand: string;       // from charge.payment_method_details.card.brand
  authCreatedAt: number;          // epoch ms — when the PI was confirmed
  captureBefore: number | null;   // epoch ms — Stripe's hint when present
  reauthorizationCount?: number;  // default 0
  metadata?: Record<string, string>;
}
```

#### `StripeOrderActivities` (consumer provides implementations)
```ts
interface StripeOrderActivities {
  reauthorizePayment(input: ReauthorizeInput): Promise<ReauthorizeResult>;
  capturePaymentIntent(input: CaptureInput): Promise<CaptureResult>;
  refundPaymentIntent(input: RefundInput): Promise<RefundResult>;
  revisePaymentIntent(input: ReviseInput): Promise<ReviseResult>;
  persistContext(ctx: WorkflowState): Promise<void>;
  onCanceled?(ctx: WorkflowState, reason: CancelReason): Promise<void>;
  onCaptured?(ctx: WorkflowState, charge: { id: string; amountCents: number }): Promise<void>;
  onReauthorized?(ctx: WorkflowState, newPi: { id: string; captureBefore: number | null }): Promise<void>;
  onFailure?(ctx: WorkflowState, err: { name: string; message: string }): Promise<void>;
}
```

#### Helper: `makeStripeActivities(stripe, opts)`
Returns a ready-to-go implementation of `StripeOrderActivities` against the official `stripe` SDK. Opinionated defaults; override anything via `opts`.

### `@temporal-stripe/webhook`

```ts
import {
  isReauthorizationCancel,
  filterReauthorizationCancels,
  REAUTHORIZATION_METADATA_KEY,
} from '@temporal-stripe/webhook';

// Use in your Stripe webhook handler:
if (event.type === 'payment_intent.canceled') {
  if (isReauthorizationCancel(event)) return;  // skip — our own reauth
  // ... your normal cancel logic
}
```

The metadata key (`canceledBy=reauthorization-workflow`) is the contract between core and webhook packages; documented + exported as a constant.

---

## 6. Project structure

```
temporal-stripe/
├── PLAN.md
├── README.md
├── LICENSE                           # MIT
├── package.json                      # workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── .changeset/                       # changesets-style versioning OR
├── release.config.js                 # semantic-release config (one of)
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── packages/
│   ├── core/                         # @temporal-stripe/core
│   │   ├── src/
│   │   │   ├── workflows/
│   │   │   │   ├── stripe-order.workflow.ts
│   │   │   │   ├── reauth-timer.ts          # pure fn, easy to unit test
│   │   │   │   └── signals.ts
│   │   │   ├── activities/
│   │   │   │   ├── interface.ts             # public contract types
│   │   │   │   ├── make-stripe-activities.ts
│   │   │   │   ├── reauthorize.ts
│   │   │   │   ├── capture.ts
│   │   │   │   ├── refund.ts
│   │   │   │   ├── revise.ts
│   │   │   │   └── tag-cancel-old.ts
│   │   │   ├── state.ts                     # WorkflowState shape
│   │   │   ├── errors.ts
│   │   │   ├── constants.ts                 # REAUTHORIZATION_METADATA_KEY etc.
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── reauth-timer.test.ts         # pure unit tests
│   │   │   ├── stripe-order.workflow.test.ts # time-skipping integration
│   │   │   └── mocks/
│   │   │       └── stripe.ts                 # in-memory stripe stub
│   │   ├── tsup.config.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── webhook/                      # @temporal-stripe/webhook
│       ├── src/
│       │   ├── is-reauthorization-cancel.ts
│       │   ├── filter-reauthorization-cancels.ts
│       │   └── index.ts
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
└── examples/
    └── basic/
        ├── worker.ts                  # bare worker setup
        ├── client.ts                  # bare client setup
        ├── activities.ts              # opinionated activities
        ├── docker-compose.yml         # Temporal dev server
        ├── package.json
        └── README.md
```

---

## 7. Key flows

### 7.1 Reauth lifecycle

```
T+0          PI confirmed with capture_method=manual, setup_future_usage=off_session
             ↓
             Workflow starts, computes reauth timer:
              - if captureBefore set → captureBefore - 1 day
              - else if cardBrand == 'visa' → authCreatedAt + 4 days
              - else                       → authCreatedAt + 6 days
              - clamp to ≥ 1 hour from now
             ↓
T+4d (Visa)  Timer fires (in tests: skipped to <100ms with @temporalio/testing)
             ↓
             tagCancelOld activity:
              - PaymentIntents.update(oldPi, { metadata: { canceledBy: 'reauthorization-workflow' } })
              - PaymentIntents.cancel(oldPi, { cancellation_reason: 'abandoned' })
             ↓
             reauthorizePayment activity:
              - PaymentIntents.create({
                  amount, currency, customer, payment_method,
                  capture_method: 'manual',
                  off_session: true,
                  confirm: true,
                  on_behalf_of: connectAccount,
                  transfer_data: { destination: connectAccount },
                  metadata: { ...userMetadata, reauthOf: oldPiId }
                })
              - Extract newPi.id, capture_before from latest charge, card.brand from PM
             ↓
             persistContext activity:
              - { paymentIntentId: newPi.id, authCreatedAt: now, captureBefore, cardBrand,
                  reauthorizationCount: ctx.reauthorizationCount + 1 }
             ↓
             onReauthorized hook (consumer's listener — webhook update, audit log, etc.)
             ↓
             Loop with fresh timer
```

### 7.2 Capture
- Triggered by `captureSignal` from consumer.
- `PaymentIntents.capture(piId, { amount_to_capture? })` — supports full or partial.
- On success: `onCaptured` hook + workflow returns (terminal state).

### 7.3 Refund
- Triggered post-capture via `refundSignal` (separate workflow? or activity? — see decision §11.4).
- `Refunds.create({ payment_intent, amount? })` — full or partial.
- Connect: `refund_application_fee` + `reverse_transfer` honored per opts.

### 7.4 Revision (decrease total)
- Triggered by `reviseSignal({ newAmountCents })`.
- Guard: `newAmountCents` MUST be `<=` current authorized amount.
- Implementation: tag-cancel old PI + new PI at `newAmountCents`. Same flow as reauth, just with a different amount.
- After revision the workflow continues with a fresh timer at the new amount.

### 7.5 Webhook filter (the gotcha)

Our reauth flow generates a `payment_intent.canceled` webhook — Stripe doesn't care that we initiated it. Without filtering, the consumer's order-cancellation logic fires.

```ts
// Stripe webhook handler in consumer app
import { isReauthorizationCancel } from '@temporal-stripe/webhook';

const event = stripe.webhooks.constructEvent(rawBody, sig, secret);
if (event.type === 'payment_intent.canceled') {
  if (isReauthorizationCancel(event)) {
    return res.status(200).end(); // our own reauth, ignore
  }
  // ... real cancellation handling
}
```

`isReauthorizationCancel(event)` reads `event.data.object.metadata.canceledBy === 'reauthorization-workflow'`. The metadata key is exported as `REAUTHORIZATION_METADATA_KEY` so consumers don't depend on the string.

Also filter cancellation_reason in (`'automatic'`, `'expired'`, `'failed_invoice'`, `'void_invoice'`) — Stripe-initiated cancels that should never reject the order.

---

## 8. Example: end-to-end wiring

```ts
// activities.ts
import Stripe from 'stripe';
import { makeStripeActivities } from '@temporal-stripe/core/activities';
import { db } from './db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const activities = makeStripeActivities(stripe, {
  async persistContext(ctx) {
    await db.orders.update({
      where: { id: ctx.orderId },
      data: {
        paymentIntentId: ctx.paymentIntentId,
        authCreatedAt: ctx.authCreatedAt,
        captureBefore: ctx.captureBefore,
        cardBrand: ctx.cardBrand,
        reauthorizationCount: ctx.reauthorizationCount,
      },
    });
  },
  async onCaptured(ctx, charge) {
    await db.orders.update({
      where: { id: ctx.orderId },
      data: { capturedAt: new Date(), chargeId: charge.id },
    });
  },
  async onReauthorized(ctx, pi) {
    // Update your own analytics, alerts, etc.
  },
});

// worker.ts
import { Worker } from '@temporalio/worker';
import { activities } from './activities.js';

const worker = await Worker.create({
  workflowsPath: require.resolve('@temporal-stripe/core/workflows'),
  activities,
  taskQueue: 'stripe-orders',
});
await worker.run();

// client.ts — start a workflow when an order is placed
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
    initialCardBrand: pi.charges?.data[0]?.payment_method_details?.card?.brand ?? 'unknown',
    authCreatedAt: Date.now(),
    captureBefore: pi.charges?.data[0]?.payment_method_details?.card?.capture_before
      ? pi.charges.data[0].payment_method_details.card.capture_before * 1000
      : null,
  }],
});

// later: capture
await client.workflow.getHandle(`stripe-order:${orderId}`).signal('capture');
```

---

## 9. Test strategy

### 9.1 Unit
- `reauth-timer.ts` — pure function. Test all branches: Visa with no `captureBefore`, Visa with `captureBefore`, Mastercard, Amex, unknown brand, edge cases (capture already past, capture in 30s, etc.).
- Each activity helper — unit test against a stub Stripe client.

### 9.2 Workflow (time-skipping)
- `@temporalio/testing` provides a local Temporal that lets `sleep(N days)` skip in <100ms.
- Scenarios:
  1. Visa happy path → timer fires at T+4d → reauth runs → workflow loops → capture signal → done.
  2. Capture before timer → workflow returns without reauth.
  3. Cancel signal anywhere in the loop → workflow terminates, `onCanceled` fires.
  4. `revise` signal → re-amounts, captures at new amount.
  5. Reauth admin signal → fires reauth immediately (no waiting for timer).
  6. Stripe API error in reauth → workflow blocks, `onFailure` fires, NOT a self-cancel.

### 9.3 Webhook
- `is-reauthorization-cancel` — table-driven test over all `cancellation_reason` values + metadata combinations.

### 9.4 CI
- Lint + typecheck + unit + workflow tests in GitHub Actions. Matrix on Node 20/22.
- No live Stripe calls in CI. The opinionated `makeStripeActivities` helper is tested in `examples/basic/` with the user's own keys when they run it locally.

---

## 10. Build phases

| Phase | Scope | Effort |
|---|---|---|
| **0** | Repo scaffold: workspaces, TS, tsup, Vitest, Temporal test, ESLint, CI, MIT, README skeleton | 1 evening |
| **1** | Reauth workflow + timer + tag-cancel + reauthorize activity + time-skipping tests for happy path + manual admin signal | 2 evenings |
| **2** | Capture + refund + revise activities + signals + workflow integration + tests | 2 evenings |
| **3** | `@temporal-stripe/webhook` filter package + tests | 1 evening |
| **4** | `examples/basic/` end-to-end (Temporal dev server in compose, fake Stripe in tests, real Stripe optional) + README quickstart | 2 evenings |
| **5** | semantic-release + npm publish + tag release + GitHub release page | 1 evening |
| **Optional** | Mintlify docs site, integrations guides (Next.js / NestJS / Fastify) | 2 evenings |

**Total v1:** ~9 evenings of focused work. Realistically 2-3 weeks.

---

## 11. Decisions to confirm before Phase 0

| # | Decision | Default | Alternative |
|---|---|---|---|
| 1 | npm scope | `@temporal-stripe/*` (org-scoped, clean) | `@mateokadiu/temporal-stripe-*` or unscoped `temporal-stripe` |
| 2 | Single package vs monorepo | **Monorepo** — core + webhook split is the most-asked-for shape; consumers using only the webhook helpers don't need the workflow runtime | Single package — simpler |
| 3 | Storage interface | **BYO via `StripeOrderActivities` interface** — consumers provide `persistContext` + hooks | Opinionated Prisma adapter shipped separately |
| 4 | Refund: in-workflow signal vs separate workflow | **Separate `refundWorkflow`** triggered post-capture; less coupling, easier to model long-tail (chargebacks etc.) later | Same workflow, `refundSignal` post-capture |
| 5 | Versioning | **semantic-release + conventional commits** | manual via changesets |
| 6 | Repo location | `~/Desktop/development/personal/temporal-stripe/` | other |
| 7 | GitHub repo name | `temporal-stripe` (matches npm scope intent) | `temporal-stripe-sdk`, `stripe-temporal-workflows`, … |
| 8 | License | MIT | Apache-2.0 |
| 9 | Initial v0.1.0 feature scope | **All of: reauth + capture + refund + revise + webhook filter** (per phases 1-3) | Reauth-only v0.1.0, others incrementally |
| 10 | Compatibility target | Temporal SDK 1.11+, Node 20 LTS, Stripe 17+ | Looser or tighter |

---

## 12. Out of scope (explicit so we don't drift)

- Subscription / recurring billing (different lifecycle entirely).
- ACH / SEPA / non-card payments (no manual-capture model, no reauth need).
- Stripe Issuing / Treasury / Identity.
- A UI component library — this is workflows, not React.
- Direct CRM / OMS integrations — those are the consumer's job.

---

## 13. References

- Stripe — manual capture: https://stripe.com/docs/payments/place-a-hold-on-a-payment-method
- Stripe — extended authorization: https://stripe.com/docs/payments/extended-authorization
- Stripe Connect — direct/destination charges: https://stripe.com/docs/connect/destination-charges
- Temporal — TypeScript workflows: https://docs.temporal.io/dev-guide/typescript/foundations
- Temporal — testing & time-skipping: https://docs.temporal.io/dev-guide/typescript/testing
- Prior art at scale (referenced internally): the `feat/payment-reauth` work across the ReserveBar vault, worker-fleet, and retailer-services repos — the pattern this library productizes.
