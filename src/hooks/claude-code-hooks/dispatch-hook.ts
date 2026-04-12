import type { HookAction, HookResult } from './types';

export function getHookIdentifier(hook: HookAction): string {
  if (hook.type === 'http') return hook.url;
  return hook.command.split('/').pop() || hook.command;
}

async function executeHttpHook(
  hook: Extract<HookAction, { type: 'http' }>,
  stdinJson: string,
): Promise<HookResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), hook.timeout ?? 10_000);
  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(hook.headers ?? {}),
      },
      body: stdinJson,
      signal: controller.signal,
    });
    const stdout = await response.text();
    return {
      exitCode: response.ok ? 0 : 1,
      stdout,
      stderr: response.ok ? undefined : response.statusText,
    };
  } catch (error) {
    return { exitCode: 1, stderr: String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeCommandHook(
  command: string,
  stdinJson: string,
  cwd: string,
): Promise<HookResult> {
  const shell = '/bin/sh';
  const proc = Bun.spawn([shell, '-lc', command], {
    cwd,
    stdin: Buffer.from(stdinJson),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function dispatchHook(
  hook: HookAction,
  stdinJson: string,
  cwd: string,
): Promise<HookResult> {
  if (hook.type === 'http') {
    return executeHttpHook(hook, stdinJson);
  }
  return executeCommandHook(hook.command, stdinJson, cwd);
}
