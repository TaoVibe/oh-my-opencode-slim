import { transformToolName } from '../claude-code-hooks/compat';
import type {
  ToolExecutionRequest,
  ToolPermissionRequest,
  ToolPolicyEvaluation,
} from './types';

const LOCALHOST_PATTERN = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/;

const REPO_FRONTEND_INSTALL_PATTERN =
  /(?:^|&&|;)\s*cd\s+(?:\.\/)?(?:frontend|src\/clipper-frontend)\s*&&\s*npm\s+(?:install|ci)\b|\bnpm\s+--prefix\s+(?:\.\/)?(?:frontend|src\/clipper-frontend)\s+(?:install|ci)\b/;

const SAFE_ENV_COMMAND_PATTERN =
  /^\s*env\s+(?:\S+=\S+\s+)+(?:uv|pytest|ruff|pyright|npm|bun)\b(?!.*(?:&&|;|\|\|)).*$/;

const TAR_LIST_PATTERN = /\btar\s+(?:-[a-zA-Z]*t[a-zA-Z]*\b|t[a-zA-Z]*\b)/;

const SQLITE_WRITE_PATTERN =
  /\bsqlite3\s.*\b(?:drop|delete|update|insert|alter|replace|truncate)\b/i;

const ALLOW_BASH_PATTERNS: Array<[RegExp, string]> = [
  [
    /\bpip3?\s+install\b.*(?:-r\s|--requirement|-e\s+\.|--editable\b)/,
    'pip-install-safe',
  ],
  [
    /\buv\s+pip\s+install\b.*(?:-r\s|--requirement|-e\s+\.|--editable\b)/,
    'uv-pip-install-safe',
  ],
  [/\bunzip\s+-l\b/, 'unzip-list'],
  [TAR_LIST_PATTERN, 'tar-list'],
  [SAFE_ENV_COMMAND_PATTERN, 'env-safe-command'],
  [REPO_FRONTEND_INSTALL_PATTERN, 'repo-frontend-install'],
  [/\b(?:py-spy|memray|scalene)\b/, 'profiler'],
];

const DENY_BASH_PATTERNS: Array<[RegExp, string, string]> = [
  [
    /(?:^|\s)--no-verify(?:\s|$)/,
    'hook-bypass',
    'Bypassing hooks disables required safety checks.',
  ],
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
    /\bgit\s+branch\s+-D\s+(?:main|master)\b/,
    'git-delete-main-branch',
    'Force-deleting the main branch is unsafe.',
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
    /\bgit\s+rm\s+.*--cached.*(?:\.(?:claude|github|semgrep|semgrep-ci|husky|vscode|circleci)\b|Makefile\b|CLAUDE\.md\b|\.gitignore\b)/,
    'git-rm-cached-config',
    'Removing tracked config files from the index is unsafe.',
  ],
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
    SQLITE_WRITE_PATTERN,
    'sqlite-destructive-write',
    'Destructive sqlite3 writes should be reviewed explicitly.',
  ],
  [
    /\b(?:curl|wget)\s.*\|\s*(?:sh|bash|zsh|python|node|ruby|perl)\b/,
    'pipe-shell',
    'Piping downloaded content into a shell is unsafe.',
  ],
  [
    /\bcurl\s.*(?:-H.*[Aa]uthoriz|-H.*[Bb]earer|-H.*[Tt]oken|--header.*[Aa]uthoriz)(?!.*(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/,
    'curl-auth-remote',
    'Remote curl with auth headers may exfiltrate credentials.',
  ],
  [/^\s*eval\s/, 'eval', 'eval executes arbitrary code.'],
  [/^\s*exec\s/, 'exec', 'exec replaces the current process.'],
  [
    /^\s*env\s+\S+=/,
    'env-inline-command',
    'Inline env command execution is unsafe unless it wraps a known-safe tool.',
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
    /\bdocker\s+compose\s+down\b.*\s-v(?:\s|$)|\bdocker-compose\s+down\b.*\s-v(?:\s|$)/,
    'docker-compose-down-volume',
    'docker compose down -v removes local volumes and state.',
  ],
  [
    /\bcurl\s.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s|--upload|-T\s|-F\s|--form)/,
    'curl-remote-write',
    'Remote curl write/upload may mutate or exfiltrate data.',
  ],
  [/\bwget\s+/, 'wget-remote', 'Remote wget downloads arbitrary files.'],
  [
    /\btar\s.*(?:-[a-zA-Z]*x[a-zA-Z]*\b|\bx[a-zA-Z]*\b)/,
    'tar-extract',
    'Archive extraction can overwrite files.',
  ],
  [
    /\bunzip\s+(?!-l\b)/,
    'unzip-extract',
    'Archive extraction can overwrite files.',
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
  if (SAFE_ENV_COMMAND_PATTERN.test(command)) {
    return { decision: 'allow', category: 'env-safe-command' };
  }

  for (const [pattern, category, reason] of DENY_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'deny', category, reason };
    }
  }

  for (const [pattern, category] of ALLOW_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return { decision: 'allow', category };
    }
  }

  for (const [pattern, category, reason] of ASK_BASH_PATTERNS) {
    if (pattern.test(command)) {
      if (category === 'curl-remote-write' && LOCALHOST_PATTERN.test(command)) {
        return { decision: 'allow', category: 'curl-local-write' };
      }
      if (category === 'wget-remote' && LOCALHOST_PATTERN.test(command)) {
        return { decision: 'allow', category: 'wget-local' };
      }
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
