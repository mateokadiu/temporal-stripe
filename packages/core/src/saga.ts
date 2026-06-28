import { log } from '@temporalio/workflow';

/**
 * Tiny saga primitive — a list of compensation closures that get unwound in
 * reverse order if a forward step throws. Designed to live entirely inside a
 * Temporal workflow: every closure executes deterministically and any I/O is
 * delegated to activities the caller already has proxied.
 *
 * Use it when a multi-step flow has irreversible intermediate Stripe calls
 * (e.g. reauth = cancel-old-PI + create-new-PI): if the second step fails,
 * the saga lets you reverse the first instead of leaving an orphaned cancel.
 */
export interface SagaStep<T> {
  /** Human-readable name for logging. */
  name: string;
  /** The forward action — typically an activity proxy call. */
  forward: () => Promise<T>;
  /**
   * The compensating action. Called only if the forward step succeeded and a
   * later step in the saga failed. Receives the forward's resolved value so
   * compensations can reference identifiers Stripe just minted.
   */
  compensate?: (forwardResult: T) => Promise<void>;
}

/** `@temporalio/workflow`'s log throws when called outside a workflow context;
 *  swallow that so the primitive is unit-testable. */
function safeLog(level: 'info' | 'error', message: string, meta?: Record<string, unknown>): void {
  try {
    log[level](message, meta);
  } catch {
    // outside workflow context — fine to silently skip
  }
}

/**
 * Run a single saga step. Records the compensation onto the supplied registry
 * (in order) so a later failure can unwind by calling registry.compensate().
 *
 * Throws if the forward step throws — caller is responsible for catching and
 * invoking `registry.compensate()` to undo partial progress.
 */
export async function runSagaStep<T>(registry: SagaRegistry, step: SagaStep<T>): Promise<T> {
  safeLog('info', 'saga step starting', { name: step.name });
  const result = await step.forward();
  if (step.compensate) {
    registry.record(step.name, () => step.compensate!(result));
  }
  return result;
}

interface RecordedCompensation {
  name: string;
  run: () => Promise<void>;
}

/**
 * Append-only registry of compensation closures, unwound in LIFO order when
 * `compensate()` is invoked. Errors from individual compensations are logged
 * but never thrown — best-effort cleanup is the saga contract; the original
 * forward-step failure is what the caller should surface.
 */
export class SagaRegistry {
  private readonly steps: RecordedCompensation[] = [];

  record(name: string, run: () => Promise<void>): void {
    this.steps.push({ name, run });
  }

  /** True if at least one compensation has been recorded. */
  hasProgress(): boolean {
    return this.steps.length > 0;
  }

  /** Names of recorded compensations, in execution order. Useful for state introspection. */
  recordedNames(): string[] {
    return this.steps.map((s) => s.name);
  }

  /**
   * Run compensations in reverse order. Individual failures are swallowed and
   * logged — the goal is best-effort cleanup, not transactional rollback.
   * Returns the names of compensations that threw, so the caller can surface
   * a partial-rollback failure if they care.
   */
  async compensate(): Promise<string[]> {
    const failures: string[] = [];
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i]!;
      try {
        safeLog('info', 'saga compensating', { name: step.name });
        await step.run();
      } catch (err) {
        safeLog('error', 'saga compensation failed', {
          name: step.name,
          message: err instanceof Error ? err.message : String(err),
        });
        failures.push(step.name);
      }
    }
    this.steps.length = 0;
    return failures;
  }
}
