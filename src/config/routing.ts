import type { PluginConfig, RoutingLane } from './schema';

export const ROUTING_LANES = ['cheap', 'value', 'premium'] as const;

export interface ResolvedCategoryRoute {
  agent?: string;
  lane?: RoutingLane;
  modelChain: string[];
  promptAppend?: string;
}

const LANE_GUIDANCE: Record<RoutingLane, string> = {
  cheap:
    'Prefer the fastest acceptable path. Keep scope bounded, avoid over-research, and optimize for low retry cost.',
  value:
    'Balance correctness, speed, and token cost. Do enough reasoning to avoid wasteful retries, but avoid premium-level depth unless the task clearly needs it.',
  premium:
    'Prioritize correctness, robustness, and high-confidence decisions over token cost. Use deeper reasoning and stronger verification before concluding.',
};

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
      promptAppend: undefined,
    };
  }

  const laneConfig = categoryConfig[defaultLane];
  if (!laneConfig) {
    return {
      agent: categoryConfig.agent,
      lane: defaultLane,
      modelChain: [],
      promptAppend: undefined,
    };
  }

  return {
    agent: laneConfig.agent ?? categoryConfig.agent,
    lane: defaultLane,
    modelChain: dedupeModels(normalizeModelChain(laneConfig.model)),
    promptAppend:
      typeof laneConfig.promptAppend === 'string'
        ? laneConfig.promptAppend.trim() || undefined
        : undefined,
  };
}

export function buildRoutedPrompt(args: {
  prompt: string;
  category?: string;
  lane?: RoutingLane;
  agent?: string;
  promptAppend?: string;
}): string {
  const blocks: string[] = [];

  if (args.category || args.lane || args.agent || args.promptAppend) {
    blocks.push('<routing_context>');
    if (args.category) {
      blocks.push(`category=${args.category}`);
    }
    if (args.lane) {
      blocks.push(`lane=${args.lane}`);
      blocks.push(`lane_guidance=${LANE_GUIDANCE[args.lane]}`);
    }
    if (args.agent) {
      blocks.push(`resolved_agent=${args.agent}`);
    }
    if (args.promptAppend) {
      blocks.push(`route_instruction=${args.promptAppend}`);
    }
    blocks.push('</routing_context>');
  }

  return blocks.length > 0
    ? `${blocks.join('\n')}\n\n---\n\n${args.prompt}`
    : args.prompt;
}
