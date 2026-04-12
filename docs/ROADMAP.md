# Slim Fork Roadmap

## Context

This fork exists to keep a **slim**, locally hackable OpenCode harness that adds the workflow features we use most often without importing the full surface area of Claude Code or full oh-my-opencode.

It should optimize for:

- reliable orchestration
- low maintenance cost
- minimal runtime complexity
- clear local customization points

It should **not** try to become a full replacement for every workflow feature in Claude Code or the full oh-my-opencode package.

Implementation bias:

- prefer copying working implementations from the full oh-my-opencode codebase over inventing new abstractions in slim
- only redesign when the full implementation is clearly too large, too coupled, or depends on features slim does not want
- preserve compatible names and behavior where practical so future cherry-picks stay easy

## Gap Analysis

| Capability | Claude Code | Full oh-my-opencode | Slim fork (current) | Priority |
|------------|-------------|---------------------|---------------------|----------|
| Core orchestrator | Strong built-in workflow engine | Full harness with richer orchestration | Present, customizable, locally forkable | P0 |
| Category routing | Indirect via subagents/skills/workflows | Rich category system | Present, but small category set | P1 |
| Persistent memory/instructions | Strong (`CLAUDE.md`, memory scopes, instruction lifecycle) | Stronger config/instruction surface | Limited prompt override model | P1 |
| Subagent product surface | First-class custom subagents, scopes, permissions, memory, resume | Rich curated agent system | Delegation works, but less productized | P1 |
| Hook system | Broad lifecycle hook platform | Many built-in configurable hooks | Focused built-in hooks only | P1 |
| Skills workflows | First-class skills and slash invocation | Rich built-in workflows | Partial support, less surfaced | P2 |
| Background tasks | Strong foreground/background semantics | Strong async/background orchestration | Present, recently hardened | P0 |
| Concurrency controls | Mature session/task controls | Documented background concurrency controls | Limited exposed controls | P2 |
| Observability / introspection | Strong UI/docs tooling | Richer harness observability | Basic qds + logs + docs | P1 |
| Worktree / isolation flows | First-class worktree isolation | Richer multi-agent execution patterns | Not first-class | P3 |

## Phase 1 — Reliability and Introspection

Goal: make the existing slim workflow trustworthy enough for daily use.

### Scope

- keep category routing reliable across all configured agents
- keep background tasks deterministic under startup/fallback pressure
- improve visibility into effective routing and active config
- document recovery paths for common local-fork failures

### Candidate work

- add smoke tests for all built-in routing categories
- add an effective-routing inspector (agent -> model -> fallback chain)
- add a lightweight diagnostics surface for:
  - loaded preset
  - active fork build
  - effective agent prompt override presence
  - whether fork dependencies are installed
- add log markers for plugin initialization and prompt override loading

### Success criteria

- no routing path silently falls back to default OpenCode behavior without an obvious signal
- all current task/category flows pass focused regression tests
- local-fork failures are diagnosable in under 2 minutes

## Phase 2 — Workflow Primitives That Earn Their Weight

Goal: add the smallest set of missing workflow primitives that materially improve daily use.

Default strategy: **port from the full version first, simplify second**.

Hard priority order for this phase:

1. Claude-compatible hook slice
2. instruction loading beyond prompt append
3. custom agent discovery/config
4. everything else is optional and deferred until a repeated friction case exists

### Scope

- project/user instruction loading
- lightweight persistent memory or equivalent instruction layering
- generalized hook configuration for a small set of high-value lifecycle events
- more first-class custom agent configuration

### Candidate work

- port the existing full-version Claude-compatible hook implementation in the smallest viable slice instead of designing a new hook system from scratch
- support user/project instruction files beyond prompt append overrides
- add configurable hooks for:
  - session start
  - prompt submit
  - subagent/task start/stop
  - pre/post tool use for selected tools
- add custom agent discovery from config directories instead of hardcoding all workflow roles in source
- defer persistent memory and skill/workflow expansion unless hook + instruction loading prove insufficient for repeated real tasks

### Copy-first sequencing

1. identify the exact full-version files that implement Claude-compatible hooks
2. port the minimum dependency chain needed for a slim build
3. keep event names, matcher semantics, and config shape as close as possible to the full version
4. remove or stub only the parts that depend on full-only systems
5. add simplifications only after parity tests pass

### Initial hook target

The first hook slice should aim to reuse the full-version behavior for:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `SubagentStart`
- `SubagentStop`

Optional later parity targets:

- `InstructionsLoaded`
- `ConfigChange`
- `PreCompact` / `PostCompact`
- `Notification`

### Slim test

Each feature in this phase should satisfy all three:

1. replaces a real manual workflow we already repeat
2. has a clear disable/off path
3. does not require a heavy new orchestration subsystem
4. is tied to a named friction case observed in actual use

### Success criteria

- at least 2-3 repeated manual workflows become one-step workflows
- local customizations move from source edits into config/doc surfaces where possible
- disabled features add effectively zero behavior cost

## Phase 3 — Selective Interop and Advanced Execution

Goal: close the highest-value gaps with Claude Code and full oh-my-opencode without losing the slim identity.

### Scope

- better session continuity
- resumable tasks/subagents where practical
- optional concurrency controls
- optional isolation/worktree support for high-risk tasks

This phase is explicitly **demand-driven**, not default roadmap scope.

### Candidate work

- resumable delegated-task flows
- background concurrency caps by agent/model/provider
- optional worktree-backed execution for deep agents
- richer UI/UX helpers for active task inspection and transcript debugging

### Guardrails

- do not add speculative features without a real friction case
- prefer upstream/full-version code reuse over fresh implementation when behavior already exists there
- if a feature can live as a script, doc, or prompt override, prefer that over plugin runtime code
- if a feature duplicates full oh-my-opencode without a slim-specific simplification, reject it

### Out of scope unless repeatedly justified

- deep persistent memory systems
- large built-in hook catalogs copied wholesale
- broad UI product surfaces inside the plugin
- worktree/isolation features for general use instead of narrow high-risk tasks

### Success criteria

- advanced execution features are opt-in
- the slim fork stays understandable by reading a small number of files
- maintenance cost remains low enough for local iteration

## Done

- [x] 2026-04-12: Added category routing to slim task delegation
- [x] 2026-04-12: Added local fork workflow for qde/qdw using the same plugin with different stacks
- [x] 2026-04-12: Hardened background-task startup/fallback completion behavior
- [x] 2026-04-12: Fixed visible internal marker leak in transcript UI
- [x] 2026-04-12: Documented local-fork rebuild/restart/recovery workflow
- [x] 2026-04-12: Documented stack-switching semantics for already-running vs newly launched sessions

## Rejected / Deferred

- Full Claude Code parity — rejected; too broad for the purpose of this fork
- Full oh-my-opencode feature parity — rejected; would collapse the distinction between full and slim
- Heavy classifier-driven orchestration — deferred unless deterministic routing stops being sufficient
- Large speculative hook catalog — deferred until repeated real workflows justify each event
- Greenfield hook system design — rejected for now; copy the full-version Claude-compatible hook path first

## Decision Rule

If a proposed feature can be implemented as:

- a prompt override
- a shell helper
- a profile/switcher improvement
- a documentation playbook

then it should usually stay **outside** the plugin runtime.

If a feature already exists in the full version and we want it in slim, the default order is:

1. copy the existing implementation
2. prove it works in slim
3. simplify only where maintenance cost or dependency weight demands it

The fork should own:

- routing
- orchestration primitives
- background-task correctness
- a small number of high-value workflow automation surfaces
