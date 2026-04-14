import { describe, expect, test } from 'bun:test';
import { createContextCompactionHook } from './index';

describe('createContextCompactionHook', () => {
  test('compacts older orchestrator turns and preserves last four user turns', async () => {
    const hook = createContextCompactionHook();
    const output = {
      messages: [
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 1' }] },
        {
          info: { role: 'assistant', agent: 'orchestrator' },
          parts: [{ type: 'text', text: '## Goal\nship phase one\n\n## Risks\nstate drift' }],
        },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 2' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 2' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 3' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 3' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 4' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 4' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 5' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 5' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 6' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 6' }] },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].info.role).toBe('assistant');
    expect(output.messages[0].parts[0].text).toContain('<context_summary>');
    expect(output.messages[0].parts[0].text).toContain('Prior user requests:');
    expect(output.messages[0].parts[0].text).toContain('request 1');
    expect(output.messages[0].parts[0].text).toContain('Locked goal: ship phase one');
    expect(output.messages[0].parts[0].text).toContain('Active risks: state drift');

    const preservedUserTexts = output.messages
      .filter((message) => message.info.role === 'user')
      .map((message) => message.parts[0].text);
    expect(preservedUserTexts).toEqual(['request 3', 'request 4', 'request 5', 'request 6']);
  });

  test('skips compaction when there are four or fewer user turns', async () => {
    const hook = createContextCompactionHook();
    const output = {
      messages: [
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 1' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 1' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 2' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 2' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 3' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 3' }] },
        { info: { role: 'user', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'request 4' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'response 4' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'extra' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'extra 2' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'extra 3' }] },
        { info: { role: 'assistant', agent: 'orchestrator' }, parts: [{ type: 'text', text: 'extra 4' }] },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].info.role).toBe('user');
    expect(output.messages).toHaveLength(12);
  });

  test('skips non-orchestrator sessions', async () => {
    const hook = createContextCompactionHook();
    const output = {
      messages: Array.from({ length: 12 }, (_, index) => ({
        info: { role: index % 2 === 0 ? 'user' : 'assistant', agent: 'explorer' },
        parts: [{ type: 'text', text: `message ${index}` }],
      })),
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe('message 0');
  });
});
