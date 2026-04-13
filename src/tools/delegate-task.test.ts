import { describe, expect, test } from 'bun:test';
import { createDelegateTaskTool } from './delegate-task';

describe('delegate_task tool', () => {
  test('rejects category and subagent_type together', async () => {
    const manager = {
      getAllowedSubagents: () => ['explorer', 'oracle', 'momus'],
      launch: () => ({ id: 'bg_1', status: 'pending' }),
      resolveConfiguredModel: () => 'openai/gpt-5.4',
      resolveFallbackChain: () => ['openai/gpt-5.4'],
    } as any;

    const tools = createDelegateTaskTool({} as any, manager);

    const result = await tools.delegate_task.execute(
      {
        description: 'review architecture',
        prompt: 'review it',
        subagent_type: 'oracle',
        category: 'review',
        run_in_background: true,
        session_id: 'default',
        load_skills: [],
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('Provide either subagent_type OR category, not both');
    expect(result).toContain('Category "review" resolves to "momus"');
  });

  test('applies route lane model chain for category launches', async () => {
    let launchedPrompt = '';
    const manager = {
      getAllowedSubagents: () => ['prometheus'],
      launch: (args: { prompt: string }) => {
        launchedPrompt = args.prompt;
        return { id: 'bg_2', status: 'pending' };
      },
      resolveConfiguredModel: (_agent: string, _session: string, routeChain: string[]) =>
        routeChain[0],
      resolveFallbackChain: (_agent: string, _session: string, routeChain: string[]) =>
        routeChain,
    } as any;

    const tools = createDelegateTaskTool({} as any, manager, undefined, {
      routing: {
        categories: {
          planning: {
            agent: 'prometheus',
            cheap: {
              model: [
                'Qwen/Qwen3-30B-A3B',
                'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
              ],
            },
          },
        },
      },
    } as any);

    const result = await tools.delegate_task.execute(
      {
        description: 'plan feature',
        prompt: 'plan it',
        category: 'planning',
        lane: 'cheap',
        run_in_background: true,
        session_id: 'default',
        load_skills: [],
      },
      { sessionID: 'parent-1' } as any,
    );

    expect(result).toContain('lane: cheap');
    expect(result).toContain('Model: Qwen/Qwen3-30B-A3B');
    expect(launchedPrompt).toContain('<routing_context>');
    expect(launchedPrompt).toContain('lane=cheap');
  });
});
