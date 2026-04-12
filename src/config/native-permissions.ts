import type { FeatureFlags } from './schema';

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
