import { Client, Connection } from '@temporalio/client';
import { stripeOrderWorkflow } from '@temporal-stripe/core';

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  const orderId = `demo-${Math.floor(Math.random() * 1_000_000)}`;
  const handle = await client.workflow.start(stripeOrderWorkflow, {
    taskQueue: 'stripe-orders',
    workflowId: `stripe-order:${orderId}`,
    args: [
      {
        orderId,
        paymentIntentId: 'pi_test_demo',
        paymentMethodId: 'pm_test_demo',
        stripeAccountId: 'acct_test_demo',
        customerId: 'cus_test_demo',
        initialAmountCents: 2999,
        currency: 'usd',
        initialCardBrand: 'visa',
        authCreatedAt: Date.now(),
        captureBefore: null,
      },
    ],
  });

  console.log('started workflow', handle.workflowId);
  console.log('try sending signals from another terminal:');
  console.log(
    `  temporal workflow signal --workflow-id=${handle.workflowId} --name=capture --input='{}'`,
  );
  console.log(
    `  temporal workflow signal --workflow-id=${handle.workflowId} --name=cancel --input='{"reason":"customer"}'`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
