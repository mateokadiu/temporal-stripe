import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'workflows/index': 'src/workflows/index.ts',
    'activities/index': 'src/activities/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  target: 'node20',
  // Workflow code runs in Temporal's deterministic sandbox — leave imports
  // intact so the worker bundler (`bundleWorkflowCode`) sees them.
  external: ['@temporalio/workflow', '@temporalio/activity', '@temporalio/worker', 'stripe'],
});
