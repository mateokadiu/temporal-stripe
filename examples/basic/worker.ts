import { Worker, NativeConnection } from '@temporalio/worker';
import { createRequire } from 'node:module';
import { activities } from './activities.js';

const require = createRequire(import.meta.url);

async function main() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: 'stripe-orders',
    workflowsPath: require.resolve('@temporal-stripe/core/workflows'),
    activities,
  });

  console.log('worker listening on task queue: stripe-orders');
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
