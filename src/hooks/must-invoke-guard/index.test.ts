import { describe, expect, test } from 'bun:test';
import { createMustInvokeGuardHook } from './index';

describe('createMustInvokeGuardHook', () => {
  test('warns about missing Momus before commit requests', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'please commit these changes' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('<must_invoke_warning>');
    expect(output.messages[0].parts[0].text).toContain('Momus');
    expect(hook.getSessionStats('s1').warningCounts.momus).toBe(1);
  });

  test('warns about missing Prometheus before planning-sensitive requests', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's2' },
          parts: [
            { type: 'text', text: 'do a multi-file refactor across files' },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('Prometheus');
    expect(hook.getSessionStats('s2').warningCounts.prometheus).toBe(1);
  });

  test('stops warning once the required reviewer/planner ran', async () => {
    const hook = createMustInvokeGuardHook();

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'root-1' } },
      },
    });
    await hook.event({
      event: {
        type: 'subagent.session.created',
        properties: { sessionID: 'child-1', agentName: 'momus' },
      },
    });

    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 'root-1' },
          parts: [{ type: 'text', text: 'commit these changes' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe('commit these changes');
  });

  test('respects explicit override tokens', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's3' },
          parts: [
            {
              type: 'text',
              text: 'commit these changes\n#override:momus:user explicitly waived review',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).not.toContain(
      '<must_invoke_warning>',
    );
    expect(hook.getSessionStats('s3').overrideCounts.momus).toBe(1);
  });

  test('does not double-count warnings or overrides for the same message', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's4' },
          parts: [{ type: 'text', text: 'please commit these changes' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    await hook['experimental.chat.messages.transform']({}, output);

    expect(hook.getSessionStats('s4').warningCounts.momus).toBe(1);

    const overrideOutput = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's5' },
          parts: [
            {
              type: 'text',
              text: 'commit these changes\n#override:momus:user explicitly waived review',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, overrideOutput);
    await hook['experimental.chat.messages.transform']({}, overrideOutput);

    expect(hook.getSessionStats('s5').overrideCounts.momus).toBe(1);
  });

  test('counts explicit override tokens from later text parts', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's6' },
          parts: [
            { type: 'text', text: 'commit these changes' },
            {
              type: 'text',
              text: '#override:momus:user explicitly waived review',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(hook.getSessionStats('s6').overrideCounts.momus).toBe(1);
    expect(output.messages[0].parts[0].text).not.toContain(
      '<must_invoke_warning>',
    );
  });

  test('cleans up per-session counters on session deletion', async () => {
    const hook = createMustInvokeGuardHook();
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's7' },
          parts: [{ type: 'text', text: 'please commit these changes' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);
    expect(hook.getSessionStats('s7').warningCounts.momus).toBe(1);

    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 's7' },
      },
    });

    expect(hook.getSessionStats('s7').warningCounts.momus).toBe(0);
    expect(hook.getSessionStats('s7').overrideCounts.momus).toBe(0);
  });
});
