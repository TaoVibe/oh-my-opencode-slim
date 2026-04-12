export type ClaudeHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SubagentStart'
  | 'SubagentStop';

export interface HookCommand {
  type: 'command';
  command: string;
}

export interface HookHttp {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
}

export type HookAction = HookCommand | HookHttp;

export interface HookMatcher {
  matcher: string;
  hooks: HookAction[];
}

export interface ClaudeHooksConfig {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
  SessionStart?: HookMatcher[];
  SubagentStart?: HookMatcher[];
  SubagentStop?: HookMatcher[];
}

export interface HookResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface HookCommonOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
}

export interface PreToolUseOutput extends HookCommonOutput {
  decision?: 'allow' | 'deny' | 'approve' | 'block' | 'ask';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export interface PostToolUseOutput extends HookCommonOutput {
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
  };
}

export interface GenericSessionOutput extends HookCommonOutput {
  decision?: 'block';
  reason?: string;
  inject_prompt?: string;
}

export interface PluginExtendedConfig {
  disabledHooks?: Partial<Record<ClaudeHookEvent, string[]>>;
}
