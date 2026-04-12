# Local Fork Setup

This fork is intended for local OpenCode testing with the `feature/category-routing`
 branch.

## What this fork adds

- category-based routing for `task(...)`
- `delegate_task` support in the slim plugin
- `task(category="planning")` style routing similar to the full package
- custom agent routing for Prometheus / Momus integration

## Prerequisites

Install these first:

- [Bun](https://bun.sh/) (required for build, test, and dev scripts)
- [OpenCode](https://github.com/sst/opencode) installed and working
- Git
- A configured OpenCode environment in `~/.config/opencode/`

Optional but useful:

- `gh` for GitHub workflows
- `tmux` if you use background task panes

## Clone the fork

```bash
cd ~/.config/opencode
git clone git@github.com:TaoVibe/oh-my-opencode-slim.git oh-my-opencode-slim-fork
cd oh-my-opencode-slim-fork
git checkout feature/category-routing
```

## Install dependencies

```bash
bun install
```

This repo uses dependencies from `package.json`, including:

- runtime: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`, `jsdom`, `which`, `vscode-jsonrpc`, `vscode-languageserver-protocol`, `@ast-grep/cli`
- dev/build: `typescript`, `@biomejs/biome`, `bun-types`, `@types/node`

## Build the plugin

Recommended:

```bash
bun run build
```

That builds:

- `dist/index.js`
- `dist/cli/index.js`
- declaration files
- JSON schema

Minimal rebuild if you only need the plugin entrypoints:

```bash
bun build src/index.ts --outdir dist --target bun --format esm --packages external
bun build src/cli/index.ts --outdir dist/cli --target bun --format esm --packages external
```

## Point OpenCode at the local fork

Edit `~/.config/opencode/opencode.json` and set:

```json
{
  "plugin": [
    "@opencode-ai/plugin",
    "file:///Users/mdoan/.config/opencode/oh-my-opencode-slim-fork"
  ]
}
```

If you already have other plugin config, keep it intact and only swap the slim package entry.

## Restart OpenCode

Restart the OpenCode process/app after changing the plugin path.

## Verify the fork is active

Run a smoke test:

```text
task(
  category="planning",
  load_skills=[],
  run_in_background=false,
  description="category smoke test",
  prompt="Reply with the single word PONG."
)
```

Expected behavior:

- `task` is handled by the forked slim plugin
- category routing resolves `planning` to the configured planning agent
- the task returns a task id or direct result
- the delegated agent responds with `PONG`

## Other useful checks

Backward compatibility:

```text
task(
  subagent_type="explorer",
  load_skills=[],
  run_in_background=false,
  description="compat test",
  prompt="Reply with DONE."
)
```

Invalid category path:

```text
task(
  category="not-a-real-category",
  load_skills=[],
  run_in_background=false,
  description="invalid category test",
  prompt="Reply with DONE."
)
```


## Session-model smoke tests

After restart, you can verify both orchestrator and delegated-session behavior:

```text
observability_status()
session_agent_model(agent="explorer", model="openai/gpt-5.4-mini")
task(subagent_type="explorer", prompt="Reply with PASS")
session_agent_model(clear_all=true)
```

Expected behavior:

- `observability_status` shows current runtime tasks, effective models, fallback chains, and current session overrides
- `session_agent_model` affects only future delegated launches from the current parent session
- profile files remain unchanged
- clearing overrides restores normal per-profile behavior

## Development loop

After code changes during local iteration:

```bash
bun run build:fast
bun run typecheck
bun run check:ci
bun test
```

Before pushing or publishing, also run a full build:

```bash
bun run build
```

Then restart OpenCode and re-run the smoke tests.

Recommended fast validation for routing/session changes:

```bash
bun test src/background/background-manager.test.ts src/utils/internal-initiator.test.ts src/hooks/chat-headers.test.ts src/hooks/phase-reminder/index.test.ts
bun run build:fast
```

## Troubleshooting

### Background review/research agent fails with `Empty response from provider`

If `momus`, `oracle`, or another delegated agent appears to fail immediately while a later fallback model still seems to run, check the fork version first.

This fork now includes a fix for a background-task startup race:

- `session.status=idle` events are ignored while startup/fallback is still in progress
- successful fallback attempts complete directly from extracted prompt output
- internal task notifications use an invisible sentinel instead of a visible HTML comment marker

If you still see the old behavior:

1. rebuild the fork with `bun run build:fast`
2. fully restart the OpenCode app/session (`qde` or `qdw`)
3. re-run the delegated review/research task in a fresh session

### `<!-- SLIM_INTERNAL_INITIATOR -->` appears in the chat transcript

That means OpenCode is still running an older build of the fork.

Fix:

```bash
cd ~/.config/opencode/oh-my-opencode-slim-fork
bun run build:fast
```

Then restart OpenCode. The current fork uses an invisible marker, so the raw comment should no longer render in the UI.

### qde vs qdw routing model confusion

Both `qde` and `qdw` use the same local fork plugin. The difference is only the active profile/model stack:

- `qde` → `oh-my-opencode-slim.glm.jsonc`
- `qdw` → `oh-my-opencode-slim.free.jsonc`

Primary model routing comes from the active profile's `agents.<name>.model`.
Fallback chains (`fallback.chains.<name>`) are only used after the primary attempt fails/times out/returns empty.

### qde/qdw show default OpenCode behavior even though `qds` shows the fork

If `qds` says the local fork is active but the app behaves like plain OpenCode (missing orchestrator/custom agents/custom prompts), check whether the fork dependencies are installed:

```bash
cd ~/.config/opencode/oh-my-opencode-slim-fork
bun install
bun run build:fast
```

Then fully restart the `qde` or `qdw` session.

Symptom pattern:

- `qds` shows local fork + preset correctly
- but runtime behavior looks like stock OpenCode
- and the fork log does not show fresh `[plugin] initialized` entries

In practice this usually means the local `file://` plugin path is correct, but the fork's dependencies were missing (`node_modules/` absent), so the plugin could not initialize at runtime.

## Current branch

```bash
git checkout feature/category-routing
```

## Revert to published slim package

Change `~/.config/opencode/opencode.json` back to:

```json
{
  "plugin": [
    "@opencode-ai/plugin",
    "oh-my-opencode-slim"
  ]
}
```

Then restart OpenCode.
