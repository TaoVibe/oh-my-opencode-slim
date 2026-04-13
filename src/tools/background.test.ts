import { describe, expect, test } from 'bun:test';
import { createBackgroundTools } from './background';

describe('background_task tool', () => {
  test('rejects category and agent together', async () => {
    const manager = {
      isAgentAllowed: () => true,
      getAllowedSubagents: () => ['explorer', 'oracle', 'momus'],
      launch: () => ({ id: 'bg_1', status: 'pending' }),
      resolveConfiguredModel: () => 'openai/gpt-5.4',
      resolveFallbackChain: () => ['openai/gpt-5.4'],
      getResult: () => null,
      waitForCompletion: async () => null,
      cancel: () => 0,
      setSessionAgentModelOverride: () => {},
      clearSessionAgentModelOverride: () => {},
      getSessionAgentModelOverrides: () => ({}),
    } as any;

    const tools = createBackgroundTools({} as any, manager);

    const result = await tools.background_task.execute(
      {
        description: 'review architecture',
        prompt: 'review it',
        agent: 'oracle',
        category: 'review',
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('Provide either category OR agent, not both');
    expect(result).toContain('Category "review" resolves to "momus"');
  });

  test('applies lane-based route chain for category launches', async () => {
    const manager = {
      isAgentAllowed: () => true,
      getAllowedSubagents: () => ['prometheus'],
      launch: () => ({ id: 'bg_2', status: 'pending' }),
      resolveConfiguredModel: (_agent: string, _session: string, routeChain: string[]) =>
        routeChain[0],
      resolveFallbackChain: (_agent: string, _session: string, routeChain: string[]) =>
        routeChain,
      getResult: () => null,
      waitForCompletion: async () => null,
      cancel: () => 0,
      setSessionAgentModelOverride: () => {},
      clearSessionAgentModelOverride: () => {},
      getSessionAgentModelOverrides: () => ({}),
    } as any;

    const tools = createBackgroundTools({} as any, manager, undefined, {
      routing: {
        categories: {
          planning: {
            agent: 'prometheus',
            value: {
              model: [
                'XiaomiMiMo/MiMo-V2-Flash-TEE',
                'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
              ],
            },
          },
        },
      },
    } as any);

    const result = await tools.background_task.execute(
      {
        description: 'review architecture',
        prompt: 'review it',
        category: 'planning',
        lane: 'value',
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('lane: value');
    expect(result).toContain('Model: XiaomiMiMo/MiMo-V2-Flash-TEE');
  });
});

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

  test('blocks disallowed override when allowlist is enforced', async () => {
    const manager = {
      isAgentAllowed: () => true,
      getAllowedSubagents: () => ['explorer'],
      launch: () => ({ id: 'bg_1', status: 'pending' }),
      resolveConfiguredModel: () => 'opencode/minimax-m2.7-free',
      resolveFallbackChain: () => ['opencode/minimax-m2.7-free'],
      getResult: () => null,
      waitForCompletion: async () => null,
      cancel: () => 0,
      setSessionAgentModelOverride: () => {
        throw new Error('should not set override');
      },
      clearSessionAgentModelOverride: () => {},
      getSessionAgentModelOverrides: () => ({}),
    } as any;

    const tools = createBackgroundTools({} as any, manager, undefined, {
      stackMode: 'free',
      modelPolicy: {
        enforceAllowlist: true,
        allowedModels: ['opencode/big-pickle', 'opencode/minimax-m2.7-free'],
        failClosed: true,
      },
    } as any);

    const result = await tools.session_agent_model.execute(
      { agent: 'explorer', model: 'openai/gpt-5.4-mini', clear: false, clear_all: false },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toBe(
      'Model policy blocked openai/gpt-5.4-mini for session override.',
    );
  });
});
