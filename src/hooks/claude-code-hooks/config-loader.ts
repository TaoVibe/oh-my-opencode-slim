import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../utils/logger';
import type { ClaudeHookEvent, PluginExtendedConfig } from './types';

const CONFIG_CACHE_TTL_MS = 30_000;

interface PluginExtendedConfigCacheEntry {
  value: PluginExtendedConfig;
  cachedAt: number;
}

const configCache = new Map<string, PluginExtendedConfigCacheEntry>();

function getOpenCodeConfigDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return join(home, '.config', 'opencode');
}

function getUserConfigPath(): string {
  return join(getOpenCodeConfigDir(), 'opencode-cc-plugin.json');
}

function getProjectConfigPath(): string {
  return join(process.cwd(), '.opencode', 'opencode-cc-plugin.json');
}

function getCacheKey(customConfigPath?: string): string {
  return `${process.cwd()}::${customConfigPath ?? getUserConfigPath()}`;
}

function getCachedConfig(cacheKey: string): PluginExtendedConfig | undefined {
  const cachedEntry = configCache.get(cacheKey);
  if (!cachedEntry) return undefined;
  if (Date.now() - cachedEntry.cachedAt >= CONFIG_CACHE_TTL_MS) {
    configCache.delete(cacheKey);
    return undefined;
  }
  return cachedEntry.value;
}

export function clearPluginExtendedConfigCache(): void {
  configCache.clear();
}

async function loadConfigFromPath(
  path: string,
): Promise<PluginExtendedConfig | null> {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await Bun.file(path).text();
    return JSON.parse(content) as PluginExtendedConfig;
  } catch (error) {
    log('Failed to load Claude hook extended config', { path, error });
    return null;
  }
}

function mergeDisabledHooks(
  base: PluginExtendedConfig['disabledHooks'],
  override: PluginExtendedConfig['disabledHooks'],
): PluginExtendedConfig['disabledHooks'] {
  if (!override) return base ?? {};
  if (!base) return override;
  return { ...base, ...override };
}

export async function loadPluginExtendedConfig(
  customConfigPath?: string,
): Promise<PluginExtendedConfig> {
  const cacheKey = getCacheKey(customConfigPath);
  const cachedConfig = getCachedConfig(cacheKey);
  if (cachedConfig) {
    return cachedConfig;
  }

  const userConfig = await loadConfigFromPath(
    customConfigPath ?? getUserConfigPath(),
  );
  const projectConfig = await loadConfigFromPath(getProjectConfigPath());

  const merged: PluginExtendedConfig = {
    disabledHooks: mergeDisabledHooks(
      userConfig?.disabledHooks,
      projectConfig?.disabledHooks,
    ),
  };

  configCache.set(cacheKey, { value: merged, cachedAt: Date.now() });
  return merged;
}

const regexCache = new Map<string, RegExp>();

function getRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    try {
      regex = new RegExp(pattern);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    regexCache.set(pattern, regex);
  }
  return regex;
}

export function isHookCommandDisabled(
  eventType: ClaudeHookEvent,
  command: string,
  config: PluginExtendedConfig | null,
): boolean {
  const patterns = config?.disabledHooks?.[eventType];
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => getRegex(pattern).test(command));
}
