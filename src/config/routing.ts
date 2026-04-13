import type { PluginConfig, RoutingLane } from './schema';

export const ROUTING_LANES = ['cheap', 'value', 'premium'] as const;

export interface ResolvedCategoryRoute {
  agent?: string;
  lane?: RoutingLane;
  modelChain: string[];
}

function normalizeLane(value: string | null | undefined): RoutingLane | undefined {
  if (!value) return undefined;

  const normalized = value.trim().toLowerCase();
  return ROUTING_LANES.includes(normalized as RoutingLane)
    ? (normalized as RoutingLane)
    : undefined;
}

export function isValidRoutingLane(
  value: string | null | undefined,
): value is RoutingLane {
  return normalizeLane(value) !== undefined;
}

export function getValidRoutingLanesString(): string {
  return ROUTING_LANES.join(', ');
}

function normalizeModelChain(model: unknown): string[] {
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

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const model of models) {
    if (seen.has(model)) continue;
    seen.add(model);
    deduped.push(model);
  }

  return deduped;
}

export function resolveCategoryRoute(
  config: PluginConfig | undefined,
  category: string,
  requestedLane?: string,
): ResolvedCategoryRoute {
  const routingConfig = config?.routing;
  const categoryConfig = routingConfig?.categories?.[category];
  const defaultLane =
    normalizeLane(requestedLane) ??
    normalizeLane(categoryConfig?.defaultLane) ??
    normalizeLane(routingConfig?.defaultLane);

  if (!categoryConfig || !defaultLane) {
    return {
      agent: categoryConfig?.agent,
      lane: defaultLane,
      modelChain: [],
    };
  }

  const laneConfig = categoryConfig[defaultLane];
  if (!laneConfig) {
    return {
      agent: categoryConfig.agent,
      lane: defaultLane,
      modelChain: [],
    };
  }

  return {
    agent: laneConfig.agent ?? categoryConfig.agent,
    lane: defaultLane,
    modelChain: dedupeModels(normalizeModelChain(laneConfig.model)),
  };
}
