import { describe, expect, test } from 'bun:test';
import {
  buildIntentInstruction,
  createIntentRouterHook,
  detectIntent,
  INTENT_ALIASES,
} from './index';

describe('intent router hook', () => {
  test('detects deep research intent', () => {
    expect(detectIntent('Please do a deep research pass')).toBe(
      'deep_research',
    );
  });

  test('exports aliases in a small config table', () => {
    expect(INTENT_ALIASES.deep_research).toEqual([
      'deep research',
      'research deeply',
    ]);
    expect(INTENT_ALIASES.deep_review).toEqual([
      'deep review',
      'thorough review',
      'review deeply',
    ]);
  });

  test('detects deep review intent', () => {
    expect(detectIntent('Need a deep review before merging')).toBe(
      'deep_review',
    );
  });

  test('detects conservative deep research aliases', () => {
    expect(detectIntent('Please research deeply before answering')).toBe(
      'deep_research',
    );
  });

  test('detects conservative deep review aliases', () => {
    expect(detectIntent('Need a thorough review before merging')).toBe(
      'deep_review',
    );
    expect(detectIntent('Please review deeply for edge cases')).toBe(
      'deep_review',
    );
  });

  test('returns null when no special phrase is present', () => {
    expect(detectIntent('Please review this')).toBeNull();
  });

  test('builds stable internal instruction blocks', () => {
    const instruction = buildIntentInstruction('deep_review');

    expect(instruction).toContain('<intent_router>');
    expect(instruction).toContain('intent=deep_review');
    expect(instruction).toContain(
      'Follow the orchestrator workflow for this intent.',
    );
  });

  test('prepends routing hint for orchestrator sessions', async () => {
    const hook = createIntentRouterHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator' },
          parts: [{ type: 'text', text: 'Can you do a deep research pass?' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<intent_router>');
    expect(output.messages[0].parts[0].text).toContain('intent=deep_research');
    expect(output.messages[0].parts[0].text).toContain(
      'Can you do a deep research pass?',
    );
  });

  test('skips non-orchestrator sessions', async () => {
    const hook = createIntentRouterHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'explorer' },
          parts: [{ type: 'text', text: 'Can you do a deep review?' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe('Can you do a deep review?');
  });

  test('does not double inject an existing routing block', async () => {
    const hook = createIntentRouterHook();
    const text =
      '<intent_router>\nintent=deep_review\nfoo\n</intent_router>\n\n---\n\nCan you do a deep review?';
    const output = {
      messages: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe(text);
  });
});
