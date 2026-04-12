import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeHooksConfig, HookAction, HookMatcher } from './types';

const CONFIG_CACHE_TTL_MS = 30_000;

interface ClaudeHooksConfigCacheEntry {
  value: ClaudeHooksConfig | null;
  cachedAt: number;
}

interface RawHookMatcher {
  matcher?: string;
  pattern?: string;
  hooks: HookAction[];
}

interface RawClaudeHooksConfig {
  PreToolUse?: RawHookMatcher[];
  PostToolUse?: RawHookMatcher[];
  UserPromptSubmit?: RawHookMatcher[];
  SessionStart?: RawHookMatcher[];
  SubagentStart?: RawHookMatcher[];
  SubagentStop?: RawHookMatcher[];
}

const configCache = new Map<string, ClaudeHooksConfigCacheEntry>();

function normalizeHookMatcher(raw: RawHookMatcher): HookMatcher {
  return {
    matcher: raw.matcher ?? raw.pattern ?? '*',
    hooks: Array.isArray(raw.hooks) ? raw.hooks : [],
  };
}

function normalizeHooksConfig(raw: RawClaudeHooksConfig): ClaudeHooksConfig {
  const result: ClaudeHooksConfig = {};
  const eventTypes: (keyof RawClaudeHooksConfig)[] = [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SessionStart',
    'SubagentStart',
    'SubagentStop',
  ];

  for (const eventType of eventTypes) {
    if (raw[eventType]) {
      result[eventType] = raw[eventType].map(normalizeHookMatcher);
    }
  }

  return result;
}

function getClaudeConfigDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return join(home, '.claude');
}

export function getClaudeSettingsPaths(customPath?: string): string[] {
  const paths = [
    join(getClaudeConfigDir(), 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];

  if (customPath && existsSync(customPath)) {
    paths.unshift(customPath);
  }

  return [...new Set(paths)];
}

function getCacheKey(customSettingsPath?: string): string {
  return `${process.cwd()}::${customSettingsPath ?? ''}`;
}

function getCachedConfig(
  cacheKey: string,
): ClaudeHooksConfig | null | undefined {
  const cachedEntry = configCache.get(cacheKey);
  if (!cachedEntry) {
    return undefined;
  }

  if (Date.now() - cachedEntry.cachedAt >= CONFIG_CACHE_TTL_MS) {
    configCache.delete(cacheKey);
    return undefined;
  }

  return cachedEntry.value;
}

export function clearClaudeHooksConfigCache(): void {
  configCache.clear();
}

function mergeHooksConfig(
  base: ClaudeHooksConfig,
  override: ClaudeHooksConfig,
): ClaudeHooksConfig {
  const result: ClaudeHooksConfig = { ...base };
  const eventTypes: (keyof ClaudeHooksConfig)[] = [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SessionStart',
    'SubagentStart',
    'SubagentStop',
  ];

  for (const eventType of eventTypes) {
    if (override[eventType]) {
      result[eventType] = [...(base[eventType] || []), ...override[eventType]];
    }
  }

  return result;
}

export async function loadClaudeHooksConfig(
  customSettingsPath?: string,
): Promise<ClaudeHooksConfig | null> {
  const cacheKey = getCacheKey(customSettingsPath);
  const cachedConfig = getCachedConfig(cacheKey);
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const paths = getClaudeSettingsPaths(customSettingsPath);
  let mergedConfig: ClaudeHooksConfig = {};

  for (const settingsPath of paths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const content = await Bun.file(settingsPath).text();
      const settings = JSON.parse(content) as { hooks?: RawClaudeHooksConfig };
      if (!settings.hooks) continue;
      const normalizedHooks = normalizeHooksConfig(settings.hooks);
      mergedConfig = mergeHooksConfig(mergedConfig, normalizedHooks);
    } catch {}
  }

  const resolvedConfig =
    Object.keys(mergedConfig).length > 0 ? mergedConfig : null;
  configCache.set(cacheKey, {
    value: resolvedConfig,
    cachedAt: Date.now(),
  });
  return resolvedConfig;
}
