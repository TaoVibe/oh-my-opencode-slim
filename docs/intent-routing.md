# Intent Routing

oh-my-opencode-slim includes a lightweight **intent router** for a small set of high-value orchestrator workflows.

Current built-in intents:

| Intent | Trigger phrases |
|--------|-----------------|
| `deep_research` | `deep research`, `research deeply` |
| `deep_review` | `deep review`, `thorough review`, `review deeply` |

## What it does

When the latest user message in an orchestrator session matches one of the configured phrases, the plugin injects a hidden block into the message before it is sent to the model:

```text
<intent_router>
intent=deep_review
Follow the orchestrator workflow for this intent.
</intent_router>
```

This block is not shown in the UI. It acts as a harness-level hint so the orchestrator can react consistently to special phrases.

## How it works

The implementation is split across two layers:

1. **Trigger logic in code**
   - File: `src/hooks/intent-router/index.ts`
   - Hook: `experimental.chat.messages.transform`
   - Responsibility: detect phrases and inject the hidden `<intent_router>` tag

2. **Workflow meaning in the orchestrator prompt**
   - File: `src/agents/orchestrator.ts`
   - Responsibility: define what `deep research` and `deep review` mean operationally

This keeps phrase detection deterministic and cheap while leaving behavior design in prompt space.

## Why this design

This feature was added to make the harness understand requests like “deep research” and “deep review” without adding a separate classifier or a heavy orchestration subsystem.

The design goals were:

- keep triggering deterministic
- avoid adding another model call
- scope the feature to orchestrator sessions only
- separate **when to trigger** from **what the agent should do**

## Deep research behavior

The orchestrator treats `deep research` as a request for expanded, multi-step research:

- clarify scope if needed
- prefer planning when ambiguity exists
- use parallel exploration and research when it adds value
- synthesize findings instead of relaying worker output directly

## Deep review behavior

The orchestrator treats `deep review` as a request for rigorous review:

- start with adversarial review
- escalate to architecture review when boundary or design risk is involved
- end with an explicit disposition when appropriate: `PASS`, `REVISE`, or `BLOCK`

## Tuning aliases

The phrases live in a small config table exported from `src/hooks/intent-router/index.ts`:

```ts
export const INTENT_ALIASES = {
  deep_research: ['deep research', 'research deeply'],
  deep_review: ['deep review', 'thorough review', 'review deeply'],
};
```

If you want to add or remove aliases, update that table and run the intent router tests.

## Verification

The implementation is covered by focused tests in:

- `src/hooks/intent-router/index.test.ts`

Recommended checks after changes:

```bash
bun test src/hooks/intent-router/index.test.ts
bunx @biomejs/biome check src/hooks/intent-router/index.ts src/hooks/intent-router/index.test.ts
```

## Prompt customization

If you want to change the meaning of these intents without editing source code, use prompt overrides:

- `~/.config/opencode/oh-my-opencode-slim/orchestrator.md`
- `~/.config/opencode/oh-my-opencode-slim/orchestrator_append.md`

That lets you keep the same trigger phrases while customizing the orchestrator’s response policy.
