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
});
