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

## Development loop

After code changes:

```bash
bun run build
bun run typecheck
bun run check:ci
bun test
```

Then restart OpenCode and re-run the smoke tests.

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
