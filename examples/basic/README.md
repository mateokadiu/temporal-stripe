# example-basic

End-to-end demo: start a `stripeOrderWorkflow`, watch the worker handle it, and exercise signals.

## Run

In **terminal 1** — Temporal server + UI (Docker Compose):

```bash
docker compose up -d
# UI at http://localhost:8080
```

Or use the bundled dev server (no Docker needed):

```bash
temporal server start-dev  # from the temporalio CLI
```

In **terminal 2** — the worker:

```bash
pnpm worker
# worker listening on task queue: stripe-orders
```

In **terminal 3** — start a workflow:

```bash
pnpm client
# started workflow stripe-order:demo-XXXXXX
```

You should see `[persistContext]` lines in the worker terminal as the workflow boots.

## Send signals

The client logs the exact CLI commands. Examples:

```bash
# Capture
temporal workflow signal --workflow-id=stripe-order:demo-XXXXXX --name=capture --input='{}'

# Force a reauthorization now (skip the timer)
temporal workflow signal --workflow-id=stripe-order:demo-XXXXXX --name=reauthorize --input=''

# Cancel
temporal workflow signal --workflow-id=stripe-order:demo-XXXXXX --name=cancel --input='{"reason":"customer"}'
```

## Real Stripe?

This example uses dummy IDs (`pi_test_demo`, etc.) so the workflow loop runs without making real Stripe API calls. To wire real Stripe:

1. `export STRIPE_SECRET_KEY=sk_test_…`
2. Create a real `PaymentIntent` in your app with `capture_method='manual'`, `setup_future_usage='off_session'`, `confirm=true`.
3. Pass its `id` as `paymentIntentId`, the saved `payment_method` as `paymentMethodId`, the Connect account as `stripeAccountId`, etc.
