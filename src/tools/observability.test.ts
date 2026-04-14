import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistryStore } from '../utils/model-registry';
import { createObservabilityTool } from './observability';

describe('observability_status tool', () => {
  test('shows active task and pane runtime state', async () => {
    const tools = createObservabilityTool(
      {
        getTaskSnapshots: () => [
          {
            id: 'bg_123',
            sessionId: 'session-1',
            description: 'Map slim fork',
            agent: 'explorer',
            status: 'running',
            parentSessionId: 'parent-1',
            startedAt: '2026-04-12T00:00:00.000Z',
            configuredModel: 'opencode/minimax-m2.7-free',
            variant: 'high-speed',
            category: 'exploration',
            lane: 'cheap',
            routeModelChain: ['Qwen/Qwen3-30B-A3B'],
            fallbackChain: [
              'opencode/minimax-m2.7-free',
              'openai/gpt-5.4-mini',
            ],
          },
        ],
        getSessionAgentModelOverrides: () => ({
          explorer: 'openai/gpt-5.4-mini',
        }),
        getModelHealthSnapshots: () => [
          {
            model: 'XiaomiMiMo/MiMo-V2-Flash-TEE',
            consecutiveFailures: 0,
            cooldownLevel: 1,
            cooldownUntil: '2026-04-12T00:10:00.000Z',
            isCooling: true,
          },
        ],
      } as any,
      {
        getTrackedSessions: () => [
          {
            sessionId: 'session-1',
            paneId: '%12',
            parentId: 'parent-1',
            title: 'Background: Map slim fork',
            createdAt: 1,
            lastSeenAt: 2,
          },
        ],
        getSessionAgentModelOverrides: () => ({
          explorer: 'openai/gpt-5.4-mini',
        }),
      } as any,
      {
        routing: {
          categories: {
            exploration: {
              cheap: { model: ['Qwen/Qwen3-30B-A3B'] },
            },
          },
        },
      } as any,
      undefined,
      undefined,
      {
        getSessionStats: () => ({
          sawPrometheus: true,
          sawMomus: false,
          warningCounts: { prometheus: 1, momus: 2 },
          overrideCounts: { prometheus: 0, momus: 1 },
        }),
      } as any,
    );

    const result = await tools.observability_status.execute(
      {
        include_completed: false,
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('Runtime Status');
    expect(result).toContain('bg_123 | explorer | running | Map slim fork');
    expect(result).toContain('model=opencode/minimax-m2.7-free');
    expect(result).toContain('route=exploration/cheap');
    expect(result).toContain('routeChain=Qwen/Qwen3-30B-A3B');
    expect(result).toContain(
      'fallback=opencode/minimax-m2.7-free, openai/gpt-5.4-mini',
    );
    expect(result).toContain(
      '%12 | Background: Map slim fork | session=session-1',
    );
    expect(result).toContain('Session Overrides');
    expect(result).toContain('explorer=openai/gpt-5.4-mini');
    expect(result).toContain('Must-Invoke Observability');
    expect(result).toContain('prometheus: saw=yes | warnings=1 | overrides=0');
    expect(result).toContain('momus: saw=no | warnings=2 | overrides=1');
    expect(result).toContain('Model Health');
    expect(result).toContain('XiaomiMiMo/MiMo-V2-Flash-TEE | cooling=yes');
    expect(result).toContain('Route Diagnostics');
    expect(result).toContain('exploration/cheap | healthy');
    expect(result).toContain(
      'preferred=Qwen/Qwen3-30B-A3B | effective=Qwen/Qwen3-30B-A3B',
    );
  });

  test('routing_doctor reports degraded routes clearly', async () => {
    const tools = createObservabilityTool(
      {
        getTaskSnapshots: () => [],
        getSessionAgentModelOverrides: () => ({}),
        getModelHealthSnapshots: () => [
          {
            model: 'XiaomiMiMo/MiMo-V2-Flash-TEE',
            consecutiveFailures: 0,
            cooldownLevel: 1,
            cooldownUntil: '2026-04-12T00:10:00.000Z',
            isCooling: true,
          },
        ],
      } as any,
      {
        getTrackedSessions: () => [],
      } as any,
      {
        routing: {
          categories: {
            planning: {
              value: {
                model: [
                  'XiaomiMiMo/MiMo-V2-Flash-TEE',
                  'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
                ],
              },
            },
          },
        },
      } as any,
      undefined,
      undefined,
      {
        getSessionStats: () => ({
          sawPrometheus: false,
          sawMomus: false,
          warningCounts: { prometheus: 0, momus: 0 },
          overrideCounts: { prometheus: 2, momus: 2 },
        }),
      } as any,
    );

    const result = await tools.routing_doctor.execute({}, {
      sessionID: 'parent-1',
    } as any);

    expect(result).toContain('Routing Doctor');
    expect(result).toContain('Verdict: routing is degraded.');
    expect(result).toContain('planning/value');
    expect(result).toContain(
      'Override Warning: current session has 4 must-invoke overrides',
    );
    expect(result).toContain(
      'preferred=XiaomiMiMo/MiMo-V2-Flash-TEE | effective=Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
    );
  });

  test('routing_doctor warns about stale session metadata', async () => {
    const tools = createObservabilityTool(
      {
        getTaskSnapshots: () => [],
        getSessionAgentModelOverrides: () => ({}),
        getModelHealthSnapshots: () => [],
      } as any,
      {
        getTrackedSessions: () => [],
      } as any,
      {
        routing: { categories: {} },
      } as any,
      {
        pluginStartedAt: '2026-04-12T00:00:00.000Z',
        latestConfigMtime: '2026-04-12T01:00:00.000Z',
      },
    );

    const result = await tools.routing_doctor.execute({}, {} as any);
    expect(result).toContain('Freshness: stale session detected');
  });

  test('shows completed task fetch status when included', async () => {
    const tools = createObservabilityTool(
      {
        getTaskSnapshots: () => [
          {
            id: 'bg_done',
            sessionId: 'session-2',
            description: 'Review routing policy',
            agent: 'oracle',
            status: 'completed',
            parentSessionId: 'parent-1',
            startedAt: '2026-04-12T00:00:00.000Z',
            completedAt: '2026-04-12T00:00:05.000Z',
            resultConsumedAt: '2026-04-12T00:00:07.000Z',
            configuredModel: 'opencode-go/glm-5.1',
            variant: undefined,
            category: 'architecture',
            lane: 'value',
            routeModelChain: ['opencode-go/glm-5.1', 'openai/gpt-5.4'],
            fallbackChain: ['opencode-go/glm-5.1', 'openai/gpt-5.4'],
          },
        ],
        getSessionAgentModelOverrides: () => ({}),
        getModelHealthSnapshots: () => [],
      } as any,
      {
        getTrackedSessions: () => [],
      } as any,
      {
        routing: {
          categories: {
            architecture: {
              value: {
                model: ['opencode-go/glm-5.1', 'openai/gpt-5.4'],
              },
            },
          },
        },
      } as any,
    );

    const result = await tools.observability_status.execute(
      {
        include_completed: true,
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain(
      'bg_done | oracle | completed | Review routing policy',
    );
    expect(result).toContain('completedAt=2026-04-12T00:00:05.000Z');
    expect(result).toContain('resultFetched=2026-04-12T00:00:07.000Z');
  });

  test('routing_doctor includes registry state for preferred/effective models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omo-obs-reg-'));
    const store = new ModelRegistryStore(join(dir, 'model-registry.json'));
    store.recordFailure({
      model: 'XiaomiMiMo/MiMo-V2-Flash-TEE',
      source: 'probe',
      probe: true,
      error: 'timeout',
    });
    store.recordSuccess({
      model: 'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
      source: 'probe',
      probe: true,
    });

    try {
      const tools = createObservabilityTool(
        {
          getTaskSnapshots: () => [],
          getSessionAgentModelOverrides: () => ({}),
          getModelHealthSnapshots: () => [
            {
              model: 'XiaomiMiMo/MiMo-V2-Flash-TEE',
              consecutiveFailures: 0,
              cooldownLevel: 1,
              cooldownUntil: '2026-04-12T00:10:00.000Z',
              isCooling: true,
            },
          ],
        } as any,
        { getTrackedSessions: () => [] } as any,
        {
          routing: {
            categories: {
              planning: {
                value: {
                  model: [
                    'XiaomiMiMo/MiMo-V2-Flash-TEE',
                    'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
                  ],
                },
              },
            },
          },
        } as any,
        undefined,
        store,
      );

      const result = await tools.routing_doctor.execute({}, {} as any);
      expect(result).toContain('preferredRegistry=failed');
      expect(result).toContain('effectiveRegistry=alive');
      expect(result).toContain('requests=1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
