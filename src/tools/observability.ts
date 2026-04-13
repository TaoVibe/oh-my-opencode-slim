import { existsSync, statSync } from 'node:fs';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type {
  BackgroundTaskManager,
  MultiplexerSessionManager,
} from '../background';
import type { PluginConfig } from '../config';
import { buildRoutingDiagnostics } from '../config';
import { lookupRegistryEntry, type ModelRegistryStore } from '../utils';

const z = tool.schema;

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

interface RuntimeObservabilityMeta {
  pluginStartedAt: string;
  configPaths?: string[];
  buildArtifactPaths?: string[];
  latestConfigMtime?: string;
  latestBuildMtime?: string;
}

function getLatestMtime(paths: string[] | undefined): string | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }

  const mtimes = paths
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => statSync(filePath).mtimeMs);

  if (mtimes.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...mtimes)).toISOString();
}

export function createObservabilityTool(
  backgroundManager: BackgroundTaskManager,
  multiplexerSessionManager: MultiplexerSessionManager,
  pluginConfig?: PluginConfig,
  runtimeMeta?: RuntimeObservabilityMeta,
  modelRegistry?: ModelRegistryStore,
): Record<string, ToolDefinition> {
  const routing_doctor = tool({
    description: `Run doctor-style checks for routing freshness and degraded model chains.

Returns:
- stale-session reminder when runtime config likely needs restart
- blocked/degraded routes
- cooled-only route warnings
- preferred vs effective route drift`,
    args: {},
    async execute() {
      const modelHealth = backgroundManager.getModelHealthSnapshots();
      const registry = modelRegistry?.load();
      const routeDiagnostics = buildRoutingDiagnostics(
        pluginConfig,
        modelHealth,
        registry,
      );
      const pluginStartedAt = runtimeMeta?.pluginStartedAt
        ? Date.parse(runtimeMeta.pluginStartedAt)
        : Number.NaN;
      const latestConfigMtime =
        runtimeMeta?.latestConfigMtime ??
        getLatestMtime(runtimeMeta?.configPaths);
      const latestBuildMtime =
        runtimeMeta?.latestBuildMtime ??
        getLatestMtime(runtimeMeta?.buildArtifactPaths);
      const lines = ['Routing Doctor'];

      lines.push(
        `Plugin started: ${runtimeMeta?.pluginStartedAt ?? 'unknown'}`,
      );
      if (latestConfigMtime) {
        lines.push(`Latest config mtime: ${latestConfigMtime}`);
      }
      if (latestBuildMtime) {
        lines.push(`Latest build mtime: ${latestBuildMtime}`);
      }

      const staleConfig =
        latestConfigMtime !== undefined &&
        Number.isFinite(pluginStartedAt) &&
        Date.parse(latestConfigMtime) > pluginStartedAt;
      const staleBuild =
        latestBuildMtime !== undefined &&
        Number.isFinite(pluginStartedAt) &&
        Date.parse(latestBuildMtime) > pluginStartedAt;

      if (staleConfig || staleBuild) {
        lines.push(
          `Freshness: stale session detected (${[
            staleConfig ? 'config newer than session' : null,
            staleBuild ? 'build newer than session' : null,
          ]
            .filter(Boolean)
            .join(', ')}). Restart qde before debugging routing behavior.`,
        );
      } else {
        lines.push(
          'Freshness: session appears current against known config/build files.',
        );
      }

      const blocked = routeDiagnostics.filter(
        (item) => item.status === 'blocked',
      );
      const degraded = routeDiagnostics.filter(
        (item) => item.status === 'degraded',
      );

      lines.push(
        `Summary: healthy=${routeDiagnostics.filter((item) => item.status === 'healthy').length}, degraded=${degraded.length}, blocked=${blocked.length}`,
      );

      if (
        !staleConfig &&
        !staleBuild &&
        blocked.length === 0 &&
        degraded.length === 0
      ) {
        lines.push('Verdict: routing looks healthy.');
      } else {
        lines.push(
          `Verdict: routing is ${staleConfig || staleBuild ? 'at risk from stale runtime state' : 'degraded'}${blocked.length > 0 ? ' and partially blocked' : ''}.`,
        );
      }

      if (blocked.length > 0) {
        lines.push('', 'Blocked Routes');
        for (const item of blocked) {
          lines.push(`${item.category}/${item.lane} | ${item.reason}`);
          lines.push(
            `  preferred=${item.preferredModel ?? 'none'} | effective=${item.effectiveModel ?? 'none'}`,
          );
          const preferredEntry = item.preferredModel
            ? lookupRegistryEntry(registry, item.preferredModel)
            : undefined;
          if (preferredEntry) {
            lines.push(
              `  preferredRegistry=${preferredEntry.lastStatus} | lastSeen=${preferredEntry.lastSeenAt} | requests=${preferredEntry.requestCount}`,
            );
          }
        }
      }

      if (degraded.length > 0) {
        lines.push('', 'Degraded Routes');
        for (const item of degraded) {
          lines.push(`${item.category}/${item.lane} | ${item.reason}`);
          lines.push(
            `  preferred=${item.preferredModel ?? 'none'} | effective=${item.effectiveModel ?? 'none'}`,
          );
          const preferredEntry = item.preferredModel
            ? lookupRegistryEntry(registry, item.preferredModel)
            : undefined;
          if (preferredEntry) {
            lines.push(
              `  preferredRegistry=${preferredEntry.lastStatus} | lastSeen=${preferredEntry.lastSeenAt} | requests=${preferredEntry.requestCount}`,
            );
          }
          const effectiveEntry = item.effectiveModel
            ? lookupRegistryEntry(registry, item.effectiveModel)
            : undefined;
          if (effectiveEntry) {
            lines.push(
              `  effectiveRegistry=${effectiveEntry.lastStatus} | lastSeen=${effectiveEntry.lastSeenAt} | requests=${effectiveEntry.requestCount}`,
            );
          }
          if (item.recentFailedModels.length > 0) {
            lines.push(`  recentFailed=${formatList(item.recentFailedModels)}`);
          }
          if (item.cooledModels.length > 0) {
            lines.push(`  cooled=${formatList(item.cooledModels)}`);
          }
        }
      }

      if (modelHealth.length > 0) {
        lines.push('', 'Cooling Models');
        for (const item of modelHealth.filter((entry) => entry.isCooling)) {
          lines.push(
            `${item.model} | cooldownLevel=${item.cooldownLevel}${item.cooldownUntil ? ` | until=${item.cooldownUntil}` : ''}`,
          );
        }
      }

      return lines.join('\n');
    },
  });

  const observability_status = tool({
    description: `Show current runtime status for background agents and panes.

Returns:
- counts by task state
- active background work items
- configured model / variant / fallback chain when known
- tracked multiplexer panes`,
    args: {
      include_completed: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include completed/failed/cancelled tasks'),
    },
    async execute(args, toolContext) {
      const includeCompleted = args.include_completed ?? false;
      const allTasks = backgroundManager.getTaskSnapshots();
      const tasks = includeCompleted
        ? allTasks
        : allTasks.filter(
            (task) =>
              task.status === 'pending' ||
              task.status === 'starting' ||
              task.status === 'running',
          );
      const panes = multiplexerSessionManager.getTrackedSessions();
      const currentSessionId =
        toolContext &&
        typeof toolContext === 'object' &&
        'sessionID' in toolContext
          ? String((toolContext as { sessionID: string }).sessionID)
          : undefined;
      const sessionOverrides = currentSessionId
        ? backgroundManager.getSessionAgentModelOverrides(currentSessionId)
        : {};
      const modelHealth = backgroundManager.getModelHealthSnapshots();
      const routeDiagnostics = buildRoutingDiagnostics(
        pluginConfig,
        modelHealth,
        modelRegistry?.load(),
      );
      const latestConfigMtime =
        runtimeMeta?.latestConfigMtime ??
        getLatestMtime(runtimeMeta?.configPaths);
      const latestBuildMtime =
        runtimeMeta?.latestBuildMtime ??
        getLatestMtime(runtimeMeta?.buildArtifactPaths);

      const counts = {
        pending: allTasks.filter((task) => task.status === 'pending').length,
        starting: allTasks.filter((task) => task.status === 'starting').length,
        running: allTasks.filter((task) => task.status === 'running').length,
        completed: allTasks.filter((task) => task.status === 'completed')
          .length,
        failed: allTasks.filter((task) => task.status === 'failed').length,
        cancelled: allTasks.filter((task) => task.status === 'cancelled')
          .length,
      };

      const lines = [
        'Runtime Status',
        `Stack: ${pluginConfig?.stackMode ?? 'default'}`,
        `Plugin started: ${runtimeMeta?.pluginStartedAt ?? 'unknown'}`,
        `Latest config mtime: ${latestConfigMtime ?? 'unknown'}`,
        `Latest build mtime: ${latestBuildMtime ?? 'unknown'}`,
        `Model policy: ${pluginConfig?.modelPolicy?.enforceAllowlist === true ? 'allowlist-enforced' : 'disabled'}`,
        `Allowed models: ${(pluginConfig?.modelPolicy?.allowedModels ?? []).length}`,
        `Tasks: pending=${counts.pending}, starting=${counts.starting}, running=${counts.running}, completed=${counts.completed}, failed=${counts.failed}, cancelled=${counts.cancelled}`,
        `Panes: ${panes.length}`,
        '',
        'Background Tasks',
      ];

      if (tasks.length === 0) {
        lines.push('(none)');
      } else {
        for (const task of tasks) {
          lines.push(
            `${task.id} | ${task.agent} | ${task.status} | ${task.description}`,
          );
          lines.push(`  model=${task.configuredModel ?? 'unknown'}`);
          lines.push(`  variant=${task.variant ?? 'none'}`);
          lines.push(
            `  route=${task.category ?? 'direct'}${task.lane ? `/${task.lane}` : ''}`,
          );
          if (task.routeModelChain && task.routeModelChain.length > 0) {
            lines.push(`  routeChain=${formatList(task.routeModelChain)}`);
          }
          lines.push(`  fallback=${formatList(task.fallbackChain)}`);
          lines.push(`  session=${task.sessionId ?? 'not started yet'}`);
        }
      }

      lines.push('', 'Session Overrides');
      const overrideEntries = Object.entries(sessionOverrides);
      if (overrideEntries.length === 0) {
        lines.push('(none)');
      } else {
        for (const [agent, model] of overrideEntries) {
          lines.push(`${agent}=${model}`);
        }
      }

      lines.push('', 'Model Health');
      if (modelHealth.length === 0) {
        lines.push('(none)');
      } else {
        for (const item of modelHealth) {
          lines.push(
            `${item.model} | cooling=${item.isCooling ? 'yes' : 'no'} | failures=${item.consecutiveFailures} | cooldownLevel=${item.cooldownLevel}${item.cooldownUntil ? ` | until=${item.cooldownUntil}` : ''}`,
          );
        }
      }

      lines.push('', 'Route Diagnostics');
      if (routeDiagnostics.length === 0) {
        lines.push('(none)');
      } else {
        for (const item of routeDiagnostics) {
          lines.push(
            `${item.category}/${item.lane} | ${item.status} | ${item.reason}`,
          );
          lines.push(
            `  preferred=${item.preferredModel ?? 'none'} | effective=${item.effectiveModel ?? 'none'}`,
          );
          lines.push(`  configured=${formatList(item.configuredModels)}`);
          lines.push(`  allowed=${formatList(item.allowedModels)}`);
          if (item.recentFailedModels.length > 0) {
            lines.push(`  recentFailed=${formatList(item.recentFailedModels)}`);
          }
          if (item.cooledModels.length > 0) {
            lines.push(`  cooled=${formatList(item.cooledModels)}`);
          }
        }
      }

      lines.push('', 'Multiplexer Panes');
      if (panes.length === 0) {
        lines.push('(none)');
      } else {
        for (const pane of panes) {
          lines.push(
            `${pane.paneId} | ${pane.title} | session=${pane.sessionId} | parent=${pane.parentId}`,
          );
        }
      }

      return lines.join('\n');
    },
  });

  return { observability_status, routing_doctor };
}
