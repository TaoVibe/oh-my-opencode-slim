import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getModelRegistryPath } from '../cli/paths';
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

function recencyScore(timestamp?: string): number {
  if (!timestamp) {
    return 0;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyRegistry(): ModelRegistryData {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    models: {},
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
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as
        | ModelRegistryData
        | undefined;
      if (!parsed || typeof parsed !== 'object' || !parsed.models) {
        return emptyRegistry();
      }
      return {
        version: 1,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date().toISOString(),
        models: parsed.models ?? {},
      };
    } catch {
      return emptyRegistry();
    }
  }

  getBiasedModelChain(models: string[]): string[] {
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
