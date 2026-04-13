import type { PluginInput } from '@opencode-ai/plugin';
import { classifyPermissionRequest, classifyToolExecution } from './classify';
import type {
  ToolExecutionAuthorization,
  ToolPermissionRequest,
  ToolPolicyEvaluation,
} from './types';

/** Bash command patterns from opencode.json permission config that should bypass ask prompts */
export type BashPermissionPatterns = {
  /** Commands that are explicitly allowed (bypass ask) */
  allow: string[];
  /** Commands that are explicitly denied */
  deny: string[];
};

/**
 * Convert glob-style permission patterns to regex for fast matching.
 * Supports: exact match, wildcard (*) at end, or specific patterns.
 */
function buildPermissionRegex(patterns: string[]): RegExp | null {
  if (patterns.length === 0) return null;

  // Build a regex that matches any of the patterns
  // Supports: "pyright *", "echo foo", "git push --force" (exact), "rm -rf *" (wildcard)
  const regexParts = patterns.map((pattern) => {
    // Escape special regex chars except *
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // Replace * with regex .* for word boundary matching
    // "pyright *" -> ^pyright\b -> matches "pyright foo" but not "pyrightbar"
    // Handle trailing wildcard: "pyright *" -> ^pyright\s
    if (escaped.endsWith('\\ *')) {
      return '^' + escaped.slice(0, -3) + '\\b';
    }
    // Handle mid-pattern wildcards like "git *" -> ^git\b
    if (escaped.includes('\\ *')) {
      return '^' + escaped.replace(/\\ \*/g, '\\b.*');
    }
    // Exact match
    return '^' + escaped + '$';
  });

  return new RegExp(regexParts.join('|'), 'i');
}

/** Check if a bash command matches any config-allowed pattern */
function matchesAllowedPattern(
  command: string,
  allowPatterns: BashPermissionPatterns,
): boolean {
  const regex = buildPermissionRegex(allowPatterns.allow);
  if (!regex) return false;
  return regex.test(command);
}

interface ToolPolicyMetadata {
  toolPolicy?: ToolPolicyEvaluation;
  [key: string]: unknown;
}

interface PendingBlockedCommand {
  command: string;
  evaluation: ToolPolicyEvaluation;
  expiresAt: number;
}

interface ApprovedOverride {
  command: string;
  expiresAt: number;
}

interface ApprovedIntent {
  category: string;
  expiresAt: number;
}

const OVERRIDE_TTL_MS = 5 * 60 * 1000;
const AUTHORIZATION_ARG_KEY = '__toolPolicyAuthorization';
const EXPLICIT_OVERRIDE_PATTERN =
  /\b(proceed|override|go ahead|run it|do it|push it|proceed anyway|override it)\b/i;
const NATURAL_RETRY_PATTERN =
  /\b(?:try|run|do|push|retry)(?:\s+it)?\s+again\b/i;

function getCallId(input: ToolPermissionRequest): string | undefined {
  const metadata = input.metadata;
  const tool =
    typeof metadata?.tool === 'object' && metadata.tool !== null
      ? (metadata.tool as Record<string, unknown>)
      : undefined;

  return (
    (typeof (input as { callID?: unknown }).callID === 'string'
      ? (input as { callID?: string }).callID
      : undefined) ??
    (typeof metadata?.callID === 'string' ? metadata.callID : undefined) ??
    (typeof metadata?.call_id === 'string' ? metadata.call_id : undefined) ??
    (typeof tool?.callID === 'string' ? tool.callID : undefined) ??
    (typeof tool?.call_id === 'string' ? tool.call_id : undefined)
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

function extractCommandFromContainer(
  container?: Record<string, unknown>,
): string | undefined {
  if (!container) return undefined;

  for (const key of ['command', 'cmd', 'title'] as const) {
    const value = getString(container[key]);
    if (value) return value;
  }

  for (const key of [
    'args',
    'input',
    'toolInput',
    'tool_input',
    'toolArgs',
    'tool_args',
  ] as const) {
    const nested = getRecord(container[key]);
    const command = getString(nested?.command);
    if (command) return command;
  }

  return undefined;
}

function isOverrideFresh(expiresAt: number): boolean {
  return Date.now() <= expiresAt;
}

function buildOverrideEvaluation(
  evaluation: ToolPolicyEvaluation,
): ToolPolicyEvaluation {
  return {
    decision: 'allow',
    category: `user-override:${evaluation.category}`,
    reason: evaluation.reason,
  };
}

function isExplicitOverrideIntent(text: string): boolean {
  return (
    EXPLICIT_OVERRIDE_PATTERN.test(text) || NATURAL_RETRY_PATTERN.test(text)
  );
}

function getAuthorizationRecord(
  value: unknown,
): ToolExecutionAuthorization | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.scope !== 'git-push') {
    return undefined;
  }

  if (
    'sessionID' in candidate &&
    candidate.sessionID !== undefined &&
    typeof candidate.sessionID !== 'string'
  ) {
    return undefined;
  }

  if (
    'expiresAt' in candidate &&
    candidate.expiresAt !== undefined &&
    typeof candidate.expiresAt !== 'number'
  ) {
    return undefined;
  }

  return {
    scope: 'git-push',
    sessionID:
      typeof candidate.sessionID === 'string' ? candidate.sessionID : undefined,
    expiresAt:
      typeof candidate.expiresAt === 'number' ? candidate.expiresAt : undefined,
  };
}

function authorizationMatchesEvaluation(
  authorization: ToolExecutionAuthorization,
  evaluation: ToolPolicyEvaluation,
  sessionID?: string,
): boolean {
  if (authorization.scope !== 'git-push' || evaluation.category !== 'git-push') {
    return false;
  }

  if (authorization.sessionID && sessionID && authorization.sessionID !== sessionID) {
    return false;
  }

  if (
    typeof authorization.expiresAt === 'number' &&
    !isOverrideFresh(authorization.expiresAt)
  ) {
    return false;
  }

  return true;
}

function detectApprovedIntentCategory(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (/\bgit push\b/.test(normalized)) {
    return 'git-push';
  }

  if (/\bpush\b/.test(normalized)) {
    return 'git-push';
  }

  return undefined;
}

export interface ToolPolicyOptions {
  /** Bash permission patterns from opencode.json config */
  bashPermissions?: BashPermissionPatterns;
}

export function createToolPolicyHook(
  _ctx: PluginInput,
  options: ToolPolicyOptions = {},
) {
  const evaluations = new Map<string, ToolPolicyEvaluation>();
  const approvedAsks = new Map<string, ToolPolicyEvaluation>();
  const pendingBlockedBySession = new Map<string, PendingBlockedCommand>();
  const approvedOverrideBySession = new Map<string, ApprovedOverride>();
  const approvedGlobalOverrideByCommand = new Map<string, number>();
  const approvedIntentBySession = new Map<string, ApprovedIntent>();

  function consumeGlobalOverride(command: string): boolean {
    const expiresAt = approvedGlobalOverrideByCommand.get(command);
    if (!expiresAt) return false;
    approvedGlobalOverrideByCommand.delete(command);
    return isOverrideFresh(expiresAt);
  }

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: {
        messages: Array<{
          info: { role: string; sessionID?: string; agent?: string };
          parts: Array<{ type: string; text?: string }>;
        }>;
      },
    ): Promise<void> => {
      const { messages } = output;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role !== 'user') continue;
        if (message.info.agent && message.info.agent !== 'orchestrator') return;

        const sessionID = message.info.sessionID;
        if (!sessionID) return;

        const text = message.parts
          .filter(
            (part) => part.type === 'text' && typeof part.text === 'string',
          )
          .map((part) => part.text ?? '')
          .join('\n');
        const approvedIntentCategory = detectApprovedIntentCategory(text);
        if (approvedIntentCategory) {
          approvedIntentBySession.set(sessionID, {
            category: approvedIntentCategory,
            expiresAt: Date.now() + OVERRIDE_TTL_MS,
          });
        }

        const pending = pendingBlockedBySession.get(sessionID);
        if (!pending || !isOverrideFresh(pending.expiresAt)) {
          pendingBlockedBySession.delete(sessionID);
          return;
        }

        if (!isExplicitOverrideIntent(text)) {
          return;
        }

        approvedOverrideBySession.set(sessionID, {
          command: pending.command,
          expiresAt: Date.now() + OVERRIDE_TTL_MS,
        });
        approvedGlobalOverrideByCommand.set(
          pending.command,
          Date.now() + OVERRIDE_TTL_MS,
        );
        pendingBlockedBySession.delete(sessionID);
        return;
      }
    },

    'permission.ask': async (
      input: ToolPermissionRequest,
      output: { status: 'ask' | 'deny' | 'allow' },
    ): Promise<void> => {
      const callID = getCallId(input);
      const command = extractCommandFromContainer(input.metadata);

      // Pre-check: if command matches a config-allowed pattern, bypass ask immediately
      // This respects opencode.json permission.allow patterns
      if (command && options.bashPermissions) {
        if (matchesAllowedPattern(command, options.bashPermissions)) {
          if (callID) {
            approvedAsks.set(callID, {
              decision: 'allow',
              category: 'config-allowed',
            });
          }
          output.status = 'allow';
          return;
        }
      }

      const evaluation = classifyPermissionRequest(input);
      const sessionID = input.sessionID;
      if (sessionID) {
        const approvedIntent = approvedIntentBySession.get(sessionID);
        if (
          approvedIntent &&
          isOverrideFresh(approvedIntent.expiresAt) &&
          approvedIntent.category === evaluation.category
        ) {
          approvedIntentBySession.delete(sessionID);
          if (callID) {
            approvedAsks.set(callID, buildOverrideEvaluation(evaluation));
          }
          output.status = 'allow';
          return;
        }
      }
      if (sessionID && command) {
        const override = approvedOverrideBySession.get(sessionID);
        if (
          override &&
          isOverrideFresh(override.expiresAt) &&
          override.command === command
        ) {
          approvedOverrideBySession.delete(sessionID);
          if (callID) {
            approvedAsks.set(callID, buildOverrideEvaluation(evaluation));
          }
          output.status = 'allow';
          return;
        }
      }
      if (command && consumeGlobalOverride(command)) {
        if (callID) {
          approvedAsks.set(callID, buildOverrideEvaluation(evaluation));
        }
        output.status = 'allow';
        return;
      }

      if (sessionID && command && evaluation.decision !== 'allow') {
        pendingBlockedBySession.set(sessionID, {
          command,
          evaluation,
          expiresAt: Date.now() + OVERRIDE_TTL_MS,
        });
      }
      if (evaluation.decision === 'deny') {
        output.status = 'deny';
        return;
      }

      if (evaluation.decision === 'ask') {
        output.status = 'ask';
        if (callID) {
          approvedAsks.set(callID, evaluation);
        }
      }
    },

    'tool.execute.before': async (
      input: { tool: string; callID: string; sessionID?: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const approvedAsk = approvedAsks.get(input.callID);
      if (approvedAsk) {
        approvedAsks.delete(input.callID);
        evaluations.set(input.callID, approvedAsk);
        return;
      }

      const command = getString(output.args.command);
      const evaluation = classifyToolExecution({
        tool: input.tool,
        args: output.args,
      });
      const authorization = getAuthorizationRecord(
        output.args[AUTHORIZATION_ARG_KEY],
      );
      if (AUTHORIZATION_ARG_KEY in output.args) {
        delete output.args[AUTHORIZATION_ARG_KEY];
      }

      if (
        authorization &&
        authorizationMatchesEvaluation(
          authorization,
          evaluation,
          input.sessionID,
        )
      ) {
        evaluations.set(input.callID, buildOverrideEvaluation(evaluation));
        return;
      }

      if (input.sessionID) {
        const approvedIntent = approvedIntentBySession.get(input.sessionID);
        if (
          approvedIntent &&
          isOverrideFresh(approvedIntent.expiresAt) &&
          approvedIntent.category === evaluation.category
        ) {
          approvedIntentBySession.delete(input.sessionID);
          evaluations.set(input.callID, buildOverrideEvaluation(evaluation));
          return;
        }
      }

      if (command && consumeGlobalOverride(command)) {
        evaluations.set(input.callID, buildOverrideEvaluation(evaluation));
        return;
      }

      if (input.sessionID && command) {
        const override = approvedOverrideBySession.get(input.sessionID);
        if (
          override &&
          isOverrideFresh(override.expiresAt) &&
          override.command === command
        ) {
          approvedOverrideBySession.delete(input.sessionID);
          const evaluation = classifyToolExecution({
            tool: input.tool,
            args: output.args,
          });
          evaluations.set(input.callID, buildOverrideEvaluation(evaluation));
          return;
        }
      }

      evaluations.set(input.callID, evaluation);
      if (input.sessionID && command && evaluation.decision !== 'allow') {
        pendingBlockedBySession.set(input.sessionID, {
          command,
          evaluation,
          expiresAt: Date.now() + OVERRIDE_TTL_MS,
        });
      }
      if (evaluation.decision === 'deny') {
        throw new Error(
          evaluation.reason ?? 'Native tool policy blocked the operation',
        );
      }
      if (evaluation.decision === 'ask') {
        throw new Error(
          evaluation.reason ??
            'Approval required, but no native permission gate was triggered.',
        );
      }
    },

    'tool.execute.after': async (
      input: { callID: string },
      output: { metadata: unknown },
    ): Promise<void> => {
      const evaluation = evaluations.get(input.callID);
      evaluations.delete(input.callID);
      if (!evaluation) return;

      const metadata: ToolPolicyMetadata =
        typeof output.metadata === 'object' && output.metadata !== null
          ? (output.metadata as ToolPolicyMetadata)
          : {};
      metadata.toolPolicy = evaluation;
      output.metadata = metadata;
    },
  };
}
