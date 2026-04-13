import { describe, expect, test } from 'bun:test';
import { buildRoutingDiagnostics } from './routing-diagnostics';

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
      preferredModel: 'model/a',
      effectiveModel: 'model/b',
    });
    expect(diagnostics[1]).toMatchObject({
      category: 'planning',
      lane: 'premium',
      status: 'blocked',
    });
  });
});
