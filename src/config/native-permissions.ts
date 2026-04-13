import * as fs from 'node:fs';
import type { FeatureFlags } from './schema';
import { getExistingConfigPath } from '../cli/paths';
import { stripJsonComments } from '../cli/config-io';

type PermissionValue =
  | 'ask'
  | 'allow'
  | 'deny'
  | Record<string, 'ask' | 'allow' | 'deny'>;

export function applyNativePermissionHints(
  permission: Record<string, PermissionValue>,
  featureFlags?: FeatureFlags,
): Record<string, PermissionValue> {
  if (!featureFlags?.nativeBashAskAll) {
    return permission;
  }

  if ('bash' in permission) {
    return permission;
  }

  return {
    ...permission,
    bash: 'ask',
  };
}

interface OpenCodeConfig {
  permission?: {
    bash?: Record<string, 'ask' | 'allow' | 'deny' | string>;
  };
}

/**
 * Load bash permission patterns from opencode.json.
 * Returns arrays of explicitly allowed and denied command patterns.
 */
export function loadBashPermissionsFromOpenCodeConfig(): {
  allow: string[];
  deny: string[];
} {
  const configPath = getExistingConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      return { allow: [], deny: [] };
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const rawConfig = JSON.parse(stripJsonComments(content)) as OpenCodeConfig;

    const bashPerms = rawConfig.permission?.bash;
    if (!bashPerms) {
      return { allow: [], deny: [] };
    }

    const allow: string[] = [];
    const deny: string[] = [];

    for (const [pattern, value] of Object.entries(bashPerms)) {
      // Skip the catch-all "*" pattern
      if (pattern === '*') continue;

      const permissionValue = typeof value === 'string' ? value : String(value);

      if (permissionValue === 'allow') {
        allow.push(pattern);
      } else if (permissionValue === 'deny') {
        deny.push(pattern);
      }
      // 'ask' patterns don't need to be tracked - they're the default behavior
    }

    return { allow, deny };
  } catch {
    // Config doesn't exist or is invalid - return empty
    return { allow: [], deny: [] };
  }
}
