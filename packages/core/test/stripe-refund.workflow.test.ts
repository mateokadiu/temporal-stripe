import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripeRefundWorkflow } from '../src/workflows/stripe-refund.workflow.js';
import {
  disputeClosedSignal,
  disputeOpenedSignal,
  refundRequestSignal,
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
  lastInput?: {
    amountCents?: number;
    reverseTransfer?: boolean;
    refundApplicationFee?: boolean;
    reason?: string;
    metadata?: Record<string, string>;
  };
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
      log.lastInput = {
        amountCents: input.amountCents,
        reverseTransfer: input.reverseTransfer,
        refundApplicationFee: input.refundApplicationFee,
        reason: input.reason,
        metadata: input.metadata,
      };
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

  it('full refund passes reverse_transfer + refund_application_fee through to the activity', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-full-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ refundApplicationFee: true, reverseTransfer: true })],
      });
      await handle.signal(refundRequestSignal, { reason: 'requested_by_customer', notes: 'ops' });
      return await handle.result();
    });

    expect(log.refund).toBe(1);
    expect(log.onRefunded).toBe(1);
    expect(result.status).toBe('fully_refunded');
    expect(result.refundedAmountCents).toBe(5000);
    expect(log.lastInput?.reverseTransfer).toBe(true);
    expect(log.lastInput?.refundApplicationFee).toBe(true);
    expect(log.lastInput?.reason).toBe('requested_by_customer');
    expect(log.lastInput?.metadata?.refundNotes).toBe('ops');
  });

  it('partial refunds accumulate refundedAmountCents and leave status=partially_refunded', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-partial-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ capturedAmountCents: 5000 })],
      });
      await handle.signal(refundRequestSignal, { amountCents: 1000 });
      // Query once we know the first refund's been written. We can't peek
      // mid-workflow easily; just rely on subsequent signals racing fine.
      await handle.signal(refundRequestSignal, { amountCents: 1500 });
      // Final partial that completes the refund.
      await handle.signal(refundRequestSignal, { amountCents: 2500 });
      return await handle.result();
    });

    expect(log.refund).toBe(3);
    expect(result.refundedAmountCents).toBe(5000);
    expect(result.refunds).toHaveLength(3);
    expect(result.refunds.map((r) => r.amountCents)).toEqual([1000, 1500, 2500]);
    expect(result.status).toBe('fully_refunded');
  });

  it('over-refund (amountCents > remaining) lands in failed and skips the Stripe call', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-over-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ capturedAmountCents: 1000 })],
      });
      await handle.signal(refundRequestSignal, { amountCents: 9999 });
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.refund).toBe(0);
    expect(log.onRefundFailure).toBe(1);
  });

  it('disputeOpened sets status=disputed and queues the dispute log', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-dispute-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ capturedAmountCents: 5000 })],
      });
      await handle.signal(disputeOpenedSignal, {
        disputeId: 'dp_1',
        amountCents: 5000,
        reason: 'fraudulent',
      });
      // Wait for the workflow tick to process the dispute. We can't easily
      // race the condition; signal then poll the query.
      let snap = await handle.query(refundStateQuery);
      // give the worker a tick to drain the signal
      for (let i = 0; snap.status !== 'disputed' && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        snap = await handle.query(refundStateQuery);
      }
      expect(snap.status).toBe('disputed');
      expect(snap.disputes).toHaveLength(1);
      expect(snap.disputes[0]?.disputeId).toBe('dp_1');
      expect(log.onDisputeOpened).toBe(1);
      await handle.terminate();
    });
  });

  it('refund signals are blocked while a dispute is open', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-blocked-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ capturedAmountCents: 5000 })],
      });
      await handle.signal(disputeOpenedSignal, { disputeId: 'dp_x', amountCents: 5000 });
      // Wait until status flips
      let snap = await handle.query(refundStateQuery);
      for (let i = 0; snap.status !== 'disputed' && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        snap = await handle.query(refundStateQuery);
      }
      await handle.signal(refundRequestSignal, { amountCents: 1000 });
      // give the workflow a moment to process
      await new Promise((r) => setTimeout(r, 200));
      expect(log.refund).toBe(0);
      expect(log.onRefundFailure).toBeGreaterThanOrEqual(1);
      await handle.terminate();
    });
  });

  it('disputeClosed flips status to dispute_closed and records closedStatus', async () => {
    const { activities, log } = makeStubRefundActivities();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-dispute-closed-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs({ capturedAmountCents: 5000 })],
      });
      await handle.signal(disputeOpenedSignal, { disputeId: 'dp_y', amountCents: 5000 });
      await handle.signal(disputeClosedSignal, { disputeId: 'dp_y', status: 'won' });
      let snap = await handle.query(refundStateQuery);
      for (let i = 0; snap.status !== 'dispute_closed' && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        snap = await handle.query(refundStateQuery);
      }
      expect(snap.status).toBe('dispute_closed');
      // Two log entries: opened + closed
      expect(snap.disputes).toHaveLength(2);
      expect(snap.disputes[1]?.event).toBe('closed');
      expect(snap.disputes[1]?.closedStatus).toBe('won');
      expect(log.onDisputeClosed).toBe(1);
      await handle.terminate();
    });
  });

  it('refund failure surfaces onRefundFailure and lands in status=failed', async () => {
    const { activities, log } = makeStubRefundActivities({ refundOk: false });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-refund-tq',
      workflowsPath,
      activities,
    });

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(stripeRefundWorkflow, {
        taskQueue: 'test-refund-tq',
        workflowId: `wf-refund-fail-${Math.floor(Math.random() * 1e9)}`,
        args: [refundArgs()],
      });
      await handle.signal(refundRequestSignal, {});
      return await handle.result();
    });

    expect(result.status).toBe('failed');
    expect(log.onRefundFailure).toBe(1);
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
