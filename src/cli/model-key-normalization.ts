function cleanupAlias(input: string, preserveSlash: boolean): string {
  let value = input.toLowerCase().trim();
  value = value.replace(/\bfp[a-z0-9.-]*\b/g, ' ');
  value = value.replace(/\btee\b/g, ' ');

  if (preserveSlash) {
    value = value.replace(/[_\s]+/g, '-');
    value = value.replace(/-+/g, '-');
    value = value.replace(/\/+/g, '/');
    value = value.replace(/\/-+/g, '/');
    value = value.replace(/-+\//g, '/');
    value = value.replace(/^\/+|\/+$/g, '');
    value = value.replace(/^-+|-+$/g, '');
    return value;
  }

  value = value.replace(/[/_\s]+/g, '-');
  value = value.replace(/-+/g, '-');
  value = value.replace(/^-+|-+$/g, '');
  return value;
}

const CHUTES_VENDOR_PREFIXES = [
  'qwen/',
  'deepseek-ai/',
  'zai-org/',
  'xiaomimimo/',
  'nousresearch/',
  'unsloth/',
  'moonshotai/',
  'minimaxai/',
  'mistralai/',
  'opengvlab/',
  'nvidia/',
  'tngtech/',
  'miromind-ai/',
  'rednote-hilab/',
] as const;

function maybePrefixChutes(value: string): string {
  if (value.startsWith('chutes/')) {
    return value;
  }

  return CHUTES_VENDOR_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? `chutes/${value}`
    : value;
}

function addDerivedAliases(seed: string, aliases: Set<string>): void {
  const slashAlias = cleanupAlias(seed, true);
  const flatAlias = cleanupAlias(seed, false);

  if (slashAlias) aliases.add(slashAlias);
  if (flatAlias) aliases.add(flatAlias);

  if (slashAlias) {
    aliases.add(slashAlias.replace(/-(free|flash)$/i, ''));
  }
  if (flatAlias) {
    aliases.add(flatAlias.replace(/-(free|flash)$/i, ''));
  }

  if (slashAlias.includes('/')) {
    aliases.add(cleanupAlias(slashAlias.replace(/\//g, ' '), false));
    aliases.add(cleanupAlias(slashAlias.replace(/\//g, '-'), false));
    const lastPart = slashAlias.split('/').at(-1);
    if (lastPart) {
      addDerivedAliases(lastPart, aliases);
    }
  }
}

export function buildModelKeyAliases(input: string): string[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return [];

  const aliases = new Set<string>();
  const chutesNormalized = maybePrefixChutes(normalized);
  const slashIndex = chutesNormalized.indexOf('/');
  const afterProvider =
    slashIndex >= 0 ? chutesNormalized.slice(slashIndex + 1) : chutesNormalized;

  addDerivedAliases(chutesNormalized, aliases);
  addDerivedAliases(afterProvider, aliases);
  if (chutesNormalized.startsWith('chutes/')) {
    addDerivedAliases(chutesNormalized.slice('chutes/'.length), aliases);
  }

  return [...aliases].filter((alias) => alias.length > 0);
}
