import { describe, expect, test } from 'bun:test';
import { createBackgroundTools } from './background';

describe('session_agent_model tool', () => {
  test('sets, lists, and clears session-scoped overrides', async () => {
    const manager = {
      isAgentAllowed: () => true,
      getAllowedSubagents: () => ['explorer'],
      launch: () => ({ id: 'bg_1', status: 'pending' }),
      resolveConfiguredModel: () => 'opencode-go/minimax-m2.5',
      resolveFallbackChain: () => ['opencode-go/minimax-m2.5', 'openai/gpt-5.4-mini'],
      getResult: () => null,
      waitForCompletion: async () => null,
      cancel: () => 0,
      setSessionAgentModelOverride: () => {},
      clearSessionAgentModelOverride: () => {},
      getSessionAgentModelOverrides: () => ({ explorer: 'openai/gpt-5.4-mini' }),
    } as any;

    const tools = createBackgroundTools({} as any, manager);

    const setResult = await tools.session_agent_model.execute(
      { agent: 'explorer', model: 'openai/gpt-5.4-mini', clear: false, clear_all: false },
      { sessionID: 'parent-1' } as any,
    );
    expect(setResult).toContain('Set session override: explorer -> openai/gpt-5.4-mini');

    const listResult = await tools.session_agent_model.execute(
      { clear: false, clear_all: false },
      { sessionID: 'parent-1' } as any,
    );
    expect(listResult).toContain('Session Agent Model Overrides');
    expect(listResult).toContain('explorer=openai/gpt-5.4-mini');
  });
});
