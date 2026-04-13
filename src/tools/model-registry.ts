import { type PluginInput, type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { PluginConfig } from '../config';
import type { ModelRegistryStore } from '../utils';
import {
  extractSessionResult,
  extractUsageMetrics,
  parseModelReference,
  promptWithTimeout,
  type SessionUsageMetrics,
} from '../utils/session';

const z = tool.schema;

function collectConfiguredModels(config?: PluginConfig): string[] {
  const models = new Set<string>();

  for (const agent of Object.values(config?.agents ?? {})) {
    const model = agent?.model;
    if (typeof model === 'string') {
      models.add(model);
    } else if (Array.isArray(model)) {
      for (const entry of model) {
        if (typeof entry === 'string') {
          models.add(entry);
        } else if (entry?.id) {
          models.add(entry.id);
        }
      }
    }
  }

  for (const chain of Object.values(config?.fallback?.chains ?? {})) {
    for (const model of chain ?? []) {
      models.add(model);
    }
  }

  for (const category of Object.values(config?.routing?.categories ?? {})) {
    for (const lane of ['cheap', 'value', 'premium'] as const) {
      const route = category?.[lane];
      const model = route?.model;
      if (typeof model === 'string') {
        models.add(model);
      } else if (Array.isArray(model)) {
        for (const entry of model) {
          if (typeof entry === 'string') {
            models.add(entry);
          } else if (entry?.id) {
            models.add(entry.id);
          }
        }
      }
    }
  }

  return [...models];
}

export function createModelRegistryTool(
  ctx: PluginInput,
  config: PluginConfig | undefined,
  registry: ModelRegistryStore,
): Record<string, ToolDefinition> {
  const model_registry_import = tool({
    description:
      'Import or seed provider/model metadata into the persisted registry. Use this for catalog snapshots such as pricing, context, capabilities, or aliases.',
    args: {
      entries: z.array(
        z.object({
          model: z.string().describe('Canonical provider/model id'),
          aliases: z.array(z.string()).optional().describe('Optional alias ids/names'),
          metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary catalog metadata'),
        }),
      ),
    },
    async execute(args) {
      let imported = 0;
      let skipped = 0;
      const lines = ['Model Registry Import', `Path: ${registry.getPath()}`, ''];

      for (const entry of args.entries) {
        const model = entry.model.trim();
        if (!parseModelReference(model)) {
          skipped += 1;
          lines.push(`${entry.model} | skipped | invalid model format`);
          continue;
        }

        registry.upsertMetadata({
          model,
          aliases: entry.aliases?.map((alias) => alias.trim()).filter(Boolean),
          metadata: entry.metadata,
          source: 'routing',
        });
        imported += 1;
        lines.push(`${model} | imported`);
      }

      lines.splice(3, 0, `Imported: ${imported}`, `Skipped: ${skipped}`);
      return lines.join('\n');
    },
  });

  const model_registry_status = tool({
    description: 'Show persisted model registry summary and recent health/probe data.',
    args: {
      provider: z.string().optional().describe('Optional provider filter'),
      limit: z.number().optional().default(20).describe('Max rows to show'),
    },
    async execute(args) {
      const provider = args.provider?.trim();
      const limit = args.limit ?? 20;
      const data = registry.load();
      const entries = Object.values(data.models)
        .filter((entry) => !provider || entry.providerID === provider)
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .slice(0, limit);

      const lines = [
        'Model Registry',
        `Path: ${registry.getPath()}`,
        `Updated: ${data.updatedAt}`,
        `Entries: ${Object.keys(data.models).length}`,
        '',
      ];

      if (entries.length === 0) {
        lines.push('(none)');
        return lines.join('\n');
      }

      for (const entry of entries) {
        lines.push(
          `${entry.model} | status=${entry.lastStatus} | requests=${entry.requestCount} | probes=${entry.probeCount} | ok=${entry.successCount} | fail=${entry.failureCount}`,
        );
        lines.push(
          `  lastSeen=${entry.lastSeenAt}${entry.lastProbeAt ? ` | lastProbe=${entry.lastProbeAt}` : ''}${entry.lastError ? ` | error=${entry.lastError}` : ''}`,
        );
        if (
          entry.totalInputTokens !== undefined ||
          entry.totalOutputTokens !== undefined ||
          entry.totalTokens !== undefined ||
          entry.totalCostUsd !== undefined
        ) {
          lines.push(
            `  usage=input:${entry.totalInputTokens ?? 0} output:${entry.totalOutputTokens ?? 0} total:${entry.totalTokens ?? 0} costUsd:${entry.totalCostUsd ?? 0}`,
          );
        }
        if (entry.metadata && Object.keys(entry.metadata).length > 0) {
          lines.push(`  metadata=${JSON.stringify(entry.metadata)}`);
        }
      }

      return lines.join('\n');
    },
  });

  const model_registry_probe = tool({
    description: 'Probe models for liveness using the current OpenCode runtime and persist results.',
    args: {
      models: z.array(z.string()).optional().describe('Explicit provider/model IDs to probe'),
      use_configured_models: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include models referenced by current config/routing'),
      timeout_ms: z.number().optional().default(10000).describe('Per-model timeout'),
      prompt: z
        .string()
        .optional()
        .default('Reply with PASS only.')
        .describe('Probe prompt'),
    },
    async execute(args) {
      const explicitModels = (args.models ?? []).map((item) => item.trim()).filter(Boolean);
      const configuredModels = args.use_configured_models === false ? [] : collectConfiguredModels(config);
      const models = [...new Set([...explicitModels, ...configuredModels])];

      if (models.length === 0) {
        return 'No models to probe.';
      }

      const timeoutMs = args.timeout_ms ?? 10000;
      const prompt = args.prompt ?? 'Reply with PASS only.';
      const lines = [`Model Registry Probe`, `Path: ${registry.getPath()}`, `Models: ${models.length}`, ''];
      let alive = 0;
      let failed = 0;

      for (const model of models) {
        const ref = parseModelReference(model);
        if (!ref) {
          registry.recordFailure({ model, source: 'probe', error: 'invalid model format', probe: true });
          failed += 1;
          lines.push(`${model} | failed | invalid model format`);
          continue;
        }

        const startedAt = Date.now();
        const session = await ctx.client.session.create({
          responseStyle: 'data',
          throwOnError: true,
          query: { directory: ctx.directory },
          body: { title: `probe:${model}` },
        });
        const sessionId =
          (session as { data?: { id?: string }; id?: string })?.data?.id ??
          (session as { data?: { id?: string }; id?: string })?.id;

        if (!sessionId) {
          registry.recordFailure({ model, source: 'probe', error: 'session create returned no id', probe: true });
          failed += 1;
          lines.push(`${model} | failed | session create returned no id`);
          continue;
        }

        let usage: SessionUsageMetrics | undefined;
        try {
          const promptResult = await promptWithTimeout(
            ctx.client,
            {
              responseStyle: 'data',
              throwOnError: true,
              path: { id: sessionId },
              query: { directory: ctx.directory },
              body: {
                model: ref,
                system: 'Return a minimal health probe response. No tools. No extra commentary.',
                parts: [{ type: 'text', text: prompt }],
              },
            },
            timeoutMs,
          );
          usage = extractUsageMetrics(promptResult);

          const result = await extractSessionResult(ctx.client, sessionId, {
            includeReasoning: false,
          });
          if (result.empty) {
            throw new Error('empty response');
          }

          registry.recordSuccess({
            model,
            source: 'probe',
            probe: true,
            latencyMs: Date.now() - startedAt,
            usage,
          });
          alive += 1;
          lines.push(`${model} | alive | ${Date.now() - startedAt}ms`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          registry.recordFailure({
            model,
            source: 'probe',
            probe: true,
            error: message,
            latencyMs: Date.now() - startedAt,
            usage,
          });
          failed += 1;
          lines.push(`${model} | failed | ${message}`);
        } finally {
          await ctx.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
        }
      }

      lines.splice(3, 0, `Alive: ${alive}`, `Failed: ${failed}`);
      return lines.join('\n');
    },
  });

  return { model_registry_import, model_registry_status, model_registry_probe };
}
