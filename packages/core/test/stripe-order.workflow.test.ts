import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripeOrderWorkflow } from '../src/workflows/stripe-order.workflow.js';
import {
  captureSignal,
  cancelSignal,
  multicaptureSignal,
  reauthorizeSignal,
  reviseSignal,
  stateQuery,
} from '../src/workflows/signals.js';
import type { StripeOrderArgs, WorkflowState } from '../src/state.js';
import { REAUTH_WINDOW_MS } from '../src/constants.js';
import type { StripeOrderActivities } from '../src/activities/interface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(__dirname, '../src/workflows/index.ts');

interface ActivityCallLog {
  reauthorize: number;
  capture: number;
  cancel: number;
  revise: number;
  refund: number;
  persist: number;
  onCaptured: number;
  onCanceled: number;
  onReauthorized: number;
  onFailure: number;
}

function makeStubActivities(opts: {
  reauthSucceeds?: boolean;
  newPiPrefix?: string;
  capturedAmountCents?: number;
} = {}): { activities: StripeOrderActivities; log: ActivityCallLog; lastPersisted: { value: WorkflowState | null } } {
  const log: ActivityCallLog = {
    reauthorize: 0,
    capture: 0,
    cancel: 0,
    revise: 0,
    refund: 0,
    persist: 0,
    onCaptured: 0,
    onCanceled: 0,
    onReauthorized: 0,
    onFailure: 0,
  };
  const lastPersisted: { value: WorkflowState | null } = { value: null };
  const reauthSucceeds = opts.reauthSucceeds ?? true;

  const activities: StripeOrderActivities = {
    async reauthorizePayment(_input) {
      log.reauthorize += 1;
      if (!reauthSucceeds) throw new Error('stripe transient failure');
      return {
        newPaymentIntentId: `${opts.newPiPrefix ?? 'pi_reauth'}_${log.reauthorize}`,
        authCreatedAt: Date.now(),
        captureBefore: null,
        cardBrand: 'visa',
      };
    },
    async capturePaymentIntent(input) {
      log.capture += 1;
      const amount =
        opts.capturedAmountCents ?? input.amountToCaptureCents ?? 1999;
      return { chargeId: `ch_test_${log.capture}`, amountCapturedCents: amount };
    },
    async cancelPaymentIntent(_input) {
      log.cancel += 1;
    },
    async revisePaymentIntent(input) {
      log.revise += 1;
      return {
        newPaymentIntentId: `pi_revised_${log.revise}`,
        authCreatedAt: Date.now(),
        captureBefore: null,
        cardBrand: 'visa',
      };
    },
    async refundPaymentIntent(_input) {
      log.refund += 1;
      return { refundId: 'rf_test', amountCents: 0 };
    },
    async persistContext(ctx) {
      log.persist += 1;
      lastPersisted.value = ctx;
    },
    async onCaptured() {
      log.onCaptured += 1;
    },
    async onCanceled() {
      log.onCanceled += 1;
    },
    async onReauthorized() {
      log.onReauthorized += 1;
    },
    async onFailure() {
      log.onFailure += 1;
    },
  };
  return { activities, log, lastPersisted };
}

function startArgs(overrides: Partial<StripeOrderArgs> = {}): StripeOrderArgs {
  return {
    orderId: 'order_test',
    paymentIntentId: 'pi_initial',
    paymentMethodId: 'pm_test',
    stripeAccountId: 'acct_test',
    customerId: 'cus_test',
    initialAmountCents: 1999,
    currency: 'usd',
    initialCardBrand: 'visa',
    authCreatedAt: Date.now(),
    captureBefore: null,
    ...overrides,
  };
}

describe('stripeOrderWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it('captures cleanly when the signal arrives before the reauth timer', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-capture-first-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      await handle.signal(captureSignal, {});
      return await handle.result();
    });

    expect(result.status).toBe('captured');
    expect(log.capture).toBe(1);
    expect(log.reauthorize).toBe(0);
    expect(log.onCaptured).toBe(1);
  });

  it('fires reauthorize at the Visa 4-day mark when no signal arrives', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-reauth-timer-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      // Skip time past the Visa window; one reauth should fire, then we
      // signal capture so the workflow can complete.
      await env.sleep(REAUTH_WINDOW_MS.visa + 60_000);
      await handle.signal(captureSignal, {});
      return await handle.result();
    });

    expect(log.reauthorize).toBeGreaterThanOrEqual(1);
    expect(log.onReauthorized).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('captured');
    expect(result.reauthorizationCount).toBeGreaterThanOrEqual(1);
  });

  it('admin reauthorize signal fires immediately, bypassing the timer', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-admin-reauth-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      await handle.signal(reauthorizeSignal);
      // After admin reauth, capture so the workflow can finalize.
      await handle.signal(captureSignal, {});
      return await handle.result();
    });

    expect(log.reauthorize).toBe(1);
    expect(log.capture).toBe(1);
    expect(result.status).toBe('captured');
    expect(result.reauthorizationCount).toBe(1);
  });

  it('cancel signal terminates the workflow and fires onCanceled', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-cancel-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      await handle.signal(cancelSignal, { reason: 'customer' });
      return await handle.result();
    });

    expect(result.status).toBe('canceled');
    expect(log.cancel).toBe(1);
    expect(log.onCanceled).toBe(1);
  });

  it('revise with lower amount re-authorizes at the new amount and continues', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-revise-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 5000 })],
      });
      await handle.signal(reviseSignal, { newAmountCents: 3000, reason: 'item removed' });
      await handle.signal(captureSignal, {});
      return await handle.result();
    });

    expect(log.revise).toBe(1);
    expect(log.capture).toBe(1);
    expect(result.status).toBe('captured');
    expect(result.amountCents).toBe(3000);
  });

  it('revise with higher amount is rejected and the workflow fails', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-revise-up-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 1000 })],
      });
      await handle.signal(reviseSignal, { newAmountCents: 9999 });
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.revise).toBe(0);
    expect(log.onFailure).toBe(1);
  });

  it('reauth activity failure transitions to status=failed and fires onFailure', async () => {
    const { activities, log } = makeStubActivities({ reauthSucceeds: false });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-reauth-fail-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      await handle.signal(reauthorizeSignal);
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.onFailure).toBe(1);
  });

  it('multicapture signal accumulates capturedAmountCents and isFinal completes the workflow', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-multicap-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 5000 })],
      });
      await handle.signal(multicaptureSignal, { amountCents: 2000 });
      await handle.signal(multicaptureSignal, { amountCents: 3000, isFinal: true });
      return await handle.result();
    });

    expect(result.status).toBe('captured');
    expect(result.capturedAmountCents).toBe(5000);
    expect(result.captures).toHaveLength(2);
    expect(result.captures[1]?.isFinal).toBe(true);
  });

  it('multicapture intermediate slice keeps status=authorized and loops for more', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-multicap-mid-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 10_000 })],
      });
      await handle.signal(multicaptureSignal, { amountCents: 4000 });
      // Allow the workflow to drain the first slice so a query reflects it.
      let snap = await handle.query(stateQuery);
      for (let i = 0; snap.capturedAmountCents === 0 && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        snap = await handle.query(stateQuery);
      }
      expect(snap.capturedAmountCents).toBe(4000);
      expect(snap.status).toBe('authorized');
      expect(snap.captures).toHaveLength(1);
      expect(snap.captures[0]?.isFinal).toBe(false);
      // Send the final slice
      await handle.signal(multicaptureSignal, { amountCents: 6000, isFinal: true });
      return await handle.result();
    });

    expect(result.status).toBe('captured');
    expect(result.capturedAmountCents).toBe(10_000);
    expect(log.onCaptured).toBe(1);
  });

  it('multicapture activity failure surfaces onFailure and halts the workflow', async () => {
    const log: ActivityCallLog = {
      reauthorize: 0,
      capture: 0,
      cancel: 0,
      revise: 0,
      refund: 0,
      persist: 0,
      onCaptured: 0,
      onCanceled: 0,
      onReauthorized: 0,
      onFailure: 0,
    };
    const activities: StripeOrderActivities = {
      async reauthorizePayment() {
        log.reauthorize += 1;
        return {
          newPaymentIntentId: 'pi_x',
          authCreatedAt: Date.now(),
          captureBefore: null,
          cardBrand: 'visa',
        };
      },
      async capturePaymentIntent() {
        log.capture += 1;
        throw new Error('stripe capture failed');
      },
      async cancelPaymentIntent() {
        log.cancel += 1;
      },
      async revisePaymentIntent() {
        log.revise += 1;
        return {
          newPaymentIntentId: 'pi_x',
          authCreatedAt: Date.now(),
          captureBefore: null,
          cardBrand: 'visa',
        };
      },
      async refundPaymentIntent() {
        log.refund += 1;
        return { refundId: 'rf_x', amountCents: 0 };
      },
      async persistContext() {
        log.persist += 1;
      },
      async onCaptured() {
        log.onCaptured += 1;
      },
      async onCanceled() {
        log.onCanceled += 1;
      },
      async onReauthorized() {
        log.onReauthorized += 1;
      },
      async onFailure() {
        log.onFailure += 1;
      },
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-multicap-fail-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 5000 })],
      });
      await handle.signal(multicaptureSignal, { amountCents: 2000, isFinal: true });
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.onFailure).toBe(1);
  });

  it('multicapture rejects over-capture and lands in failed', async () => {
    const { activities, log } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-multicap-over-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs({ initialAmountCents: 1000 })],
      });
      await handle.signal(multicaptureSignal, { amountCents: 9999, isFinal: true });
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.onFailure).toBe(1);
  });

  it('state query returns the current workflow snapshot', async () => {
    const { activities } = makeStubActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-tq',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeOrderWorkflow, {
        taskQueue: 'test-tq',
        workflowId: `wf-state-q-${Math.floor(Math.random() * 1e9)}`,
        args: [startArgs()],
      });
      const snap = await handle.query(stateQuery);
      expect(snap.orderId).toBe('order_test');
      expect(snap.status).toBe('authorized');
      await handle.signal(cancelSignal, { reason: 'customer' });
      await handle.result();
    });
  });
});
