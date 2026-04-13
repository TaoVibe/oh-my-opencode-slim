import { buildModelKeyAliases } from '../cli/model-key-normalization';
import type { PluginConfig } from './schema';

function getModelKeyCandidates(model: string): string[] {
  return [model, ...buildModelKeyAliases(model)];
}

export function isModelPolicyEnabled(config?: PluginConfig): boolean {
  return config?.modelPolicy?.enforceAllowlist === true;
}

export function isFreeStack(config?: PluginConfig): boolean {
  return config?.stackMode === 'free';
}

export function isStrictFreeStack(config?: PluginConfig): boolean {
  return isFreeStack(config) && isModelPolicyEnabled(config);
}

export function getAllowedModels(config?: PluginConfig): Set<string> {
  return new Set(config?.modelPolicy?.allowedModels ?? []);
}

export function isModelAllowed(
  model: string | undefined,
  config?: PluginConfig,
): boolean {
  if (!model) {
    return !isModelPolicyEnabled(config);
  }

  if (!isModelPolicyEnabled(config)) {
    return true;
  }

  const allowed = getAllowedModels(config);
  return getModelKeyCandidates(model).some((candidate) => allowed.has(candidate));
}

export function filterAllowedModels(
  models: string[],
  config?: PluginConfig,
): string[] {
  if (!isModelPolicyEnabled(config)) {
    return models;
  }

  const allowed = getAllowedModels(config);
  return models.filter((model) =>
    getModelKeyCandidates(model).some((candidate) => allowed.has(candidate)),
  );
}

export function getModelPolicyBlockMessage(
  model: string,
  context: string,
): string {
  return `Model policy blocked ${model} for ${context}`;
}

export function assertModelAllowed(
  model: string | undefined,
  config: PluginConfig | undefined,
  context: string,
): void {
  if (!model || isModelAllowed(model, config)) {
    return;
  }

  throw new Error(getModelPolicyBlockMessage(model, context));
}

export function shouldFailClosed(config?: PluginConfig): boolean {
  if (!isModelPolicyEnabled(config)) {
    return false;
  }

  return config?.modelPolicy?.failClosed !== false;
}
