import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRegistryStore } from './model-registry';

describe('ModelRegistryStore', () => {
  test('persists success and failure events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.recordSuccess({ model: 'openai/gpt-5.4', source: 'probe', probe: true, latencyMs: 10 });
      store.recordFailure({ model: 'openai/gpt-5.4', source: 'background', error: 'timeout' });

      const data = store.load();
      expect(data.models['openai/gpt-5.4']).toMatchObject({
        model: 'openai/gpt-5.4',
        providerID: 'openai',
        modelID: 'gpt-5.4',
        requestCount: 2,
        successCount: 1,
        failureCount: 1,
        probeCount: 1,
        lastStatus: 'failed',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merges metadata and aliases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.upsertMetadata({
        model: 'openai/gpt-5.4',
        aliases: ['gpt5.4'],
        metadata: { provider: 'openai', contextWindow: 128000 },
        source: 'routing',
      });

      const data = store.load();
      expect(data.models['openai/gpt-5.4']).toMatchObject({
        aliases: ['gpt5.4'],
        metadata: { provider: 'openai', contextWindow: 128000 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('biases model chains toward alive and recently used models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.recordFailure({ model: 'glm/expensive', source: 'probe', error: 'timeout' });
      store.recordSuccess({ model: 'qwen/healthy', source: 'probe' });

      expect(store.getBiasedModelChain(['glm/expensive', 'qwen/healthy'])).toEqual([
        'qwen/healthy',
        'glm/expensive',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
