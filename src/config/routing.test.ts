import { describe, expect, test } from 'bun:test';
import { buildRoutedPrompt, resolveCategoryRoute } from './routing';

describe('category lane routing', () => {
  test('uses requested lane when configured', () => {
    const result = resolveCategoryRoute(
      {
        routing: {
          defaultLane: 'value',
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
      } as any,
      'planning',
      'cheap',
    );

    expect(result.agent).toBe('prometheus');
    expect(result.lane).toBe('cheap');
    expect(result.modelChain).toEqual([
      'Qwen/Qwen3-30B-A3B',
      'deepseek-ai/DeepSeek-R1-Distill-Llama-70B',
    ]);
  });

  test('falls back to category default lane', () => {
    const result = resolveCategoryRoute(
      {
        routing: {
          defaultLane: 'value',
          categories: {
            planning: {
              agent: 'prometheus',
              defaultLane: 'premium',
              premium: {
                model: ['Qwen/Qwen3-235B-A22B-Instruct-2507-TEE'],
              },
            },
          },
        },
      } as any,
      'planning',
    );

    expect(result.lane).toBe('premium');
    expect(result.modelChain).toEqual([
      'Qwen/Qwen3-235B-A22B-Instruct-2507-TEE',
    ]);
  });

  test('builds routed prompt with lane context', () => {
    const prompt = buildRoutedPrompt({
      prompt: 'Do the work',
      category: 'planning',
      lane: 'cheap',
      agent: 'prometheus',
      promptAppend: 'Keep it bounded.',
    });

    expect(prompt).toContain('<routing_context>');
    expect(prompt).toContain('category=planning');
    expect(prompt).toContain('lane=cheap');
    expect(prompt).toContain('resolved_agent=prometheus');
    expect(prompt).toContain('route_instruction=Keep it bounded.');
  });
});
