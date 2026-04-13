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
  firstSeenAt: string;
  lastSeenAt: string;
  lastStatus: 'alive' | 'failed' | 'unknown';
  lastProbeAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  lastLatencyMs?: number;
  successCount: number;
  failureCount: number;
  probeCount: number;
  sources: RegistryEventSource[];
}

export interface ModelRegistryData {
  version: 1;
  updatedAt: string;
  models: Record<string, ModelRegistryEntry>;
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
  }): void {
    this.updateModel(args.model, (entry) => {
      const now = new Date().toISOString();
      entry.lastStatus = 'alive';
      entry.lastSuccessAt = now;
      entry.lastError = undefined;
      entry.lastLatencyMs = args.latencyMs;
      entry.successCount += 1;
      if (args.probe) {
        entry.lastProbeAt = now;
        entry.probeCount += 1;
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
  }): void {
    this.updateModel(args.model, (entry) => {
      const now = new Date().toISOString();
      entry.lastStatus = 'failed';
      entry.lastFailureAt = now;
      entry.lastError = args.error;
      entry.lastLatencyMs = args.latencyMs;
      entry.failureCount += 1;
      if (args.probe) {
        entry.lastProbeAt = now;
        entry.probeCount += 1;
      }
      if (!entry.sources.includes(args.source)) {
        entry.sources.push(args.source);
      }
    });
  }
}
