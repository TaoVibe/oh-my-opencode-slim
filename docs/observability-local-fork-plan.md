# Local Fork Plan: Runtime Observability for Agents, Subagents, and Shells

## Goal

Add plugin-side observability to the local `oh-my-opencode-slim-fork` so we can answer questions like:

- which agent or subagent is currently running
- which model and variant it is using
- what fallback chain is available
- how many background tasks, child sessions, and multiplexer panes are active

This plan keeps the **data collection and status model in the plugin**. The core TUI can consume that data later, but the fork should be useful on its own first.

## Why plugin-first

The fork already knows most of the required facts:

- background tasks and child sessions are tracked in `src/background/background-manager.ts`
- child panes are tracked in `src/background/multiplexer-session-manager.ts`
- resolved foreground models are known in `src/index.ts`
- fallback chains and retry attempts are known in the background manager

So the first step is not more orchestration. It is turning existing runtime facts into a first-class observability model.

## Scope

### In scope

- a central runtime observability manager/store
- normalized work-item records for agents, subagents, and shells
- model / variant / fallback metadata where known
- a small command or tool for reading current runtime state
- richer task launch and completion notifications
- easy enable/disable switches

### Out of scope for v1

- persistent always-visible TUI chips in OpenCode core
- token accounting or cost estimation
- historical tracing across process restarts
- deep nested activity trees with live animation

## Proposed runtime model

Create a small normalized record shape, for example:

```ts
type RuntimeWorkKind = 'foreground-agent' | 'background-agent' | 'shell';

type RuntimeWorkStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled';

type RuntimeWorkItem = {
  id: string;
  parentId?: string;
  sessionId?: string;
  kind: RuntimeWorkKind;
  agent?: string;
  title: string;
  status: RuntimeWorkStatus;
  model?: string;
  variant?: string;
  configuredFallbackChain?: string[];
  attemptedModels?: string[];
  successfulModel?: string;
  paneId?: string;
  startedAt: number;
  updatedAt: number;
};
```

This intentionally tracks three different model concepts:

1. configured primary model
2. configured fallback chain
3. actual successful model after retries/fallback

That prevents confusing status output.

## Files to change

### New files

- `src/observability/manager.ts`
- `src/observability/types.ts`
- `src/observability/index.ts`
- optional: `src/tools/observability.ts`
- tests for the new manager and tool

### Existing files to integrate with

- `src/index.ts`
- `src/background/background-manager.ts`
- `src/background/multiplexer-session-manager.ts`
- `src/tools/background.ts`

## Feature-toggle strategy

Use config switches that behave like opt-in crate features.

Suggested config shape:

```jsonc
{
  "observability": {
    "enabled": false,
    "collectModels": true,
    "trackShells": true,
    "notifyOnLaunch": true,
    "notifyOnCompletion": true,
    "exposeTool": true
  }
}
```

### Toggle priority order

Settings are evaluated in this order (later overrides earlier):

1. `enabled` — if `false`, ALL other settings are ignored. This is the master kill switch.
2. `collectModels` — if `false`, model IDs are hidden but counts still work.
3. `trackShells` — if `false`, multiplexers are not tracked as shell work items.
4. `notifyOnLaunch` — if `false`, launch notifications are suppressed.
5. `notifyOnCompletion` — if `false`, completion summaries omit observability details.
6. `exposeTool` — if `false`, the status tool is disabled but internal state still updates.

### Toggle semantics

- `observability.enabled=false`
  - short-circuits the manager entirely
  - no runtime store updates
  - no extra prompts or notifications
  - no status tool registration
  - **all other settings are ignored**

- `collectModels=false`
  - still tracks agent/session counts
  - hides model IDs and fallback chain details

- `trackShells=false`
  - do not track multiplexer panes as shell work items

- `notifyOnLaunch=false`
  - no additional launch notifications

- `notifyOnCompletion=false`
  - no observability-enriched completion summaries

- `exposeTool=false`
  - internal store still updates
  - no user-facing tool is registered
  - other notifications still fire

This gives you feature-flag behavior without needing a compile-time feature system.

## Rollout plan

### Phase 1 — internal store only

- build `ObservabilityManager`
- register foreground/background/shell work items
- update status from `session.created`, `session.status`, `session.deleted`
- no UI changes yet

Success criteria:

- current runtime state can be queried programmatically
- counts and model metadata are correct for background tasks

### Phase 2 — user-facing status tool

- add a tool such as `observability_status`
- return:
  - counts of running agents/subagents/shells
  - list of active work items
  - model and variant where known

Success criteria:

- the user can ask for current runtime state without reading logs

### Phase 3 — better background task messages

- enrich launch output in `src/tools/background.ts`
- optionally include:
  - chosen model
  - fallback chain summary
  - pane ID when available

Success criteria:

- task launch output is informative enough that users do not need to query the tool every time

## Verification

Add focused tests for:

- work-item lifecycle transitions
- correct cleanup on `session.deleted`
- correct model/fallback recording
- shell tracking on/off behavior
- tool output with observability enabled and disabled

Manual smoke tests:

1. launch one background task
2. launch multiple parallel tasks
3. confirm status reflects counts and models
4. cancel one task and confirm cleanup
5. verify disabled mode produces no extra output or state

## Risks

### Risk: stale runtime state

Mitigation:
- derive updates from existing session lifecycle events
- clean up aggressively on `session.deleted`
- fall back to manager cleanup paths already present in background manager

### Risk: user confusion over model identity

Mitigation:
- distinguish configured chain vs actual successful model
- label output clearly

### Risk: too much noise

Mitigation:
- make enriched notifications opt-in or individually switchable

### Risk: future TUI needs different shape

Mitigation:
- keep the internal work-item schema normalized and presentation-agnostic

## Recommended first implementation

Build this in the fork first:

1. `ObservabilityManager`
2. `observability.enabled` config gate
3. `observability_status` tool
4. enriched background launch/completion summaries

That gives immediate value and creates a clean data source for later TUI work.
