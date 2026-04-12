import { describe, expect, test } from 'bun:test';
import { createToolPolicyHook } from './index';

function makeCtx() {
  return {
    directory: '/tmp/project',
  } as any;
}

describe('createToolPolicyHook', () => {
  test('denies destructive bash execution before tool run', async () => {
    const hook = createToolPolicyHook(makeCtx());

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c1' },
        { args: { command: 'git reset --hard HEAD' } },
      ),
    ).rejects.toThrow(/Hard reset/);
  });

  test('marks risky bash permissions as ask', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        id: 'p1',
        type: 'bash',
        sessionID: 's1',
        messageID: 'm1',
        title: 'Bash',
        metadata: { command: 'git push origin main' },
        time: { created: Date.now() },
      },
      output,
    );

    expect(output.status).toBe('ask');
  });

  test('writes policy evaluation into post-tool metadata', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const output = { metadata: {} as Record<string, unknown> };

    await hook['tool.execute.before'](
      { tool: 'bash', callID: 'c1' },
      { args: { command: 'pwd' } },
    );
    await hook['tool.execute.after']({ callID: 'c1' }, output);

    expect(output.metadata.toolPolicy).toEqual({
      decision: 'allow',
      category: 'safe-bash',
    });
  });

  test('blocks ask-class bash execution when permission.ask did not run', async () => {
    const hook = createToolPolicyHook(makeCtx());

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c1' },
        { args: { command: 'git push origin main' } },
      ),
    ).rejects.toThrow(/Pushing writes shared remote state/);
  });

  test('allows ask-class bash execution after permission.ask cached approval', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const permissionOutput = { status: 'allow' as 'ask' | 'deny' | 'allow' };
    const toolOutput = { metadata: {} as Record<string, unknown> };

    await hook['permission.ask'](
      {
        type: 'bash',
        metadata: {
          command: 'git push origin main',
          tool: { callID: 'c1' },
        },
      },
      permissionOutput,
    );
    await hook['tool.execute.before'](
      { tool: 'bash', callID: 'c1' },
      { args: { command: 'git push origin main' } },
    );
    await hook['tool.execute.after']({ callID: 'c1' }, toolOutput);

    expect(permissionOutput.status).toBe('ask');
    expect(toolOutput.metadata.toolPolicy).toEqual({
      decision: 'ask',
      category: 'git-push',
      reason: 'Pushing writes shared remote state.',
    });
  });

  test('reads command from nested permission metadata args', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        type: 'bash',
        metadata: { args: { command: 'git push origin main' } },
      },
      output,
    );

    expect(output.status).toBe('ask');
  });

  test('treats bash permission without command metadata as ask', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const output = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        type: 'bash',
        metadata: {},
      },
      output,
    );

    expect(output.status).toBe('ask');
  });
});
