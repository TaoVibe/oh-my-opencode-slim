import type { PluginConfig } from './schema';

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

  return getAllowedModels(config).has(model);
}

export function filterAllowedModels(
  models: string[],
  config?: PluginConfig,
): string[] {
  if (!isModelPolicyEnabled(config)) {
    return models;
  }

  const allowed = getAllowedModels(config);
  return models.filter((model) => allowed.has(model));
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
