import type { ClaudeHooksConfig, HookMatcher } from './types';

function escapeRegexExceptAsterisk(str: string): string {
  return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

const regexCache = new Map<string, RegExp>();

export function matchesToolMatcher(toolName: string, matcher: string): boolean {
  if (!matcher) {
    return true;
  }
  const patterns = matcher.split('|').map((pattern) => pattern.trim());
  return patterns.some((pattern) => {
    if (pattern.includes('*')) {
      let regex = regexCache.get(pattern);
      if (!regex) {
        const escaped = escapeRegexExceptAsterisk(pattern);
        regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
        regexCache.set(pattern, regex);
      }
      return regex.test(toolName);
    }
    return pattern.toLowerCase() === toolName.toLowerCase();
  });
}

export function findMatchingHooks(
  config: ClaudeHooksConfig,
  eventName: keyof ClaudeHooksConfig,
  toolName?: string,
): HookMatcher[] {
  const hookMatchers = config[eventName];
  if (!hookMatchers) return [];

  return hookMatchers.filter((hookMatcher) => {
    if (!toolName) return true;
    return matchesToolMatcher(toolName, hookMatcher.matcher);
  });
}
