import { describe, expect, test } from 'bun:test';
import { ModelHealthTracker } from './model-health';

describe('ModelHealthTracker', () => {
  test('immediate failures cool a model and filter it from chains', () => {
    const tracker = new ModelHealthTracker({
      enabled: true,
      failureThreshold: 2,
      cooldownMs: 60_000,
      maxCooldownMs: 60_000,
      backoffMultiplier: 2,
    });

    tracker.recordFailure('Qwen/Qwen3-Coder-Next-TEE', 'Prompt timed out after 30000ms');

    expect(tracker.isCooling('Qwen/Qwen3-Coder-Next-TEE')).toBe(true);
    expect(
      tracker.filterChain([
        'Qwen/Qwen3-Coder-Next-TEE',
        'openai/gpt-5.4',
      ]),
    ).toEqual(['openai/gpt-5.4']);
  });

  test('success clears cooldown state', () => {
    const tracker = new ModelHealthTracker({
      enabled: true,
      failureThreshold: 2,
      cooldownMs: 60_000,
      maxCooldownMs: 60_000,
      backoffMultiplier: 2,
    });

    tracker.recordFailure('XiaomiMiMo/MiMo-V2-Flash-TEE', 'Empty response from provider');
    expect(tracker.isCooling('XiaomiMiMo/MiMo-V2-Flash-TEE')).toBe(true);

    tracker.recordSuccess('XiaomiMiMo/MiMo-V2-Flash-TEE');
    expect(tracker.isCooling('XiaomiMiMo/MiMo-V2-Flash-TEE')).toBe(false);
  });
});
