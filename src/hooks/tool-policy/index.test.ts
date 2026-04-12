import { describe, expect, test } from 'bun:test';
import { classifyToolExecution } from './classify';
import { createToolPolicyHook } from './index';

function makeCtx() {
  return {
    directory: '/tmp/project',
  } as any;
}

describe('createToolPolicyHook', () => {
  test('matches Claude parity for dangerous bypass and destructive commands', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'git commit --no-verify -m test' },
      }),
    ).toEqual({
      decision: 'deny',
      category: 'hook-bypass',
      reason: 'Bypassing hooks disables required safety checks.',
    });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'git branch -D main' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'git rm --cached .claude/settings.json',
        },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'sqlite3 app.db "DELETE FROM users"' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'git stash push -m temp' },
      }).decision,
    ).toBe('deny');
  });

  test('allows constrained safe dev commands', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'pip install -r requirements.txt' },
      }).decision,
    ).toBe('allow');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'uv pip install -e .' },
      }).decision,
    ).toBe('allow');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'cd frontend && npm install' },
      }),
    ).toEqual({ decision: 'allow', category: 'repo-frontend-install' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'npm ci',
          workdir: '/Users/mdoan/Projects/Bubbler/frontend',
        },
      }),
    ).toEqual({ decision: 'allow', category: 'repo-frontend-install' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'tar -tf fixture.tar' },
      }),
    ).toEqual({ decision: 'allow', category: 'tar-list' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'unzip -l fixture.zip' },
      }),
    ).toEqual({ decision: 'allow', category: 'unzip-list' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'env FOO=bar uv run pytest tests/unit' },
      }),
    ).toEqual({ decision: 'allow', category: 'env-safe-command' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'env FOO=bar npm ci',
          workdir: '/Users/mdoan/Projects/Bubbler/frontend',
        },
      }),
    ).toEqual({ decision: 'allow', category: 'env-safe-command' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'env FOO=bar python -c "print(1)"' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'env FOO=bar bun x something' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'env FOO=bar uv run pytest tests/unit | cat' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command:
            'bunx biome check --write src/hooks/tool-policy/classify.ts src/hooks/tool-policy/index.test.ts',
        },
      }),
    ).toEqual({ decision: 'allow', category: 'bunx-biome' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'bunx biome --version' },
      }),
    ).toEqual({ decision: 'allow', category: 'bunx-biome' });
  });

  test('asks for shared-state or risky but legitimate commands', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'git push origin main' },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'gh pr review 123 --approve' },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'docker compose down -v' },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'npm install left-pad' },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'curl -X POST https://example.com/webhook -d hi=1' },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'wget https://example.com/file.txt' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'tar -xf archive.tar -C fixtures/imports',
          workdir: '/Users/mdoan/Projects/clipper',
        },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'wget -P fixtures/imports https://example.com/file.txt',
          workdir: '/Users/mdoan/Projects/clipper',
        },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'bunx cowsay hello' },
      }).decision,
    ).toBe('ask');
  });

  test('denies unsafe archive extraction and broad remote wget downloads', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'tar -xf archive.tar -C /tmp/out',
          workdir: '/Users/mdoan/Projects/clipper',
        },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'unzip archive.zip -d downloads/raw',
          workdir: '/Users/mdoan/Projects/clipper',
        },
      }).decision,
    ).toBe('ask');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'wget https://example.com/file.txt',
          workdir: '/Users/mdoan/Projects/clipper',
        },
      }),
    ).toEqual({
      decision: 'deny',
      category: 'wget-remote',
      reason:
        'Remote wget downloads arbitrary files outside reviewed repo-scoped targets.',
    });
  });

  test('allows localhost writes and profiler commands', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'curl -X POST http://localhost:8000/reload -d force=1',
        },
      }),
    ).toEqual({ decision: 'allow', category: 'curl-local-write' });

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'py-spy top --pid 1234' },
      }),
    ).toEqual({ decision: 'allow', category: 'profiler' });
  });

  test('denies inline shell and interpreter wrappers', () => {
    expect(
      classifyToolExecution({
        tool: 'bash',
        args: { command: 'bash -c "rm -rf /tmp/demo"' },
      }).decision,
    ).toBe('deny');

    expect(
      classifyToolExecution({
        tool: 'bash',
        args: {
          command: 'python3 -c "import os; os.system(\'rm -rf /tmp/demo\')"',
        },
      }).decision,
    ).toBe('deny');
  });

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

  test('allows exact blocked command after explicit user override message', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const permissionOutput = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        sessionID: 's1',
        type: 'bash',
        metadata: {
          command: 'git push origin main',
          tool: { callID: 'c1' },
        },
      },
      permissionOutput,
    );
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          {
            info: { role: 'user', sessionID: 's1', agent: 'orchestrator' },
            parts: [{ type: 'text', text: 'proceed with it' }],
          },
        ],
      },
    );

    const nextPermissionOutput = {
      status: 'ask' as 'ask' | 'deny' | 'allow',
    };
    await hook['permission.ask'](
      {
        sessionID: 's1',
        type: 'bash',
        metadata: {
          command: 'git push origin main',
          tool: { callID: 'c2' },
        },
      },
      nextPermissionOutput,
    );

    expect(nextPermissionOutput.status).toBe('allow');
    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c2', sessionID: 's1' },
        { args: { command: 'git push origin main' } },
      ),
    ).resolves.toBeUndefined();
  });

  test('does not override a different command after proceed message', async () => {
    const hook = createToolPolicyHook(makeCtx());
    const permissionOutput = { status: 'allow' as 'ask' | 'deny' | 'allow' };

    await hook['permission.ask'](
      {
        sessionID: 's1',
        type: 'bash',
        metadata: {
          command: 'git push origin main',
          tool: { callID: 'c1' },
        },
      },
      permissionOutput,
    );
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          {
            info: { role: 'user', sessionID: 's1', agent: 'orchestrator' },
            parts: [{ type: 'text', text: 'override it' }],
          },
        ],
      },
    );

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c2', sessionID: 's1' },
        { args: { command: 'gh pr merge 123' } },
      ),
    ).rejects.toThrow();
  });

  test('allows exact blocked command after natural push again message', async () => {
    const hook = createToolPolicyHook(makeCtx());

    await hook['permission.ask'](
      {
        sessionID: 's1',
        type: 'bash',
        metadata: {
          command: 'git push tao feature/category-routing',
          tool: { callID: 'c1' },
        },
      },
      { status: 'allow' as 'ask' | 'deny' | 'allow' },
    );
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          {
            info: { role: 'user', sessionID: 's1', agent: 'orchestrator' },
            parts: [{ type: 'text', text: 'push again' }],
          },
        ],
      },
    );

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c2', sessionID: 's1' },
        { args: { command: 'git push tao feature/category-routing' } },
      ),
    ).resolves.toBeUndefined();
  });

  test('allows exact blocked command after natural try again message', async () => {
    const hook = createToolPolicyHook(makeCtx());

    await hook['permission.ask'](
      {
        sessionID: 's1',
        type: 'bash',
        metadata: {
          command: 'gh pr merge 123',
          tool: { callID: 'c1' },
        },
      },
      { status: 'allow' as 'ask' | 'deny' | 'allow' },
    );
    await hook['experimental.chat.messages.transform'](
      {},
      {
        messages: [
          {
            info: { role: 'user', sessionID: 's1', agent: 'orchestrator' },
            parts: [{ type: 'text', text: 'try again' }],
          },
        ],
      },
    );

    await expect(
      hook['tool.execute.before'](
        { tool: 'bash', callID: 'c2', sessionID: 's1' },
        { args: { command: 'gh pr merge 123' } },
      ),
    ).resolves.toBeUndefined();
  });
});
