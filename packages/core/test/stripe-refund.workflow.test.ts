import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripeRefundWorkflow } from '../src/workflows/stripe-refund.workflow.js';
import {
  refundStateQuery,
} from '../src/workflows/refund-signals.js';
import type { StripeRefundArgs, RefundWorkflowState } from '../src/state.js';
import type { StripeRefundActivities } from '../src/activities/interface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(__dirname, '../src/workflows/index.ts');

interface RefundCallLog {
  refund: number;
  persist: number;
  onRefunded: number;
  onDisputeOpened: number;
  onDisputeClosed: number;
  onRefundFailure: number;
}

function makeStubRefundActivities(opts: { refundOk?: boolean } = {}): {
  activities: StripeRefundActivities;
  log: RefundCallLog;
  lastPersisted: { value: RefundWorkflowState | null };
} {
  const log: RefundCallLog = {
    refund: 0,
    persist: 0,
    onRefunded: 0,
    onDisputeOpened: 0,
    onDisputeClosed: 0,
    onRefundFailure: 0,
  };
  const lastPersisted: { value: RefundWorkflowState | null } = { value: null };
  const refundOk = opts.refundOk ?? true;
  const activities: StripeRefundActivities = {
    async refundPaymentIntent(input) {
      log.refund += 1;
      if (!refundOk) throw new Error('refund failure');
      return { refundId: `rf_${log.refund}`, amountCents: input.amountCents ?? 0, status: 'succeeded' };
    },
    async persistRefundContext(ctx) {
      log.persist += 1;
      lastPersisted.value = ctx;
    },
    async onRefunded() {
      log.onRefunded += 1;
    },
    async onDisputeOpened() {
      log.onDisputeOpened += 1;
    },
    async onDisputeClosed() {
      log.onDisputeClosed += 1;
    },
    async onRefundFailure() {
      log.onRefundFailure += 1;
    },
  };
  return { activities, log, lastPersisted };
}

function refundArgs(overrides: Partial<StripeRefundArgs> = {}): StripeRefundArgs {
  return {
    orderId: 'order_test',
    paymentIntentId: 'pi_captured',
    stripeAccountId: 'acct_test',
    capturedAmountCents: 5000,
    currency: 'usd',
    ...overrides,
  };
}

describe('stripeRefundWorkflow (scaffold)', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it('starts in idle status with refundedAmountCents at 0', async () => {
    const { activities } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-idle-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs()],
      });
      const snap = await handle.query(refundStateQuery);
      expect(snap.status).toBe('idle');
      expect(snap.refundedAmountCents).toBe(0);
      expect(snap.capturedAmountCents).toBe(5000);
      expect(snap.refunds).toEqual([]);
      expect(snap.disputes).toEqual([]);
      // Terminate by signaling unused dispute-closed; scaffold loops, so we
      // terminate the workflow handle directly.
      await handle.terminate();
    });
  });
});
