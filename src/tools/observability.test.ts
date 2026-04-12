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
            fallbackChain: [
              'opencode/minimax-m2.7-free',
              'openai/gpt-5.4-mini',
            ],
          },
        ],
        getSessionAgentModelOverrides: () => ({ explorer: 'openai/gpt-5.4-mini' }),
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
    expect(result).toContain(
      'fallback=opencode/minimax-m2.7-free, openai/gpt-5.4-mini',
    );
    expect(result).toContain(
      '%12 | Background: Map slim fork | session=session-1',
    );
    expect(result).toContain('Session Overrides');
    expect(result).toContain('explorer=openai/gpt-5.4-mini');
  });
});
