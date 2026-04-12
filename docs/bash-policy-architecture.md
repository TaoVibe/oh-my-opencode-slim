# Bash Policy Architecture

This document explains how Bash command safety works in the slim fork, how it maps Claude behavior into OpenCode, and how future agent sessions should extend it safely.

## Goals

- preserve Claude-style destructive-command protection
- support real OpenCode `permission.ask` flow when available
- keep safe repo workflows autonomous
- fail closed when the runtime does not emit a native permission prompt

## Main files

- `src/hooks/tool-policy/classify.ts`
  - pure classification logic for Bash commands
- `src/hooks/tool-policy/index.ts`
  - runtime hook glue for `permission.ask`, `tool.execute.before`, `tool.execute.after`
- `src/hooks/claude-code-hooks/index.ts`
  - Claude-compatible hook mapping (`PreToolUse`, `PostToolUse`, etc.)
- `src/index.ts`
  - lifecycle wiring and precedence order
- `~/.claude/hooks/block-destructive.sh`
  - Claude parity reference for destructive behavior

## Runtime flow

### 1. Native policy classification

`classify.ts` assigns Bash commands to one of:

- `allow`
- `ask`
- `deny`

Important categories:

- **deny**: irreversible / exfiltration / wrapper-bypass / hook-bypass
- **ask**: shared-state writes, remote downloads, risky extraction, package-add flows
- **allow**: explicitly safe repo workflows and local verification commands

### 2. Native permission path

`src/hooks/tool-policy/index.ts`

- `permission.ask`
  - classifies the requested Bash command
  - caches `ask` approvals by `callID`
- `tool.execute.before`
  - re-checks classification before execution
  - allows cached approved asks to proceed
  - blocks uncached `ask` commands instead of silently allowing them
- `tool.execute.after`
  - records policy metadata on the tool result

## Precedence model

Current effective order:

1. native tool-policy preflight
2. native `permission.ask` when OpenCode emits it
3. Claude-compatible `PreToolUse`
4. tool execution
5. Claude-compatible `PostToolUse`
6. native post-tool metadata tagging

### Important safety rule

If OpenCode does **not** emit a native permission request for an `ask`-class Bash command, `tool.execute.before` blocks it with an approval-needed error.

This prevents `ask` from degrading into accidental `allow`.

## Explicit user override flow

The native policy now supports a narrow, one-shot override path for the exact previously blocked Bash command.

### How it works

1. a Bash command is blocked or classified as `ask`
2. the plugin stores the exact command string for that session for a short TTL
3. the user sends an explicit follow-up like `proceed`, `override`, `go ahead`, `push again`, `try again`, or similar
4. the **next exact same command** in that same session is allowed once
5. the override is consumed immediately

### Guardrails

- session-scoped only
- exact-command match only
- one-shot only
- short-lived TTL
- does **not** grant a wildcard permission to future commands
- does **not** override a different command in the same session

### Why this exists

This allows a user to explicitly proceed after seeing a block warning without weakening the default policy into a broad allowlist.

### What future sessions should preserve

If you edit this flow, keep all of these properties:

- exact command match
- one-shot consumption
- explicit user confirmation phrase
- session scoping
- tests for both "same command allowed" and "different command still blocked"

## Native ask mode

If you want broad native OpenCode approval prompts for Bash, enable:

```jsonc
{
  "featureFlags": {
    "nativeBashAskAll": true
  }
}
```

This shapes core permission config to `bash: "ask"` unless the user already set a Bash permission explicitly.

## Classification order inside `classify.ts`

The order matters.

### Current order

1. narrow safe `env ...` commands
2. contextual allows (cwd-aware frontend installs, etc.)
3. deny patterns
4. contextual ask/deny (repo-path-aware extraction/downloads)
5. static allow patterns
6. ask patterns
7. fallback `allow`

### Why this order exists

- contextual safe cases should not be overblocked
- deny must beat generic allow/ask
- contextual repo-path decisions need the command + cwd together
- ask remains the catch-all for risky-but-legitimate operations

## How to add a new rule

Always decide first whether the command belongs in:

- `DENY_BASH_PATTERNS`
- `ASK_BASH_PATTERNS`
- `ALLOW_BASH_PATTERNS`
- contextual helpers

### Add to `DENY_BASH_PATTERNS` when

- the command is destructive or hard to reverse
- it bypasses safety hooks or policy (`--no-verify`, inline wrappers)
- it can exfiltrate credentials or mutate shared state dangerously
- Claude already blocks it and we want parity

Examples:

- `git push --force`
- `git reset --hard`
- `bash -c ...`
- `python -c ...`
- remote `curl` with auth headers

### Add to `ASK_BASH_PATTERNS` when

- the command is legitimate but changes shared state
- the command downloads/extracts data but may be safe with review
- the command installs packages or mutates environment in expected workflows

Examples:

- `git push`
- `gh pr review ...`
- generic `bunx ...`
- remote `curl -X POST ...`

### Add to `ALLOW_BASH_PATTERNS` when

- the command is broadly safe and common
- it does not create a wrapper bypass
- it does not silently broaden into arbitrary execution

Examples:

- `uv pip install -e .`
- `pip install -r requirements.txt`
- `bunx biome ...`
- `tar -t...`
- `unzip -l ...`

### Use contextual helpers when

- safety depends on `cwd`
- safety depends on target path
- the same command should be allow in one place, ask/deny in another

Current contextual helpers:

- frontend `npm install|ci` based on working directory
- archive extraction based on target path
- remote download handling based on repo-scoped target path

## How to add a new permission/bypass exception safely

### For a safe exception

1. start from the narrowest possible exact command shape
2. avoid wrapper forms (`bash -c`, `python -c`, generic `env ...`)
3. block command separators (`&&`, `;`, `||`, `|`) unless truly intended
4. prefer contextual helpers over giant regexes when cwd/path matters
5. add one allow test and one nearby abuse test

Example pattern:

- good: allow `bunx biome ...`
- bad: allow generic `bunx ...`

### For a new deny/bypass rule

1. compare against Claude's `block-destructive.sh`
2. prefer explicit `deny` over clever `ask`
3. test the exact exploit shape
4. add one regression for a disguised form if applicable

Examples of disguised forms to test:

- quoted paths
- `workdir`-dependent variants
- command substitution / pipe chaining
- wrapper commands

## Required tests for future changes

When editing `classify.ts`, update `src/hooks/tool-policy/index.test.ts`.

At minimum add:

- one direct classification test for the new command
- one abuse / bypass test
- one permission/runtime-path test if behavior depends on `permission.ask`

Then run:

```bash
bunx biome check --write src/hooks/tool-policy/classify.ts src/hooks/tool-policy/index.test.ts
bun test src/hooks/tool-policy/index.test.ts src/hooks/claude-code-hooks/index.test.ts
bun run typecheck
bun run build:fast
```

## Future agent session checklist

Before changing Bash policy:

1. read this file
2. compare against `~/.claude/hooks/block-destructive.sh`
3. identify whether the desired behavior is `allow`, `ask`, or `deny`
4. decide whether the rule is static or contextual
5. add/adjust tests first or alongside the change
6. run targeted verification
7. do at least one live `opencode run` smoke test for the changed path

## Current non-goals

These are intentionally still conservative:

- generic wrapper execution
- generic `bunx`
- broad remote downloads
- broad archive extraction outside repo-scoped temp/fixture targets

That conservatism is preferred over a permissive false negative.
