function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function transformObjectKeys(
  obj: Record<string, unknown>,
  transformer: (key: string) => string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const transformedKey = transformer(key);
    if (isPlainObject(value)) {
      result[transformedKey] = transformObjectKeys(value, transformer);
    } else if (Array.isArray(value)) {
      result[transformedKey] = value.map((item) =>
        isPlainObject(item) ? transformObjectKeys(item, transformer) : item,
      );
    } else {
      result[transformedKey] = value;
    }
  }
  return result;
}

const SPECIAL_TOOL_MAPPINGS: Record<string, string> = {
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todoread: 'TodoRead',
  todowrite: 'TodoWrite',
};

function toPascalCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

export function transformToolName(toolName: string): string {
  const trimmed = toolName.trim();
  const lower = trimmed.toLowerCase();
  if (lower in SPECIAL_TOOL_MAPPINGS) {
    return SPECIAL_TOOL_MAPPINGS[lower];
  }

  if (trimmed.includes('-') || trimmed.includes('_')) {
    return toPascalCase(trimmed);
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function objectToSnakeCase(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  return transformObjectKeys(obj, camelToSnake);
}
