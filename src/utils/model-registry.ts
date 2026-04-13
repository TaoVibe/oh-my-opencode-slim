import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getModelRegistryPath } from '../cli/paths';
import { buildModelKeyAliases } from '../cli/model-key-normalization';
import { parseModelReference } from './session';

export type RegistryEventSource =
  | 'probe'
  | 'background'
  | 'foreground'
  | 'routing';

export interface ModelRegistryEntry {
  model: string;
  providerID: string;
  modelID: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUsedAt?: string;
  lastStatus: 'alive' | 'failed' | 'unknown';
  lastProbeAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastLatencyMs?: number;
  totalLatencyMs?: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  probeCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  sources: RegistryEventSource[];
}

export interface ModelRegistryData {
  version: 1;
  updatedAt: string;
  models: Record<string, ModelRegistryEntry>;
}

export type RouteBiasLane = 'cheap' | 'value' | 'premium';

function recencyScore(timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataNumber(entry: ModelRegistryEntry | undefined, key: string): number {
  const value = entry?.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function metadataBoolean(entry: ModelRegistryEntry | undefined, key: string): boolean {
  return entry?.metadata?.[key] === true;
}

function laneMetadataScore(
  lane: RouteBiasLane | undefined,
  entry: ModelRegistryEntry | undefined,
): number {
  if (!lane || !entry) {
    return 0;
  }

  const inputPrice = metadataNumber(entry, 'inputUsdPerM');
  const outputPrice = metadataNumber(entry, 'outputUsdPerM');
  const contextWindow = metadataNumber(entry, 'contextWindow');
  const supportsTools = metadataBoolean(entry, 'supportsTools');
  const supportsReasoning = metadataBoolean(entry, 'supportsReasoning');
  const averageLatencyMs =
    entry && entry.requestCount > 0 && entry.totalLatencyMs !== undefined
      ? entry.totalLatencyMs / entry.requestCount
      : 0;
  const latencyPenaltyCheap = averageLatencyMs / 20_000;
  const latencyPenaltyValue = averageLatencyMs / 40_000;
  const latencyPenaltyPremium = averageLatencyMs / 80_000;

  if (lane === 'cheap') {
    return (
      contextWindow / 1_000_000 -
      inputPrice * 4 -
      outputPrice * 2 -
      latencyPenaltyCheap
    );
  }

  if (lane === 'value') {
    return (
      contextWindow / 500_000 +
      (supportsTools ? 1 : 0) +
      (supportsReasoning ? 0.5 : 0) -
      inputPrice * 2 -
      outputPrice -
      latencyPenaltyValue
    );
  }

  return (
    contextWindow / 250_000 +
    (supportsTools ? 1 : 0) +
    (supportsReasoning ? 1 : 0) -
    inputPrice * 0.5 -
    outputPrice * 0.25 -
    latencyPenaltyPremium
  );
}

function emptyRegistry(): ModelRegistryData {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    models: {},
  };
}

function getCanonicalRegistryKey(model: string): string {
  const aliases = buildModelKeyAliases(model);
  const chutesAlias = aliases.find((alias) => alias.startsWith('chutes/'));
  if (chutesAlias) {
    const parsed = parseModelReference(chutesAlias);
    if (parsed) {
      return `${parsed.providerID}/${parsed.modelID}`;
    }
  }
  return model;
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeEntry(entry: ModelRegistryEntry): ModelRegistryEntry {
  return {
    ...entry,
    requestCount: normalizeCount(entry.requestCount),
    successCount: normalizeCount(entry.successCount),
    failureCount: normalizeCount(entry.failureCount),
    probeCount: normalizeCount(entry.probeCount),
    totalLatencyMs:
      typeof entry.totalLatencyMs === 'number' && Number.isFinite(entry.totalLatencyMs)
        ? entry.totalLatencyMs
        : undefined,
  };
}

function mergeEntries(
  left: ModelRegistryEntry | undefined,
  right: ModelRegistryEntry,
): ModelRegistryEntry {
  if (!left) {
    return normalizeEntry(right);
  }

  const preferred = recencyScore(left.lastSeenAt) >= recencyScore(right.lastSeenAt) ? left : right;
  const aliases = new Set([...(left.aliases ?? []), ...(right.aliases ?? []), right.model, left.model]);
  const sources = new Set([...(left.sources ?? []), ...(right.sources ?? [])]);

  return normalizeEntry({
    ...preferred,
    model: preferred.model,
    aliases: [...aliases].sort(),
    metadata: {
      ...(left.metadata ?? {}),
      ...(right.metadata ?? {}),
    },
    firstSeenAt:
      recencyScore(left.firstSeenAt) <= recencyScore(right.firstSeenAt)
        ? left.firstSeenAt
        : right.firstSeenAt,
    successCount: normalizeCount(left.successCount) + normalizeCount(right.successCount),
    failureCount: normalizeCount(left.failureCount) + normalizeCount(right.failureCount),
    probeCount: normalizeCount(left.probeCount) + normalizeCount(right.probeCount),
    requestCount: normalizeCount(left.requestCount) + normalizeCount(right.requestCount),
    totalLatencyMs:
      (typeof left.totalLatencyMs === 'number' ? left.totalLatencyMs : 0) +
        (typeof right.totalLatencyMs === 'number' ? right.totalLatencyMs : 0) ||
      undefined,
    totalInputTokens:
      ((left.totalInputTokens ?? 0) + (right.totalInputTokens ?? 0)) || undefined,
    totalOutputTokens:
      ((left.totalOutputTokens ?? 0) + (right.totalOutputTokens ?? 0)) || undefined,
    totalTokens: ((left.totalTokens ?? 0) + (right.totalTokens ?? 0)) || undefined,
    totalCostUsd:
      ((left.totalCostUsd ?? 0) + (right.totalCostUsd ?? 0)) || undefined,
    sources: [...sources],
  });
}

function normalizeRegistryData(data: ModelRegistryData): ModelRegistryData {
  const merged: Record<string, ModelRegistryEntry> = {};

  for (const entry of Object.values(data.models ?? {})) {
    const normalized = normalizeEntry(entry);
    const key = getCanonicalRegistryKey(normalized.model);
    merged[key] = mergeEntries(merged[key], {
      ...normalized,
      model: key,
      providerID: parseModelReference(key)?.providerID ?? normalized.providerID,
      modelID: parseModelReference(key)?.modelID ?? normalized.modelID,
    });
  }

  return {
    version: 1,
    updatedAt: data.updatedAt,
    models: merged,
  };
}

function ensureDirForFile(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class ModelRegistryStore {
  constructor(private readonly filePath = getModelRegistryPath()) {}

  getPath(): string {
    return this.filePath;
  }

  load(): ModelRegistryData {
    if (!existsSync(this.filePath)) {
      return emptyRegistry();
    }

    try {
      const rawText = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(rawText) as
        | ModelRegistryData
        | undefined;
      if (!parsed || typeof parsed !== 'object' || !parsed.models) {
        return emptyRegistry();
      }
      const normalized = normalizeRegistryData({
        version: 1,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
        models: parsed.models ?? {},
      });
      const normalizedText = `${JSON.stringify(normalized, null, 2)}\n`;
      if (normalizedText !== rawText) {
        this.save(normalized);
      }
      return normalized;
    } catch {
      return emptyRegistry();
    }
  }

  getBiasedModelChain(models: string[], lane?: RouteBiasLane): string[] {
    const data = this.load();

    return [...models].sort((left, right) => {
      const leftEntry = data.models[left];
      const rightEntry = data.models[right];

      const leftStatus = leftEntry?.lastStatus === 'alive' ? 2 : leftEntry?.lastStatus === 'failed' ? 0 : 1;
      const rightStatus = rightEntry?.lastStatus === 'alive' ? 2 : rightEntry?.lastStatus === 'failed' ? 0 : 1;
      if (leftStatus !== rightStatus) {
        return rightStatus - leftStatus;
      }

      const leftRecency = Math.max(
        recencyScore(leftEntry?.lastSuccessAt),
        recencyScore(leftEntry?.lastSeenAt),
      );
      const rightRecency = Math.max(
        recencyScore(rightEntry?.lastSuccessAt),
        recencyScore(rightEntry?.lastSeenAt),
      );
      if (leftRecency !== rightRecency) {
        return rightRecency - leftRecency;
      }

      const leftRequests = leftEntry?.requestCount ?? 0;
      const rightRequests = rightEntry?.requestCount ?? 0;
      if (leftRequests !== rightRequests) {
        return rightRequests - leftRequests;
      }

      const leftMetadataScore = laneMetadataScore(lane, leftEntry);
      const rightMetadataScore = laneMetadataScore(lane, rightEntry);
      if (leftMetadataScore !== rightMetadataScore) {
        return rightMetadataScore - leftMetadataScore;
      }

      return 0;
    });
  }

  save(data: ModelRegistryData): void {
    ensureDirForFile(this.filePath);
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private updateModel(
    model: string,
    updater: (entry: ModelRegistryEntry) => void,
  ): void {
    const ref = parseModelReference(model);
    if (!ref) {
      return;
    }

    const data = this.load();
    const now = new Date().toISOString();
    const entry =
      data.models[model] ??
      ({
        model,
        providerID: ref.providerID,
        modelID: ref.modelID,
        firstSeenAt: now,
        lastSeenAt: now,
        lastStatus: 'unknown',
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        probeCount: 0,
        sources: [],
      } satisfies ModelRegistryEntry);

    entry.lastSeenAt = now;
    updater(entry);
    data.models[model] = entry;
    data.updatedAt = now;
    this.save(data);
  }

  recordSuccess(args: {
    model: string;
    source: RegistryEventSource;
    latencyMs?: number;
    probe?: boolean;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  }): void {
    this.updateModel(args.model, (entry) => {
      const now = new Date().toISOString();
      entry.lastStatus = 'alive';
      entry.lastUsedAt = now;
      entry.lastSuccessAt = now;
      entry.lastError = undefined;
      entry.lastLatencyMs = args.latencyMs;
      entry.totalLatencyMs = (entry.totalLatencyMs ?? 0) + (args.latencyMs ?? 0);
      entry.requestCount += 1;
      entry.successCount += 1;
      if (args.probe) {
        entry.lastProbeAt = now;
        entry.probeCount += 1;
      }
      if (args.usage) {
        entry.totalInputTokens =
          (entry.totalInputTokens ?? 0) + (args.usage.inputTokens ?? 0);
        entry.totalOutputTokens =
          (entry.totalOutputTokens ?? 0) + (args.usage.outputTokens ?? 0);
        entry.totalTokens = (entry.totalTokens ?? 0) + (args.usage.totalTokens ?? 0);
        entry.totalCostUsd = (entry.totalCostUsd ?? 0) + (args.usage.costUsd ?? 0);
      }
      if (!entry.sources.includes(args.source)) {
        entry.sources.push(args.source);
      }
    });
  }

  recordFailure(args: {
    model: string;
    source: RegistryEventSource;
    error: string;
    latencyMs?: number;
    probe?: boolean;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    };
  }): void {
    this.updateModel(args.model, (entry) => {
      const now = new Date().toISOString();
      entry.lastStatus = 'failed';
      entry.lastUsedAt = now;
      entry.lastFailureAt = now;
      entry.lastError = args.error;
      entry.lastLatencyMs = args.latencyMs;
      entry.totalLatencyMs = (entry.totalLatencyMs ?? 0) + (args.latencyMs ?? 0);
      entry.requestCount += 1;
      entry.failureCount += 1;
      if (args.probe) {
        entry.lastProbeAt = now;
        entry.probeCount += 1;
      }
      if (args.usage) {
        entry.totalInputTokens =
          (entry.totalInputTokens ?? 0) + (args.usage.inputTokens ?? 0);
        entry.totalOutputTokens =
          (entry.totalOutputTokens ?? 0) + (args.usage.outputTokens ?? 0);
        entry.totalTokens = (entry.totalTokens ?? 0) + (args.usage.totalTokens ?? 0);
        entry.totalCostUsd = (entry.totalCostUsd ?? 0) + (args.usage.costUsd ?? 0);
      }
      if (!entry.sources.includes(args.source)) {
        entry.sources.push(args.source);
      }
    });
  }

  upsertMetadata(args: {
    model: string;
    aliases?: string[];
    metadata?: Record<string, unknown>;
    source?: RegistryEventSource;
  }): void {
    this.updateModel(args.model, (entry) => {
      if (args.aliases && args.aliases.length > 0) {
        const merged = new Set([...(entry.aliases ?? []), ...args.aliases]);
        entry.aliases = [...merged].sort();
      }
      if (args.metadata && Object.keys(args.metadata).length > 0) {
        entry.metadata = {
          ...(entry.metadata ?? {}),
          ...args.metadata,
        };
      }
      if (args.source && !entry.sources.includes(args.source)) {
        entry.sources.push(args.source);
      }
    });
  }
}
