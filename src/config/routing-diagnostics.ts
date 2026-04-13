import { filterAllowedModels } from './model-policy';
import type { ModelHealthSnapshot } from '../utils/model-health';
import type { ModelRegistryData } from '../utils/model-registry';
import type { PluginConfig, RoutingLane } from './schema';

export interface RouteDiagnostic {
  category: string;
  lane: RoutingLane;
  status: 'healthy' | 'degraded' | 'blocked';
  configuredModels: string[];
  allowedModels: string[];
  cooledModels: string[];
  recentFailedModels: string[];
  preferredModel?: string;
  effectiveModel?: string;
  reason: string;
}

export function buildRoutingHealthNotice(
  diagnostics: RouteDiagnostic[],
): string | undefined {
  const healthy = diagnostics.filter((item) => item.status === 'healthy').length;
  const degraded = diagnostics.filter(
    (item) => item.status === 'degraded',
  ).length;
  const blocked = diagnostics.filter((item) => item.status === 'blocked').length;

  if (degraded === 0 && blocked === 0) {
    return undefined;
  }

  const blockedRoutes = diagnostics.filter((item) => item.status === 'blocked');
  const degradedAlternatives = diagnostics
    .filter(
      (item) =>
        item.status === 'degraded' &&
        item.effectiveModel !== undefined &&
        item.effectiveModel !== item.preferredModel,
    )
    .slice(0, 6);

  const summary = `h=${healthy} d=${degraded} b=${blocked}`;
  const blockedList = blockedRoutes
    .slice(0, 6)
    .map((item) => `${item.category}/${item.lane}`)
    .join(', ');
  const preferList = degradedAlternatives
    .map(
      (item) =>
        `${item.category}/${item.lane}→${item.effectiveModel}`,
    )
    .join('; ');

  const lines = ['<RoutingHealth>', summary];

  if (blockedList) {
    lines.push(`blocked=${blockedList}`);
  }

  if (preferList) {
    lines.push(`prefer=${preferList}`);
  }

  lines.push('Use listed alternates; avoid blocked routes unless explicitly testing routing.');
  lines.push('</RoutingHealth>');
  return lines.join('\n');
}

function normalizeModels(model: unknown): string[] {
  if (typeof model === 'string') {
    return [model];
  }

  if (!Array.isArray(model)) {
    return [];
  }

  return model
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.length > 0,
    );
}

function hasRecentRegistryFailure(
  model: string,
  registry: ModelRegistryData | undefined,
  now: number,
  windowMs: number,
): boolean {
  const entry = registry?.models[model];
  if (!entry || entry.lastStatus !== 'failed') {
    return false;
  }

  const lastFailure = Date.parse(entry.lastFailureAt ?? entry.lastSeenAt);
  if (!Number.isFinite(lastFailure)) {
    return false;
  }

  return now - lastFailure <= windowMs;
}

export function buildRoutingDiagnostics(
  config: PluginConfig | undefined,
  healthSnapshots: ModelHealthSnapshot[],
  registry?: ModelRegistryData,
): RouteDiagnostic[] {
  const categories = config?.routing?.categories ?? {};
  const cooled = new Set(
    healthSnapshots.filter((item) => item.isCooling).map((item) => item.model),
  );
  const now = Date.now();
  const registryFailureWindowMs =
    config?.fallback?.health?.maxCooldownMs ?? 1_800_000;
  const diagnostics: RouteDiagnostic[] = [];

  for (const [category, routeConfig] of Object.entries(categories)) {
    for (const lane of ['cheap', 'value', 'premium'] as RoutingLane[]) {
      const laneConfig = routeConfig?.[lane];
      if (!laneConfig) {
        continue;
      }

      const configuredModels = normalizeModels(laneConfig.model);
      const allowedModels = filterAllowedModels(configuredModels, config);
      const cooledModels = allowedModels.filter((model) => cooled.has(model));
      const recentFailedModels = allowedModels.filter((model) =>
        hasRecentRegistryFailure(
          model,
          registry,
          now,
          registryFailureWindowMs,
        ),
      );
      const recentlyFailed = new Set(recentFailedModels);

      let status: RouteDiagnostic['status'];
      let reason: string;

      if (configuredModels.length === 0) {
        status = 'blocked';
        reason = 'no models configured';
      } else if (allowedModels.length === 0) {
        status = 'blocked';
        reason = 'all configured models filtered by model policy';
      } else if (cooledModels.length === allowedModels.length) {
        status = 'blocked';
        reason = 'all allowed models currently cooling';
      } else if (recentFailedModels.length === allowedModels.length) {
        status = 'blocked';
        reason = 'all allowed models have recent failed registry status';
      } else if (
        cooledModels.length > 0 && recentFailedModels.length > 0
      ) {
        status = 'degraded';
        reason =
          'some models cooling and some models have recent failed registry status';
      } else if (cooledModels.length > 0) {
        status = 'degraded';
        reason = 'some models cooling; route is running on reduced chain';
      } else if (recentFailedModels.length > 0) {
        status = 'degraded';
        reason = 'some models have recent failed registry status';
      } else {
        status = 'healthy';
        reason = 'route chain available';
      }

      diagnostics.push({
        category,
        lane,
        status,
        configuredModels,
        allowedModels,
        cooledModels,
        recentFailedModels,
        preferredModel: configuredModels[0],
        effectiveModel:
          allowedModels.find(
            (model) => !cooled.has(model) && !recentlyFailed.has(model),
          ) ?? allowedModels.find((model) => !cooled.has(model)),
        reason,
      });
    }
  }

  return diagnostics;
}
