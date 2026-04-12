import { describe, expect, it } from 'bun:test';
import {
  checkAgentAllowed,
  formatTaskLaunchMessage,
  resolveRequestedAgent,
} from './resolution';

describe('resolveRequestedAgent', () => {
  it('resolves planning category to prometheus', () => {
    const result = resolveRequestedAgent({
      category: 'planning',
      subagent_type: null,
    });
    expect(result.agent).toBe('prometheus');
    expect(result.via).toBe('category');
  });

  it('resolves review category to momus', () => {
    const result = resolveRequestedAgent({
      category: 'review',
      subagent_type: null,
    });
    expect(result.agent).toBe('momus');
  });

  it('resolves exploration category to explorer', () => {
    const result = resolveRequestedAgent({
      category: 'exploration',
      subagent_type: null,
    });
    expect(result.agent).toBe('explorer');
  });

  it('uses subagent_type when category not provided', () => {
    const result = resolveRequestedAgent({
      category: null,
      subagent_type: 'explorer',
    });
    expect(result.agent).toBe('explorer');
    expect(result.via).toBe('subagent_type');
  });

  it('treats empty category as unset and uses subagent_type', () => {
    const result = resolveRequestedAgent({
      category: '   ',
      subagent_type: 'explorer',
    });
    expect(result.agent).toBe('explorer');
    expect(result.via).toBe('subagent_type');
  });

  it('treats empty strings as missing values', () => {
    const result = resolveRequestedAgent({
      category: '',
      subagent_type: '   ',
    });
    expect(result.error).toBe(true);
    expect(result.message).toContain('Must provide either');
  });

  it('category takes precedence over subagent_type', () => {
    // When both are provided, category wins
    const result = resolveRequestedAgent({
      category: 'planning',
      subagent_type: 'explorer',
    });
    expect(result.agent).toBe('prometheus');
    expect(result.via).toBe('category');
  });

  it('returns error for invalid category', () => {
    const result = resolveRequestedAgent({
      category: 'not-a-category',
      subagent_type: null,
    });
    expect(result.error).toBe(true);
    expect(result.message).toContain('Invalid category');
  });

  it('returns error when neither provided', () => {
    const result = resolveRequestedAgent({
      category: null,
      subagent_type: null,
    });
    expect(result.error).toBe(true);
    expect(result.message).toContain('Must provide either');
  });
});

describe('checkAgentAllowed', () => {
  const allowedAgents = ['explorer', 'librarian', 'fixer'] as const;

  it('allows agent in list', () => {
    const result = checkAgentAllowed('explorer', allowedAgents);
    expect(result).toBeNull();
  });

  it('returns error for disallowed agent', () => {
    const result = checkAgentAllowed('prometheus', allowedAgents);
    expect(result).not.toBeNull();
    expect(result?.error).toBe(true);
    expect(result?.message).toContain('not allowed');
  });
});

describe('formatTaskLaunchMessage', () => {
  const mockTask = { id: 'task_123', status: 'started' };

  it('formats background task message', () => {
    const message = formatTaskLaunchMessage(
      mockTask,
      { agent: 'prometheus', via: 'category', category: 'planning' },
      true,
      {
        model: 'opencode-go/glm-5.1',
        fallbackChain: ['opencode-go/glm-5.1', 'openai/gpt-5.4'],
      },
    );
    expect(message).toContain('task_123');
    expect(message).toContain('prometheus');
    expect(message).toContain('via category: planning');
    expect(message).toContain('background_output');
    expect(message).toContain('Model: opencode-go/glm-5.1');
    expect(message).toContain('Fallback: openai/gpt-5.4');
  });

  it('formats sync task message', () => {
    const message = formatTaskLaunchMessage(
      mockTask,
      { agent: 'explorer', via: 'subagent_type' },
      false,
      { model: 'opencode-go/minimax-m2.5' },
    );
    expect(message).toContain('task_123');
    expect(message).toContain('background_output');
    expect(message).not.toContain('background task launched');
    expect(message).toContain('Model: opencode-go/minimax-m2.5');
  });
});
