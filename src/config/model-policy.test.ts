import { describe, expect, test } from 'bun:test';
import { filterAllowedModels, isModelAllowed } from './model-policy';

describe('model policy alias handling', () => {
  test('allows normalized alias matches', () => {
    const config = {
      modelPolicy: {
        enforceAllowlist: true,
        allowedModels: ['qwen/qwen3-coder-next'],
        failClosed: true,
      },
    } as any;

    expect(isModelAllowed('Qwen/Qwen3-Coder-Next-TEE', config)).toBe(true);
  });

  test('filters models using alias-aware allowlist matching', () => {
    const config = {
      modelPolicy: {
        enforceAllowlist: true,
        allowedModels: ['qwen/qwen3-coder-next'],
        failClosed: true,
      },
    } as any;

    expect(
      filterAllowedModels(
        ['Qwen/Qwen3-Coder-Next-TEE', 'openai/gpt-5.4'],
        config,
      ),
    ).toEqual(['Qwen/Qwen3-Coder-Next-TEE']);
  });
});
