import { describe, expect, test } from 'bun:test';
import {
  buildRoutingDiagnostics,
  buildRoutingHealthNotice,
} from './routing-diagnostics';

describe('buildRoutingDiagnostics', () => {
  test('reports degraded and blocked routes based on cooled models and policy', () => {
    const diagnostics = buildRoutingDiagnostics(
      {
        modelPolicy: {
          enforceAllowlist: true,
          allowedModels: ['model/a', 'model/b'],
          failClosed: true,
        },
        routing: {
          categories: {
            planning: {
              cheap: { model: ['model/a', 'model/b'] },
              premium: { model: ['model/c'] },
            },
          },
        },
      } as any,
      [
        {
          model: 'model/a',
          consecutiveFailures: 0,
          cooldownLevel: 1,
          cooldownUntil: '2099-01-01T00:00:00.000Z',
          isCooling: true,
        },
      ],
    );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      category: 'planning',
      lane: 'cheap',
      status: 'degraded',
      recentFailedModels: [],
      preferredModel: 'model/a',
      effectiveModel: 'model/b',
    });
    expect(diagnostics[1]).toMatchObject({
      category: 'planning',
      lane: 'premium',
      status: 'blocked',
    });
  });

  test('reports registry failures per model and shifts effective model', () => {
    const diagnostics = buildRoutingDiagnostics(
      {
        fallback: {
          health: {
            enabled: true,
            failureThreshold: 2,
            cooldownMs: 300_000,
            maxCooldownMs: 1_800_000,
            backoffMultiplier: 2,
          },
        },
        routing: {
          categories: {
            execution: {
              value: {
                model: ['model/a', 'model/b', 'model/c'],
              },
            },
          },
        },
      } as any,
      [],
      {
        version: 1,
        updatedAt: '2026-04-13T06:54:41.758Z',
        models: {
          'model/a': {
            model: 'model/a',
            providerID: 'model',
            modelID: 'a',
            firstSeenAt: '2026-04-13T06:54:41.758Z',
            lastSeenAt: '2026-04-13T06:54:41.758Z',
            lastStatus: 'failed',
            lastFailureAt: '2026-04-13T06:54:41.758Z',
            successCount: 0,
            failureCount: 1,
            probeCount: 1,
            sources: ['probe'],
          },
          'model/b': {
            model: 'model/b',
            providerID: 'model',
            modelID: 'b',
            firstSeenAt: '2026-04-13T06:54:41.758Z',
            lastSeenAt: '2026-04-13T06:54:41.758Z',
            lastStatus: 'alive',
            lastSuccessAt: '2026-04-13T06:54:41.758Z',
            successCount: 1,
            failureCount: 0,
            probeCount: 1,
            sources: ['probe'],
          },
        },
      },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      category: 'execution',
      lane: 'value',
      status: 'degraded',
      recentFailedModels: ['model/a'],
      preferredModel: 'model/a',
      effectiveModel: 'model/b',
      reason: 'some models have recent failed registry status',
    });
  });

  test('treats all-recently-failed routes as blocked', () => {
    const diagnostics = buildRoutingDiagnostics(
      {
        fallback: {
          health: {
            enabled: true,
            failureThreshold: 2,
            cooldownMs: 300_000,
            maxCooldownMs: 1_800_000,
            backoffMultiplier: 2,
          },
        },
        routing: {
          categories: {
            planning: {
              premium: {
                model: ['model/a', 'model/b'],
              },
            },
          },
        },
      } as any,
      [],
      {
        version: 1,
        updatedAt: '2026-04-13T06:54:41.758Z',
        models: {
          'model/a': {
            model: 'model/a',
            providerID: 'model',
            modelID: 'a',
            firstSeenAt: '2026-04-13T06:54:41.758Z',
            lastSeenAt: '2026-04-13T06:54:41.758Z',
            lastStatus: 'failed',
            lastFailureAt: '2026-04-13T06:54:41.758Z',
            successCount: 0,
            failureCount: 1,
            probeCount: 1,
            sources: ['probe'],
          },
          'model/b': {
            model: 'model/b',
            providerID: 'model',
            modelID: 'b',
            firstSeenAt: '2026-04-13T06:54:41.758Z',
            lastSeenAt: '2026-04-13T06:54:41.758Z',
            lastStatus: 'failed',
            lastFailureAt: '2026-04-13T06:54:41.758Z',
            successCount: 0,
            failureCount: 1,
            probeCount: 1,
            sources: ['probe'],
          },
        },
      },
    );

    expect(diagnostics[0]).toMatchObject({
      category: 'planning',
      lane: 'premium',
      status: 'blocked',
      reason: 'all allowed models have recent failed registry status',
    });
  });

  test('builds a concise orchestrator routing health notice', () => {
    const notice = buildRoutingHealthNotice([
      {
        category: 'planning',
        lane: 'premium',
        status: 'blocked',
        configuredModels: ['model/a'],
        allowedModels: ['model/a'],
        cooledModels: [],
        recentFailedModels: ['model/a'],
        preferredModel: 'model/a',
        effectiveModel: 'model/a',
        reason: 'all allowed models have recent failed registry status',
      },
      {
        category: 'research',
        lane: 'value',
        status: 'degraded',
        configuredModels: ['model/b', 'model/c'],
        allowedModels: ['model/b', 'model/c'],
        cooledModels: [],
        recentFailedModels: ['model/b'],
        preferredModel: 'model/b',
        effectiveModel: 'model/c',
        reason: 'some models have recent failed registry status',
      },
    ] as any);

    expect(notice).toContain('<RoutingHealth>');
    expect(notice).toContain('h=0 d=1 b=1');
    expect(notice).toContain('blocked=planning/premium');
    expect(notice).toContain('prefer=research/value→model/c');
  });
});
