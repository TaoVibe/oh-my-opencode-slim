import { filterAllowedModels } from './model-policy';
import type { ModelHealthSnapshot } from '../utils/model-health';
import type { PluginConfig, RoutingLane } from './schema';

export interface RouteDiagnostic {
  category: string;
  lane: RoutingLane;
  status: 'healthy' | 'degraded' | 'blocked';
  configuredModels: string[];
  allowedModels: string[];
  cooledModels: string[];
  preferredModel?: string;
  effectiveModel?: string;
  reason: string;
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
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function buildRoutingDiagnostics(
  config: PluginConfig | undefined,
  healthSnapshots: ModelHealthSnapshot[],
): RouteDiagnostic[] {
  const categories = config?.routing?.categories ?? {};
  const cooled = new Set(
    healthSnapshots.filter((item) => item.isCooling).map((item) => item.model),
  );
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
      } else if (cooledModels.length > 0) {
        status = 'degraded';
        reason = 'some models cooling; route is running on reduced chain';
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
        preferredModel: configuredModels[0],
        effectiveModel: allowedModels.find((model) => !cooled.has(model)),
        reason,
      });
    }
  }

  return diagnostics;
}
