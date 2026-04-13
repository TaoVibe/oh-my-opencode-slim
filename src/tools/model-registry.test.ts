import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModelRegistryTool } from './model-registry';
import { ModelRegistryStore } from '../utils/model-registry';

describe('model registry tools', () => {
  test('probe persists alive result and status reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-model-tool-'));
    const store = new ModelRegistryStore(join(dir, 'model-registry.json'));
    const ctx = {
      directory: '/tmp/project',
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'session-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'PASS' }],
              },
            ],
          })),
          abort: mock(async () => ({})),
        },
      },
    } as any;

    try {
      const tools = createModelRegistryTool(
        ctx,
        {
          agents: { oracle: { model: 'openai/gpt-5.4' } },
        } as any,
        store,
      );

      const probe = await tools.model_registry_probe.execute(
        { use_configured_models: true },
        {} as any,
      );
      expect(probe).toContain('Alive: 1');
      expect(probe).toContain('openai/gpt-5.4 | alive');

      const status = await tools.model_registry_status.execute({}, {} as any);
      expect(status).toContain('Model Registry');
      expect(status).toContain('openai/gpt-5.4 | status=alive');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
