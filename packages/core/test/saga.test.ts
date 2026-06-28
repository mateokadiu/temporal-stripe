import { describe, expect, it, vi } from 'vitest';
import { SagaRegistry, runSagaStep } from '../src/saga.js';

describe('SagaRegistry', () => {
  it('records compensations in order and unwinds them in reverse', async () => {
    const calls: string[] = [];
    const registry = new SagaRegistry();
    registry.record('a', async () => {
      calls.push('a');
    });
    registry.record('b', async () => {
      calls.push('b');
    });
    registry.record('c', async () => {
      calls.push('c');
    });
    const failures = await registry.compensate();
    expect(calls).toEqual(['c', 'b', 'a']);
    expect(failures).toEqual([]);
  });

  it('continues compensating when a step throws and reports failures', async () => {
    const calls: string[] = [];
    const registry = new SagaRegistry();
    registry.record('a', async () => {
      calls.push('a');
    });
    registry.record('b', async () => {
      throw new Error('boom');
    });
    registry.record('c', async () => {
      calls.push('c');
    });
    const failures = await registry.compensate();
    expect(calls).toEqual(['c', 'a']);
    expect(failures).toEqual(['b']);
  });

  it('hasProgress reflects appended steps', () => {
    const registry = new SagaRegistry();
    expect(registry.hasProgress()).toBe(false);
    registry.record('x', async () => {});
    expect(registry.hasProgress()).toBe(true);
  });

  it('recordedNames returns names in registration order', () => {
    const registry = new SagaRegistry();
    registry.record('first', async () => {});
    registry.record('second', async () => {});
    expect(registry.recordedNames()).toEqual(['first', 'second']);
  });

  it('compensate empties the registry so re-calling is a no-op', async () => {
    const registry = new SagaRegistry();
    const fn = vi.fn(async () => {});
    registry.record('only', fn);
    await registry.compensate();
    await registry.compensate();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(registry.hasProgress()).toBe(false);
  });
});

describe('runSagaStep', () => {
  it('runs the forward step and records compensation on success', async () => {
    const registry = new SagaRegistry();
    const compensate = vi.fn(async (_id: string) => {});
    const result = await runSagaStep(registry, {
      name: 'create-pi',
      forward: async () => ({ id: 'pi_123' }),
      compensate: (forwardResult) => compensate(forwardResult.id),
    });
    expect(result).toEqual({ id: 'pi_123' });
    expect(registry.recordedNames()).toEqual(['create-pi']);
    expect(compensate).not.toHaveBeenCalled();
  });

  it('throws when the forward step throws and records no compensation', async () => {
    const registry = new SagaRegistry();
    const compensate = vi.fn(async () => {});
    await expect(
      runSagaStep(registry, {
        name: 'failing',
        forward: async () => {
          throw new Error('forward exploded');
        },
        compensate,
      }),
    ).rejects.toThrow('forward exploded');
    expect(registry.hasProgress()).toBe(false);
    expect(compensate).not.toHaveBeenCalled();
  });

  it('passes the forward result to compensation when it runs', async () => {
    const registry = new SagaRegistry();
    const seen: string[] = [];
    await runSagaStep(registry, {
      name: 'step',
      forward: async () => 'pi_minted',
      compensate: async (id) => {
        seen.push(id);
      },
    });
    await registry.compensate();
    expect(seen).toEqual(['pi_minted']);
  });

  it('a step with no compensate is not added to the registry', async () => {
    const registry = new SagaRegistry();
    await runSagaStep(registry, {
      name: 'no-undo',
      forward: async () => 42,
    });
    expect(registry.hasProgress()).toBe(false);
  });
});
