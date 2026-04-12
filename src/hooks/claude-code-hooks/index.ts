import type { PluginInput } from '@opencode-ai/plugin';
import { createInternalAgentTextPart } from '../../utils';
import { log } from '../../utils/logger';
import { objectToSnakeCase, transformToolName } from './compat';
import { loadClaudeHooksConfig } from './config';
import {
  isHookCommandDisabled,
  loadPluginExtendedConfig,
} from './config-loader';
import { dispatchHook, getHookIdentifier } from './dispatch-hook';
import { findMatchingHooks } from './pattern-matcher';
import type {
  ClaudeHookEvent,
  GenericSessionOutput,
  PluginExtendedConfig,
  PostToolUseOutput,
  PreToolUseOutput,
} from './types';

const USER_PROMPT_SUBMIT_TAG_OPEN = '<user-prompt-submit-hook>';
const USER_PROMPT_SUBMIT_TAG_CLOSE = '</user-prompt-submit-hook>';

interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

interface HookOptions {
  settingsPath?: string;
  extendedConfigPath?: string;
  dispatchHook?: typeof dispatchHook;
}

interface PreToolUseResolution {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

interface PermissionLike {
  id?: string;
  type?: string;
  title?: string;
  sessionID?: string;
  callID?: string;
  metadata?: Record<string, unknown>;
}

function isHookGloballyDisabled(
  disabledHooks: string[] | undefined,
  hookName: string,
): boolean {
  return disabledHooks?.includes(hookName) ?? false;
}

function buildUserPromptPayload(
  sessionId: string,
  prompt: string,
  cwd: string,
) {
  return {
    session_id: sessionId,
    cwd,
    permission_mode: 'bypassPermissions',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    session: { id: sessionId },
    hook_source: 'opencode-plugin',
  };
}

function extractTextOutput(output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function appendTaggedHookMessage(
  originalText: string,
  injected: string,
): string {
  const wrapped = injected.startsWith(USER_PROMPT_SUBMIT_TAG_OPEN)
    ? injected
    : `${USER_PROMPT_SUBMIT_TAG_OPEN}\n${injected}\n${USER_PROMPT_SUBMIT_TAG_CLOSE}`;
  return `${wrapped}\n\n---\n\n${originalText}`;
}

function getSessionIdFromDeletedEvent(
  event: Record<string, unknown>,
): string | undefined {
  const properties = event.properties as Record<string, unknown> | undefined;
  const info = properties?.info as Record<string, unknown> | undefined;
  return (
    (info?.id as string | undefined) ??
    (properties?.sessionID as string | undefined)
  );
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractPermissionToolInput(
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  if (!metadata) return {};

  const directCommand = getString(metadata.command) ?? getString(metadata.cmd);
  if (directCommand) {
    return { command: directCommand };
  }

  for (const key of [
    'args',
    'input',
    'toolInput',
    'tool_input',
    'toolArgs',
    'tool_args',
  ] as const) {
    const nested = getRecord(metadata[key]);
    if (nested) return nested;
  }

  return {};
}

function getPermissionToolName(permission: PermissionLike): string | undefined {
  const raw = permission.type ?? permission.title;
  return raw ? transformToolName(raw) : undefined;
}

function getPermissionCallId(permission: PermissionLike): string | undefined {
  return (
    permission.callID ??
    getString(permission.metadata?.callID) ??
    getString(permission.metadata?.call_id) ??
    getString(getRecord(permission.metadata?.tool)?.callID) ??
    getString(getRecord(permission.metadata?.tool)?.call_id)
  );
}

async function resolvePreToolUse(
  transformedToolName: string,
  toolInput: Record<string, unknown>,
  sessionID: string,
  callID: string,
  ctx: PluginInput,
  disabledHooks: string[] | undefined,
  options: HookOptions,
  permissionMode: string,
): Promise<PreToolUseResolution | null> {
  if (isHookGloballyDisabled(disabledHooks, 'claude-code-hooks')) {
    return null;
  }

  const hookDispatcher = options.dispatchHook ?? dispatchHook;
  const config = await loadClaudeHooksConfig(options.settingsPath);
  if (!config) return null;
  const matchers = findMatchingHooks(config, 'PreToolUse', transformedToolName);
  if (matchers.length === 0) return null;
  const extendedConfig = await loadPluginExtendedConfig(
    options.extendedConfigPath,
  );
  const payload = {
    session_id: sessionID,
    cwd: ctx.directory,
    permission_mode: permissionMode,
    hook_event_name: 'PreToolUse',
    tool_name: transformedToolName,
    tool_input: objectToSnakeCase(toolInput),
    tool_use_id: callID,
    hook_source: 'opencode-plugin',
  };
  const resolved: PreToolUseResolution = { decision: 'allow' };

  for (const matcher of matchers) {
    for (const hook of matcher.hooks ?? []) {
      const hookName = getHookIdentifier(hook);
      if (isHookCommandDisabled('PreToolUse', hookName, extendedConfig)) {
        continue;
      }

      const result = await hookDispatcher(
        hook,
        JSON.stringify(payload),
        ctx.directory,
      );
      if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout) as PreToolUseOutput;
          const decision =
            parsed.hookSpecificOutput?.permissionDecision ??
            (parsed.decision === 'approve'
              ? 'allow'
              : parsed.decision === 'block'
                ? 'deny'
                : parsed.decision);
          if (parsed.hookSpecificOutput?.updatedInput) {
            resolved.updatedInput = {
              ...(resolved.updatedInput ?? {}),
              ...parsed.hookSpecificOutput.updatedInput,
            };
          }
          if (decision === 'deny') {
            resolved.decision = 'deny';
            resolved.reason =
              parsed.hookSpecificOutput?.permissionDecisionReason ??
              parsed.reason ??
              'Hook blocked the operation';
            return resolved;
          }
          if (decision === 'ask') {
            resolved.decision = 'ask';
            resolved.reason =
              parsed.hookSpecificOutput?.permissionDecisionReason ??
              parsed.reason ??
              'Hook requested approval';
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }

      if (result.exitCode === 2) {
        return {
          decision: 'deny',
          reason:
            result.stderr || result.stdout || 'Hook blocked the operation',
          updatedInput: resolved.updatedInput,
        };
      }
    }
  }

  return resolved;
}

async function runHooks(
  eventType: ClaudeHookEvent,
  payload: Record<string, unknown>,
  cwd: string,
  options: HookOptions,
): Promise<
  Array<{
    stdout?: string;
    stderr?: string;
    exitCode: number;
    hookName: string;
  }>
> {
  const hookDispatcher = options.dispatchHook ?? dispatchHook;
  const config = await loadClaudeHooksConfig(options.settingsPath);
  if (!config) return [];
  const matchers = findMatchingHooks(config, eventType);
  if (matchers.length === 0) return [];
  const extendedConfig = await loadPluginExtendedConfig(
    options.extendedConfigPath,
  );
  const results: Array<{
    stdout?: string;
    stderr?: string;
    exitCode: number;
    hookName: string;
  }> = [];

  for (const matcher of matchers) {
    for (const hook of matcher.hooks ?? []) {
      const hookName = getHookIdentifier(hook);
      if (
        isHookCommandDisabled(
          eventType,
          hookName,
          extendedConfig as PluginExtendedConfig,
        )
      ) {
        continue;
      }
      const result = await hookDispatcher(hook, JSON.stringify(payload), cwd);
      results.push({ ...result, hookName });
    }
  }

  return results;
}

export function createClaudeCodeHooksHook(
  ctx: PluginInput,
  disabledHooks?: string[],
  options: HookOptions = {},
) {
  const childSessions = new Map<
    string,
    { parentID?: string; title?: string }
  >();
  const preToolUseCache = new Map<string, PreToolUseResolution>();

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      if (isHookGloballyDisabled(disabledHooks, 'claude-code-hooks')) {
        return;
      }

      const { messages } = output;
      let lastUserMessageIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === 'user') {
          lastUserMessageIndex = index;
          break;
        }
      }
      if (lastUserMessageIndex === -1) return;

      const lastUserMessage = messages[lastUserMessageIndex];
      if (
        lastUserMessage.info.agent &&
        lastUserMessage.info.agent !== 'orchestrator'
      ) {
        return;
      }

      const textPartIndex = lastUserMessage.parts.findIndex(
        (part) => part.type === 'text' && typeof part.text === 'string',
      );
      if (textPartIndex === -1) return;

      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      if (originalText.includes(USER_PROMPT_SUBMIT_TAG_OPEN)) {
        return;
      }

      const sessionId = lastUserMessage.info.sessionID;
      if (!sessionId) return;

      const results = await runHooks(
        'UserPromptSubmit',
        buildUserPromptPayload(sessionId, originalText, ctx.directory),
        ctx.directory,
        options,
      );

      const injections: string[] = [];
      for (const result of results) {
        const text = extractTextOutput(result.stdout ?? '');
        if (text) {
          injections.push(text);
        }
      }

      if (injections.length > 0) {
        lastUserMessage.parts[textPartIndex].text = appendTaggedHookMessage(
          originalText,
          injections.join('\n\n'),
        );
      }
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const transformedToolName = transformToolName(input.tool);
      const cachedResolution = preToolUseCache.get(input.callID);
      preToolUseCache.delete(input.callID);

      const resolution =
        cachedResolution ??
        (await resolvePreToolUse(
          transformedToolName,
          output.args,
          input.sessionID,
          input.callID,
          ctx,
          disabledHooks,
          options,
          'bypassPermissions',
        ));
      if (!resolution) {
        return;
      }

      if (resolution.updatedInput) {
        Object.assign(output.args, resolution.updatedInput);
      }
      if (resolution.decision === 'deny') {
        throw new Error(resolution.reason ?? 'Hook blocked the operation');
      }
      if (resolution.decision === 'ask' && !cachedResolution) {
        throw new Error(resolution.reason ?? 'Hook requested approval');
      }
    },

    'permission.ask': async (
      input: PermissionLike,
      output: { status: 'ask' | 'deny' | 'allow' },
    ): Promise<void> => {
      const transformedToolName = getPermissionToolName(input);
      const sessionID = input.sessionID;
      const callID = getPermissionCallId(input);
      if (!transformedToolName || !sessionID || !callID) {
        return;
      }

      const resolution = await resolvePreToolUse(
        transformedToolName,
        extractPermissionToolInput(input.metadata),
        sessionID,
        callID,
        ctx,
        disabledHooks,
        options,
        'ask',
      );
      if (!resolution) return;

      preToolUseCache.set(callID, resolution);
      if (resolution.decision === 'deny') {
        output.status = 'deny';
        return;
      }
      if (resolution.decision === 'ask') {
        output.status = 'ask';
        return;
      }
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: unknown; metadata: unknown },
    ): Promise<void> => {
      if (isHookGloballyDisabled(disabledHooks, 'claude-code-hooks')) {
        return;
      }

      const hookDispatcher = options.dispatchHook ?? dispatchHook;

      const config = await loadClaudeHooksConfig(options.settingsPath);
      if (!config) return;
      const transformedToolName = transformToolName(input.tool);
      const matchers = findMatchingHooks(
        config,
        'PostToolUse',
        transformedToolName,
      );
      if (matchers.length === 0) return;
      const extendedConfig = await loadPluginExtendedConfig(
        options.extendedConfigPath,
      );

      const payload = {
        session_id: input.sessionID,
        cwd: ctx.directory,
        permission_mode: 'bypassPermissions',
        hook_event_name: 'PostToolUse',
        tool_name: transformedToolName,
        tool_input: {},
        tool_response: objectToSnakeCase({
          title: output.title,
          output:
            typeof output.output === 'string'
              ? output.output
              : JSON.stringify(output.output),
          metadata:
            typeof output.metadata === 'object' && output.metadata !== null
              ? output.metadata
              : {},
        }),
        tool_use_id: input.callID,
        hook_source: 'opencode-plugin',
      };

      const additions: string[] = [];
      for (const matcher of matchers) {
        for (const hook of matcher.hooks ?? []) {
          const hookName = getHookIdentifier(hook);
          if (isHookCommandDisabled('PostToolUse', hookName, extendedConfig)) {
            continue;
          }

          const result = await hookDispatcher(
            hook,
            JSON.stringify(payload),
            ctx.directory,
          );
          if (!result.stdout) continue;

          try {
            const parsed = JSON.parse(result.stdout) as PostToolUseOutput;
            if (parsed.decision === 'block') {
              ctx.client.tui
                .showToast({
                  body: {
                    title: 'PostToolUse Hook Warning',
                    message: parsed.reason ?? 'Hook returned warning',
                    variant: 'warning',
                    duration: 4000,
                  },
                })
                .catch(() => {});
            }
            if (parsed.hookSpecificOutput?.additionalContext) {
              additions.push(parsed.hookSpecificOutput.additionalContext);
            }
            if (parsed.systemMessage) {
              additions.push(parsed.systemMessage);
            }
          } catch {
            const text = extractTextOutput(result.stdout);
            if (text) additions.push(text);
          }
        }
      }

      if (additions.length > 0) {
        const base =
          typeof output.output === 'string'
            ? output.output
            : JSON.stringify(output.output);
        output.output = `${base}\n\n${additions.join('\n\n')}`;
      }
    },

    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      if (isHookGloballyDisabled(disabledHooks, 'claude-code-hooks')) {
        return;
      }

      const event = input.event;
      if (event.type === 'session.created') {
        const info = event.properties?.info as
          | { id?: string; parentID?: string; title?: string }
          | undefined;
        if (!info?.id) return;

        const isSubagent = Boolean(info.parentID);
        const eventType: ClaudeHookEvent = isSubagent
          ? 'SubagentStart'
          : 'SessionStart';
        if (isSubagent) {
          childSessions.set(info.id, {
            parentID: info.parentID,
            title: info.title,
          });
        }

        const results = await runHooks(
          eventType,
          {
            session_id: info.id,
            parent_session_id: info.parentID,
            cwd: ctx.directory,
            hook_event_name: eventType,
            title: info.title,
            hook_source: 'opencode-plugin',
          },
          ctx.directory,
          options,
        );

        const prompt = results
          .map((result) => {
            try {
              const parsed = JSON.parse(
                result.stdout ?? '',
              ) as GenericSessionOutput;
              return (
                parsed.inject_prompt ?? parsed.systemMessage ?? parsed.reason
              );
            } catch {
              return extractTextOutput(result.stdout ?? '');
            }
          })
          .filter((value): value is string => Boolean(value))
          .join('\n\n');

        if (prompt) {
          await ctx.client.session.prompt({
            path: { id: info.id },
            body: { parts: [createInternalAgentTextPart(prompt)] },
            query: { directory: ctx.directory },
          });
        }
        return;
      }

      if (event.type === 'session.deleted') {
        const sessionId = getSessionIdFromDeletedEvent(
          event as Record<string, unknown>,
        );
        if (!sessionId) return;
        if (!childSessions.has(sessionId)) return;

        const child = childSessions.get(sessionId);
        childSessions.delete(sessionId);
        await runHooks(
          'SubagentStop',
          {
            session_id: sessionId,
            parent_session_id: child?.parentID,
            cwd: ctx.directory,
            hook_event_name: 'SubagentStop',
            title: child?.title,
            hook_source: 'opencode-plugin',
          },
          ctx.directory,
          options,
        );
        log('[claude-code-hooks] handled SubagentStop', { sessionId });
      }
    },
  };
}
