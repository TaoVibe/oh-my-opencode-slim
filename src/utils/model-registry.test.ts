import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistryStore } from './model-registry';

describe('ModelRegistryStore', () => {
  test('persists success and failure events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.recordSuccess({
        model: 'openai/gpt-5.4',
        source: 'probe',
        probe: true,
        latencyMs: 10,
      });
      store.recordFailure({
        model: 'openai/gpt-5.4',
        source: 'background',
        error: 'timeout',
      });

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
      store.recordFailure({
        model: 'glm/expensive',
        source: 'probe',
        error: 'timeout',
      });
      store.recordSuccess({ model: 'qwen/healthy', source: 'probe' });

      expect(
        store.getBiasedModelChain(['glm/expensive', 'qwen/healthy']),
      ).toEqual(['qwen/healthy', 'glm/expensive']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses lane metadata as a final tiebreaker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.upsertMetadata({
        model: 'expensive/model',
        metadata: {
          inputUsdPerM: 0.9,
          outputUsdPerM: 3.0,
          contextWindow: 200000,
        },
      });
      store.upsertMetadata({
        model: 'cheap/model',
        metadata: {
          inputUsdPerM: 0.05,
          outputUsdPerM: 0.2,
          contextWindow: 100000,
        },
      });

      expect(
        store.getBiasedModelChain(['expensive/model', 'cheap/model'], 'cheap'),
      ).toEqual(['cheap/model', 'expensive/model']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cheap lane penalizes very high average latency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const store = new ModelRegistryStore(path);

    try {
      store.upsertMetadata({
        model: 'slow/model',
        metadata: {
          inputUsdPerM: 0.02,
          outputUsdPerM: 0.05,
          contextWindow: 120000,
        },
      });
      store.upsertMetadata({
        model: 'fast/model',
        metadata: {
          inputUsdPerM: 0.03,
          outputUsdPerM: 0.06,
          contextWindow: 120000,
        },
      });
      store.recordSuccess({
        model: 'slow/model',
        source: 'probe',
        latencyMs: 18000,
      });
      store.recordSuccess({
        model: 'fast/model',
        source: 'probe',
        latencyMs: 1000,
      });

      expect(
        store.getBiasedModelChain(['slow/model', 'fast/model'], 'cheap'),
      ).toEqual(['fast/model', 'slow/model']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes legacy chutes vendor keys into canonical chutes provider keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-04-13T00:00:00.000Z',
          models: {
            'Qwen/Qwen3-Coder-Next': {
              model: 'Qwen/Qwen3-Coder-Next',
              providerID: 'Qwen',
              modelID: 'Qwen3-Coder-Next',
              firstSeenAt: '2026-04-13T00:00:00.000Z',
              lastSeenAt: '2026-04-13T00:00:00.000Z',
              lastStatus: 'failed',
              requestCount: null,
              successCount: 0,
              failureCount: 1,
              probeCount: 1,
              sources: ['probe'],
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const store = new ModelRegistryStore(path);
    try {
      const data = store.load();
      expect(data.models['chutes/qwen/qwen3-coder-next']).toBeDefined();
      expect(data.models['chutes/qwen/qwen3-coder-next'].requestCount).toBe(0);
      expect(data.models['Qwen/Qwen3-Coder-Next']).toBeUndefined();
      expect(readFileSync(path, 'utf-8')).toContain(
        'chutes/qwen/qwen3-coder-next',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates legacy registry data into the new registry path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-registry-'));
    const path = join(dir, 'model-registry.json');
    const legacyPath = join(dir, 'legacy', 'model-registry.json');
    mkdirSync(join(dir, 'legacy'), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: '2026-04-13T00:00:00.000Z',
          models: {
            'openai/gpt-5.4': {
              model: 'openai/gpt-5.4',
              providerID: 'openai',
              modelID: 'gpt-5.4',
              firstSeenAt: '2026-04-13T00:00:00.000Z',
              lastSeenAt: '2026-04-13T00:00:00.000Z',
              lastStatus: 'alive',
              requestCount: 1,
              successCount: 1,
              failureCount: 0,
              probeCount: 1,
              sources: ['probe'],
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const store = new ModelRegistryStore(path, legacyPath);
    try {
      const data = store.load();
      expect(data.models['openai/gpt-5.4']?.lastStatus).toBe('alive');
      expect(readFileSync(path, 'utf-8')).toContain('openai/gpt-5.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
