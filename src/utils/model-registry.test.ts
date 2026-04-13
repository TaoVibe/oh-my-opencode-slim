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
        successCount: 1,
        failureCount: 1,
        probeCount: 1,
        lastStatus: 'failed',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
