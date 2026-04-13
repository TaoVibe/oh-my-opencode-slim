import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getPackageRoot(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
          name?: string;
        };
        if (pkg.name === 'oh-my-opencode-slim') {
          return currentDir;
        }
      } catch {
        // Ignore invalid package.json files while walking upward.
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return dirname(fileURLToPath(import.meta.url));
    }
    currentDir = parentDir;
  }
}

function getDefaultOpenCodeConfigDir(): string {
  const userConfigDir = process.env.XDG_CONFIG_HOME
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), '.config');

  return join(userConfigDir, 'opencode');
}

function getCustomOpenCodeConfigDir(): string | undefined {
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  return configDir || undefined;
}

/**
 * Get the OpenCode plugin config directory.
 *
 * Resolution order:
 * 1. OPENCODE_CONFIG_DIR (custom OpenCode directory)
 * 2. XDG_CONFIG_HOME/opencode
 * 3. ~/.config/opencode
 */
export function getConfigDir(): string {
  const customConfigDir = getCustomOpenCodeConfigDir();
  if (customConfigDir) {
    return customConfigDir;
  }

  return getDefaultOpenCodeConfigDir();
}

/**
 * Get OpenCode config directories in read/search order.
 *
 * Resolution order:
 * 1. OPENCODE_CONFIG_DIR (if set)
 * 2. XDG_CONFIG_HOME/opencode or ~/.config/opencode
 *
 * Duplicate entries are removed.
 */
export function getConfigSearchDirs(): string[] {
  const dirs = [getCustomOpenCodeConfigDir(), getDefaultOpenCodeConfigDir()];

  return dirs.filter((dir, index): dir is string => {
    return Boolean(dir) && dirs.indexOf(dir) === index;
  });
}

export function getOpenCodeConfigPaths(): string[] {
  const configDir = getDefaultOpenCodeConfigDir();
  return [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')];
}

export function getConfigJson(): string {
  return getOpenCodeConfigPaths()[0];
}

export function getConfigJsonc(): string {
  return getOpenCodeConfigPaths()[1];
}

export function getLiteConfig(): string {
  return join(getConfigDir(), 'oh-my-opencode-slim.json');
}

export function getLiteConfigJsonc(): string {
  return join(getConfigDir(), 'oh-my-opencode-slim.jsonc');
}

export function getExistingLiteConfigPath(): string {
  const jsonPath = getLiteConfig();
  if (existsSync(jsonPath)) return jsonPath;

  const jsoncPath = getLiteConfigJsonc();
  if (existsSync(jsoncPath)) return jsoncPath;

  return jsonPath;
}

export function getExistingConfigPath(): string {
  const jsonPath = getConfigJson();
  if (existsSync(jsonPath)) return jsonPath;

  const jsoncPath = getConfigJsonc();
  if (existsSync(jsoncPath)) return jsoncPath;

  return jsonPath;
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}

export function getSlimStateDir(): string {
  const packageRoot = getPackageRoot();
  return basename(packageRoot) === 'oh-my-opencode-slim-fork'
    ? packageRoot
    : join(getConfigDir(), 'oh-my-opencode-slim');
}

export function getLegacySlimStateDir(): string {
  return join(getConfigDir(), 'oh-my-opencode-slim');
}

export function ensureSlimStateDir(): void {
  const dir = getSlimStateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getModelRegistryPath(): string {
  return join(getSlimStateDir(), 'model-registry.json');
}

export function getLegacyModelRegistryPath(): string {
  return join(getLegacySlimStateDir(), 'model-registry.json');
}

/**
 * Ensure the directory for OpenCode's main config file exists.
 */
export function ensureOpenCodeConfigDir(): void {
  const configDir = dirname(getConfigJson());
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
}
