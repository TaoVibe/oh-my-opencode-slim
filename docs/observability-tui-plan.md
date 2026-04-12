# Core TUI Plan: Rendering Runtime Observability

## Goal

Add a small, maintainable OpenCode core TUI patch that surfaces runtime observability similar to Claude Code:

- how many agents are running
- how many subagents are running
- how many shells are active
- which models are attached to active work

The TUI should **render runtime state**, not own orchestration logic.

## Design principle

Keep the split clean:

- **plugin/local fork** owns runtime facts and emits a normalized status model
- **core TUI** owns only presentation and interaction

This keeps the core patch small and makes it easier to reapply on upstream updates.

## Scope

### In scope

- top-level status chips or counters
- a small observability panel/drawer
- model badges for active work items
- simple parent/child grouping if cheap
- easy enable/disable behavior

### Out of scope for v1

- full orchestration debugger UI
- timeline replay
- token or cost charts
- deeply nested execution trees with custom animations

## Target UI

### Header / status bar

Show compact counters such as:

- `Agents 1`
- `Subagents 3`
- `Shells 2`

If model data is present, optionally show one compact summary:

- `Busy: librarian(gpt-5.4-mini), oracle(gpt-5.4)`

### Panel / drawer

Add a simple panel with one row per active work item:

```text
Running Work
- orchestrator           gpt-5.4         running
- librarian             kimi-k2p5       running
- explorer              gpt-5.4-mini    running
- shell:%12             bash            idle
```

This is enough for v1.

## Feature-toggle strategy

Make the core patch behave like a feature flag.

### Recommended toggles

Use one high-level toggle and one detail toggle:

```jsonc
{
  "ui": {
    "observability": {
      "enabled": false,
      "showModels": true,
      "showPanel": true,
      "showHeaderCounts": true
    }
  }
}
```

Alternative fallback if core config wiring is heavy:

- environment variable for local patching, for example:
  - `OPENCODE_UI_OBSERVABILITY=1`

### Toggle semantics

- `enabled=false`
  - no header chips
  - no panel entry point
  - no runtime subscription for observability rendering

- `showModels=false`
  - show counts and rows, but hide model IDs

- `showPanel=false`
  - header chips only

- `showHeaderCounts=false`
  - panel only

## Data pipeline

The TUI needs a small event or store subscription path.

### How data flows

The local-fork plan defines the full `RuntimeWorkItem` shape with many fields. The TUI does not need all of them.

**Pipeline:**
1. Plugin/runtime emits normalized runtime work items via events
2. Core receives them via plugin hook or event subscription
3. Core stores a simplified subset in TUI state
4. Header and panel derive views from TUI state

### Data shape adaptation

The TUI uses a simplified shape for display:

```ts
type RuntimeWorkItem = {
  id: string;
  parentId?: string;
  kind: 'agent' | 'subagent' | 'shell';
  agent?: string;
  model?: string;
  variant?: string;
  status: 'starting' | 'running' | 'idle' | 'completed' | 'failed';
  title?: string;
};
```

The plugin's full shape includes extra fields (`configuredFallbackChain`, `attemptedModels`, `paneId`, `startedAt`, `updatedAt`). These are not rendered in the TUI directly — they are used by the plugin's status tool or enriched notifications.

### If plugin is not available

If the local-fork plugin is not installed or `observability.enabled=false`:
- TUI header shows nothing or "0 agents"
- TUI panel shows empty state
- No error shown (graceful degradation)

## Relationship to local-fork plan

**Order matters:**

1. Implement local-fork plan first — this creates the runtime observability data
2. Then implement TUI plan — this renders that data

The local fork emits events; the core TUI consumes them. Without step 1, step 2 has nothing to render.

**Toggle mapping:**

The two plans have different toggle shapes:

- Local fork: 6 toggles (`enabled`, `collectModels`, `trackShells`, `notifyOnLaunch`, `notifyOnCompletion`, `exposeTool`)
- TUI plan: 4 toggles (`enabled`, `showModels`, `showPanel`, `showHeaderCounts`)

The TUI toggles control whether rendering happens. They are independent of local-fork toggles. For TUI to show anything, local-fork must be enabled first.

## Patch shape for maintainability

Keep the core patch as a small cherry-pickable stack.

### Commit 1 — extension point / store plumbing

- add a small runtime observability store
- add event ingestion for plugin-provided status
- avoid UI changes in this commit

### Commit 2 — header chips + panel

- render counts in the header/status bar
- add panel or drawer view
- wire keybinding or command if needed

This split keeps update conflicts smaller.

## Rollout plan

### Phase 1 — header only

- show counts
- no panel yet

Why first:
- lowest UI risk
- very small patch
- easy to cherry-pick across upstream updates

### Phase 2 — panel

- add a simple running-work list
- show model badges and statuses

### Phase 3 — optional nesting and richer metadata

- parent/child grouping
- fallback-attempt display
- duration

Do this only if phase 1 and 2 feel stable.

## Easy on/off workflow

For local development and frequent upstream updates, use both:

1. **config toggle** for runtime enable/disable
2. **small cherry-pick commit stack** for the core patch

Recommended update workflow:

1. pull new upstream OpenCode
2. cherry-pick or rebase the 2-commit observability patch stack
3. keep feature disabled by default until smoke-tested
4. enable via config or env var locally
5. verify counts, panel, and model badges

This feels similar to a Rust `+feature` workflow:

- the code exists
- the feature is off by default
- turning it on is explicit and cheap

## Risks

### Risk: core patch grows too large

Mitigation:
- keep orchestration logic out of core
- put all computation in the plugin-side manager

### Risk: upstream TUI churn breaks the patch

Mitigation:
- touch only a small status/header surface and one panel surface
- avoid broad refactors in core

### Risk: counts drift from real runtime state

Mitigation:
- treat plugin/runtime as source of truth
- render only what the runtime store says

### Risk: UI clutter

Mitigation:
- make it opt-in
- keep header chips compact
- move details to the panel

## Recommended first core patch

If the goal is “Claude Code, but maintainable,” start with only:

1. header chips for counts
2. a minimal running-work panel
3. config/env feature gate

Do not start with nested trees, shell timelines, or retry visualizations.

That keeps the patch small enough to cherry-pick after upstream updates.
