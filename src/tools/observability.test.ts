import { describe, expect, test } from 'bun:test';
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
        getSessionAgentModelOverrides: () => ({ explorer: 'openai/gpt-5.4-mini' }),
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
        getSessionAgentModelOverrides: () => ({ explorer: 'openai/gpt-5.4-mini' }),
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
    );

    const result = await tools.routing_doctor.execute({}, {} as any);

    expect(result).toContain('Routing Doctor');
    expect(result).toContain('Verdict: routing is degraded.');
    expect(result).toContain('planning/value');
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
});
