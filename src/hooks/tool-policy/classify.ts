import { transformToolName } from '../claude-code-hooks/compat';
import type {
  ToolExecutionRequest,
  ToolPermissionRequest,
  ToolPolicyEvaluation,
} from './types';

const DENY_BASH_PATTERNS: Array<[RegExp, string, string]> = [
  [
    /\bgit\s+push\s+.*(?:--force\b|-f\b)/,
    'git-force-push',
    'Force push can destroy remote history.',
  ],
  [
    /\bgit\s+reset\s+--hard\b/,
    'git-hard-reset',
    'Hard reset discards uncommitted changes.',
  ],
  [
    /\bgit\s+clean\s+-[a-zA-Z]*f\b/,
    'git-clean-force',
    'Force clean permanently deletes untracked files.',
  ],
  [
    /\bgit\s+(?:checkout|restore)\s+\.\s*$/,
    'git-discard-all',
    'Discarding the whole working tree is destructive.',
  ],
  [
    /\bgit\s+(?:checkout(?:\s+HEAD)?|restore(?:\s+--source=\S+)?)\s+--\s+/,
    'git-discard-path',
    'Discarding tracked file changes is destructive.',
  ],
  [/\bgit\s+stash\b/, 'git-stash', 'Stashing disrupts shared coordination.'],
  [
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b|\brm\s+-rf\b/,
    'rm-rf',
    'Recursive forced removal is destructive.',
  ],
  [
    /\bchmod\s+(?:777|666|o\+w|a\+w|[24][0-7]{3})\b/,
    'chmod-unsafe',
    'Dangerous chmod mode detected.',
  ],
  [
    /\b(?:curl|wget)\s.*\|\s*(?:sh|bash|zsh|python|node|ruby|perl)\b/,
    'pipe-shell',
    'Piping downloaded content into a shell is unsafe.',
  ],
  [
    /\bcurl\s.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s|--upload|-T\s|-F\s|--form)(?!.*(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/,
    'curl-remote-write',
    'Remote curl write/upload may mutate or exfiltrate data.',
  ],
  [
    /\bcurl\s.*(?:-H.*[Aa]uthoriz|-H.*[Bb]earer|-H.*[Tt]oken|--header.*[Aa]uthoriz)(?!.*(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/,
    'curl-auth-remote',
    'Remote curl with auth headers may exfiltrate credentials.',
  ],
  [
    /\bwget\s+(?!.*(?:localhost|127\.0\.0\.1))/,
    'wget-remote',
    'Remote wget downloads arbitrary files.',
  ],
  [
    /\btar\s.*-[a-zA-Z]*x\b|\btar\s+x\b/,
    'tar-extract',
    'Archive extraction can overwrite files.',
  ],
  [
    /\bunzip\s+(?!-l\b)/,
    'unzip-extract',
    'Archive extraction can overwrite files.',
  ],
  [/^\s*eval\s/, 'eval', 'eval executes arbitrary code.'],
  [/^\s*exec\s/, 'exec', 'exec replaces the current process.'],
  [
    /^\s*env\s+\S+=/,
    'env-inline-command',
    'Inline env command execution is unsafe in this policy layer.',
  ],
  [/^\s*command\s/, 'command-bypass', 'command <x> bypasses tool policy.'],
  [
    /\b(?:kill\s+-9|killall)\b/,
    'force-kill',
    'Force-killing processes may terminate user workloads.',
  ],
];

const ASK_BASH_PATTERNS: Array<[RegExp, string, string]> = [
  [/\bgit\s+push\b/, 'git-push', 'Pushing writes shared remote state.'],
  [
    /\bgh\s+(?:pr|issue)\s+(?:create|close|merge|delete|comment|review|edit)\b/,
    'gh-shared-write',
    'GitHub CLI write operation affects shared state.',
  ],
  [
    /\bgh\s+repo\s+(?:create|delete|fork|rename)\b/,
    'gh-repo-write',
    'GitHub repository mutation affects shared state.',
  ],
  [
    /\bpip3?\s+install\b/,
    'pip-install',
    'Installing packages changes the environment.',
  ],
  [
    /\buv\s+pip\s+install\b/,
    'uv-pip-install',
    'Installing packages changes the environment.',
  ],
  [/\bnpx\s/, 'npx', 'npx downloads and executes registry packages.'],
  [
    /\bcargo\s+install\b/,
    'cargo-install',
    'Installing binaries changes the environment.',
  ],
  [
    /\b(?:npm|yarn|pnpm|bun)\s+(?:install|add)\s+[^-]/,
    'js-package-install',
    'Adding packages changes the environment.',
  ],
];

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractCommand(
  metadata?: Record<string, unknown>,
): string | undefined {
  if (!metadata) return undefined;

  for (const key of ['command', 'cmd', 'title'] as const) {
    const value = getString(metadata[key]);
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
    const nested = getRecord(metadata[key]);
    const command = getString(nested?.command);
    if (command) return command;
  }

  return undefined;
}

function classifyBashCommand(command: string): ToolPolicyEvaluation {
  for (const [pattern, category, reason] of DENY_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'deny', category, reason };
    }
  }

  for (const [pattern, category, reason] of ASK_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'ask', category, reason };
    }
  }

  return { decision: 'allow', category: 'safe-bash' };
}

export function classifyToolExecution(
  request: ToolExecutionRequest,
): ToolPolicyEvaluation {
  const toolName = request.tool.trim().toLowerCase();
  if (toolName !== 'bash') {
    return { decision: 'allow', category: 'safe-tool' };
  }

  const command = getString(request.args.command);
  if (!command) {
    return { decision: 'allow', category: 'safe-bash' };
  }

  return classifyBashCommand(command);
}

export function classifyPermissionRequest(
  request: ToolPermissionRequest,
): ToolPolicyEvaluation {
  const normalizedType = getString(request.type)?.toLowerCase();
  const normalizedTitle = getString(request.title)?.toLowerCase();
  const toolName = transformToolName(
    normalizedType ?? normalizedTitle ?? 'unknown',
  ).toLowerCase();
  if (toolName !== 'bash') {
    return { decision: 'allow', category: 'safe-permission' };
  }

  const command = extractCommand(request.metadata);
  if (!command) {
    return {
      decision: 'ask',
      category: 'bash-unknown',
      reason:
        'Bash permission request without command metadata should be reviewed.',
    };
  }

  return classifyBashCommand(command);
}
