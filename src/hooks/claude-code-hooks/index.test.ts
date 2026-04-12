import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeHooksHook } from './index';
import type { HookAction } from './types';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function makeCtx() {
  return {
    directory: '/tmp/project',
    client: {
      session: {
        prompt: mock(async () => ({})),
      },
      tui: {
        showToast: mock(async () => ({})),
      },
    },
  } as any;
}

function makeDispatch(outputs: Record<string, string>) {
  return async (hook: HookAction) => ({
    exitCode: 0,
    stdout: hook.type === 'command' ? (outputs[hook.command] ?? '') : '',
    stderr: '',
  });
}

describe('createClaudeCodeHooksHook', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omo-cc-hooks-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('injects UserPromptSubmit output into latest user message', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'injectPrompt',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({ injectPrompt: 'HOOKED PROMPT' }),
    });
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'hello world' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toContain('HOOKED PROMPT');
    expect(output.messages[0].parts[0].text).toContain(
      '<user-prompt-submit-hook>',
    );
  });

  test('injects UserPromptSubmit only into the latest orchestrator user message', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'injectPrompt' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({ injectPrompt: 'HOOKED PROMPT' }),
    });
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: { role: 'assistant', sessionID: 's1' },
          parts: [{ type: 'text', text: 'reply' }],
        },
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [{ type: 'text', text: 'second' }],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe('first');
    expect(output.messages[2].parts[0].text).toContain('HOOKED PROMPT');
    expect(output.messages[2].parts[0].text).toContain('second');
  });

  test('does not double-inject UserPromptSubmit tags', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'injectPrompt' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({ injectPrompt: 'HOOKED PROMPT' }),
    });
    const output = {
      messages: [
        {
          info: { role: 'user', agent: 'orchestrator', sessionID: 's1' },
          parts: [
            {
              type: 'text',
              text: '<user-prompt-submit-hook>\nexisting\n</user-prompt-submit-hook>\n\n---\n\nhello world',
            },
          ],
        },
      ],
    };

    await hook['experimental.chat.messages.transform']({}, output);

    expect(output.messages[0].parts[0].text).toBe(
      '<user-prompt-submit-hook>\nexisting\n</user-prompt-submit-hook>\n\n---\n\nhello world',
    );
  });

  test('applies PreToolUse updatedInput to tool args', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'mutateInput',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        mutateInput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const output = { args: { command: 'ls' } };

    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      output,
    );

    expect(output.args.command).toBe('pwd');
  });

  test('uses permission.ask to cache PreToolUse updatedInput', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'permissionMutate',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        permissionMutate: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const askOutput = { status: 'ask' as 'ask' | 'deny' | 'allow' };
    const beforeOutput = { args: { command: 'ls' } };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        callID: 'c1',
        metadata: { command: 'ls' },
      },
      askOutput,
    );
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      beforeOutput,
    );

    expect(askOutput.status).toBe('ask');
    expect(beforeOutput.args.command).toBe('pwd');
  });

  test.each([
    ['metadata.command', { command: 'ls' }],
    ['metadata.cmd', { cmd: 'ls' }],
    ['metadata.args.command', { args: { command: 'ls' } }],
    ['metadata.input.command', { input: { command: 'ls' } }],
    ['metadata.toolInput.command', { toolInput: { command: 'ls' } }],
    ['metadata.tool_input.command', { tool_input: { command: 'ls' } }],
  ])('caches PreToolUse updates for %s', async (_label, metadata) => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'permissionMutate' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        permissionMutate: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const askOutput = { status: 'ask' as 'ask' | 'deny' | 'allow' };
    const beforeOutput = { args: { command: 'ls' } };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        callID: 'c1',
        metadata,
      },
      askOutput,
    );
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      beforeOutput,
    );

    expect(askOutput.status).toBe('ask');
    expect(beforeOutput.args.command).toBe('pwd');
  });

  test.each([
    ['metadata.callID', { callID: 'c1' }],
    ['metadata.call_id', { call_id: 'c1' }],
    ['metadata.tool.callID', { tool: { callID: 'c1' } }],
    ['metadata.tool.call_id', { tool: { call_id: 'c1' } }],
  ])('uses %s to cache permission.ask resolutions', async (_label, metadata) => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'permissionMutate' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        permissionMutate: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const askOutput = { status: 'allow' as 'ask' | 'deny' | 'allow' };
    const beforeOutput = { args: { command: 'ls' } };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        metadata,
      },
      askOutput,
    );
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      beforeOutput,
    );

    expect(askOutput.status).toBe('allow');
    expect(beforeOutput.args.command).toBe('pwd');
  });

  test('maps Claude ask decision into permission.ask', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'requireApproval',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        requireApproval: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: 'Need approval',
          },
        }),
      }),
    });
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        callID: 'c1',
        metadata: { command: 'git push origin main' },
      },
      output,
    );

    expect(output.status).toBe('ask');
  });

  test('maps Claude deny decision into permission.ask', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'denyIt',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        denyIt: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Blocked by hook',
          },
        }),
      }),
    });
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        callID: 'c1',
        metadata: { command: 'git push --force origin main' },
      },
      output,
    );

    expect(output.status).toBe('deny');
  });

  test('maps permission.ask metadata from nested args and tool callID', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'nestedAsk' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        nestedAsk: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };
    const beforeOutput = { args: { command: 'ls' } };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        metadata: {
          args: { command: 'git push origin main' },
          tool: { callID: 'c1' },
        },
      },
      output,
    );
    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      beforeOutput,
    );

    expect(output.status).toBe('ask');
    expect(beforeOutput.args.command).toBe('pwd');
  });

  test('maps permission.ask metadata from tool_input and tool.call_id', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'denyViaToolInput' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        denyViaToolInput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Denied from nested metadata',
          },
        }),
      }),
    });
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        metadata: {
          tool_input: { command: 'git push --force origin main' },
          tool: { call_id: 'c1' },
        },
      },
      output,
    );

    expect(output.status).toBe('deny');
  });

  test('blocks PreToolUse on exit code 2', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'blockViaExit' }],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: async () => ({
        exitCode: 2,
        stdout: 'blocked by exit code',
        stderr: '',
      }),
    });

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', sessionID: 's1', callID: 'c1' },
        { args: { command: 'ls' } },
      ),
    ).rejects.toThrow(/blocked by exit code/);
  });

  test('appends PostToolUse additional context to tool output', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: 'postContext',
              },
            ],
          },
        ],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: makeDispatch({
        postContext: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'extra context',
          },
        }),
      }),
    });
    const output = { title: 'Read', output: 'file body', metadata: {} };

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 's1', callID: 'c1' },
      output,
    );

    expect(output.output).toContain('file body');
    expect(output.output).toContain('extra context');
  });

  test('shows PostToolUse warning toast when decision is block', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Read',
            hooks: [{ type: 'command', command: 'warnAfter' }],
          },
        ],
      },
    });

    const ctx = makeCtx();
    const hook = createClaudeCodeHooksHook(ctx, [], {
      settingsPath,
      dispatchHook: makeDispatch({
        warnAfter: JSON.stringify({
          decision: 'block',
          reason: 'warning from hook',
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: 'extra context',
          },
        }),
      }),
    });
    const output = { title: 'Read', output: 'file body', metadata: {} };

    await hook['tool.execute.after'](
      { tool: 'read', sessionID: 's1', callID: 'c1' },
      output,
    );

    expect(ctx.client.tui.showToast).toHaveBeenCalledTimes(1);
    expect(output.output).toContain('extra context');
  });

  test('injects prompts on SessionStart and SubagentStart', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'rootStart',
              },
            ],
          },
        ],
        SubagentStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: 'childStart',
              },
            ],
          },
        ],
      },
    });

    const ctx = makeCtx();
    const hook = createClaudeCodeHooksHook(ctx, [], {
      settingsPath,
      dispatchHook: makeDispatch({
        rootStart: 'ROOT START',
        childStart: 'CHILD START',
      }),
    });

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'root-1' } },
      },
    });
    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'root-1' } },
      },
    });

    expect(ctx.client.session.prompt).toHaveBeenCalledTimes(2);
    const calls = ctx.client.session.prompt.mock.calls as Array<any[]>;
    expect(calls[0][0].path.id).toBe('root-1');
    expect(calls[0][0].body.parts[0].text).toContain('ROOT START');
    expect(calls[1][0].path.id).toBe('child-1');
    expect(calls[1][0].body.parts[0].text).toContain('CHILD START');
  });

  test('runs SubagentStop hooks on child session deletion', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    writeJson(settingsPath, {
      hooks: {
        SubagentStop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'childStop' }],
          },
        ],
      },
    });

    const seenPayloads: string[] = [];
    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      dispatchHook: async (_hook, payload) => {
        seenPayloads.push(payload);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await hook.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'root-1', title: 'X' } },
      },
    });
    await hook.event({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'child-1' } },
      },
    });

    expect(seenPayloads).toHaveLength(1);
    expect(seenPayloads[0]).toContain('SubagentStop');
    expect(seenPayloads[0]).toContain('root-1');
  });

  test('honors disabled hook commands for PreToolUse', async () => {
    const settingsPath = join(tempDir, 'settings.json');
    const extendedConfigPath = join(tempDir, 'opencode-cc-plugin.json');
    writeJson(settingsPath, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'mutateInput' }],
          },
        ],
      },
    });
    writeJson(extendedConfigPath, {
      disabledHooks: {
        PreToolUse: ['mutateInput'],
      },
    });

    const hook = createClaudeCodeHooksHook(makeCtx(), [], {
      settingsPath,
      extendedConfigPath,
      dispatchHook: makeDispatch({
        mutateInput: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { command: 'pwd' },
          },
        }),
      }),
    });
    const output = { args: { command: 'ls' } };

    await hook['tool.execute.before'](
      { tool: 'bash', sessionID: 's1', callID: 'c1' },
      output,
    );

    expect(output.args.command).toBe('ls');
  });
});
