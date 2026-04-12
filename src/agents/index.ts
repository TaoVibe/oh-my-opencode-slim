import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk/v2';
import { getConfigSearchDirs } from '../cli/paths';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  CUSTOM_AGENT_NAMES,
  DEFAULT_MODELS,
  getAgentOverride,
  loadAgentPrompt,
  type PluginConfig,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';

import { createCouncilAgent } from './council';
import { createCouncilMasterAgent } from './council-master';
import { createCouncillorAgent } from './councillor';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createOracleAgent } from './oracle';
import { type AgentDefinition, createOrchestratorAgent } from './orchestrator';

export type { AgentDefinition } from './orchestrator';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

type CustomAgentName = (typeof CUSTOM_AGENT_NAMES)[number];

type CustomAgentFile = {
  description?: string;
  model?: string;
  variant?: string;
  prompt?: string;
};

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function extractFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function loadCustomAgentFile(name: CustomAgentName): CustomAgentFile {
  for (const configDir of getConfigSearchDirs()) {
    const filePath = path.join(configDir, 'agents', `${name}.md`);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const markdown = fs.readFileSync(filePath, 'utf-8');
      const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
      const frontmatter = frontmatterMatch?.[1] ?? '';
      return {
        description: extractFrontmatterValue(frontmatter, 'description'),
        model: extractFrontmatterValue(frontmatter, 'model'),
        variant: extractFrontmatterValue(frontmatter, 'variant'),
        prompt: stripFrontmatter(markdown),
      };
    } catch {
      return {};
    }
  }

  return {};
}

function createCustomAgent(
  name: CustomAgentName,
  config?: PluginConfig,
): AgentDefinition | null {
  const override = getAgentOverride(config, name);
  const file = loadCustomAgentFile(name);
  const modelOverride = override?.model;
  const resolvedModel = Array.isArray(modelOverride)
    ? undefined
    : (modelOverride ?? file.model ?? DEFAULT_MODELS[name]);

  if (!resolvedModel && !Array.isArray(modelOverride)) {
    return null;
  }

  const agent: AgentDefinition = {
    name,
    description: file.description ?? `${name} custom agent`,
    config: {
      prompt: file.prompt,
      temperature: 0.1,
      model: resolvedModel,
    },
  };

  if (file.variant) {
    agent.config.variant = file.variant;
  }

  if (name === 'prometheus' || name === 'momus') {
    agent.config.permission = {
      edit: 'deny',
      write: 'deny',
      question: 'allow',
    } as SDKAgentConfig['permission'];
  }

  if (override) {
    applyOverrides(agent, override);
  }

  applyDefaultPermissions(agent, override?.skills);
  return agent;
}

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model (string or priority array), variant, and temperature.
 * When model is an array, stores it as _modelArray for runtime fallback resolution
 * and clears config.model so OpenCode does not pre-resolve a stale value.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model) {
    if (Array.isArray(override.model)) {
      agent._modelArray = override.model.map((m) =>
        typeof m === 'string' ? { id: m } : m,
      );
      agent.config.model = undefined; // cleared; runtime hook resolves from _modelArray
    } else {
      agent.config.model = override.model;
    }
  }
  if (override.variant) agent.config.variant = override.variant;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
  if (override.options) {
    agent.config.options = {
      ...agent.config.options,
      ...override.options,
    };
  }
}

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Note: If the agent already explicitly sets question to 'deny', that is
 * respected (e.g. councillor and council-master should not ask questions).
 */
function applyDefaultPermissions(
  agent: AgentDefinition,
  configuredSkills?: string[],
): void {
  const existing = (agent.config.permission ?? {}) as Record<
    string,
    'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
  >;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    agent.name,
    configuredSkills,
  );

  // Respect explicit deny on question (councillor, council-master)
  const questionPerm = existing.question === 'deny' ? 'deny' : 'allow';

  agent.config.permission = {
    ...existing,
    question: questionPerm,
    // Apply skill permissions as nested object under 'skill' key
    skill: {
      ...(typeof existing.skill === 'object' ? existing.skill : {}),
      ...skillPermissions,
    },
  } as SDKAgentConfig['permission'];
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
  council: createCouncilAgent,
  councillor: createCouncillorAgent,
  'council-master': createCouncilMasterAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(config?: PluginConfig): AgentDefinition[] {
  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (name === 'fixer' && !getAgentOverride(config, 'fixer')?.model) {
      const librarianOverride = getAgentOverride(config, 'librarian')?.model;
      let librarianModel: string | undefined;
      if (Array.isArray(librarianOverride)) {
        const first = librarianOverride[0];
        librarianModel = typeof first === 'string' ? first : first?.id;
      } else {
        librarianModel = librarianOverride;
      }
      return librarianModel ?? (DEFAULT_MODELS.librarian as string);
    }
    // Council and council-master agents' model comes from
    // config.council.master.model so the TUI validates the user's
    // actual model, not the hardcoded default
    if (
      (name === 'council' || name === 'council-master') &&
      config?.council?.master?.model
    ) {
      return config.council.master.model;
    }
    // Subagents always have a defined default model; cast is safe here
    return DEFAULT_MODELS[name] as string;
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  ).map(([name, factory]) => {
    const customPrompts = loadAgentPrompt(name, config?.preset);
    return factory(
      getModelForAgent(name),
      customPrompts.prompt,
      customPrompts.appendPrompt,
    );
  });

  // 2. Apply overrides and default permissions to each agent
  const allSubAgents = protoSubAgents.map((agent) => {
    const override = getAgentOverride(config, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills);
    return agent;
  });

  const customAgents = CUSTOM_AGENT_NAMES.map((name) =>
    createCustomAgent(name, config),
  ).filter((agent): agent is AgentDefinition => agent !== null);

  // 3. Create Orchestrator (with its own overrides and custom prompts)
  // DEFAULT_MODELS.orchestrator is undefined; model is resolved via override or
  // left unset so the runtime chat.message hook can pick it from _modelArray.
  const orchestratorOverride = getAgentOverride(config, 'orchestrator');
  const orchestratorModel =
    orchestratorOverride?.model ?? DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator', config?.preset);
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    orchestratorPrompts.prompt,
    orchestratorPrompts.appendPrompt,
  );
  applyDefaultPermissions(orchestrator, orchestratorOverride?.skills);
  if (orchestratorOverride) {
    applyOverrides(orchestrator, orchestratorOverride);
  }

  return [orchestrator, ...allSubAgents, ...customAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  config?: PluginConfig,
): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig & { mcps?: string[] } = {
        ...a.config,
        description: a.description,
        mcps: getAgentMcpList(a.name, config),
      };

      // Apply classification-based visibility and mode
      if (a.name === 'council') {
        // Council is callable both as a primary agent (user-facing)
        // and as a subagent (orchestrator can delegate to it)
        sdkConfig.mode = 'all';
      } else if (a.name === 'councillor' || a.name === 'council-master') {
        // Internal agents — subagent mode, hidden from @ autocomplete
        sdkConfig.mode = 'subagent';
        sdkConfig.hidden = true;
      } else if (
        isSubagent(a.name) ||
        (CUSTOM_AGENT_NAMES as readonly string[]).includes(a.name)
      ) {
        sdkConfig.mode = 'subagent';
      } else if (a.name === 'orchestrator') {
        sdkConfig.mode = 'primary';
      }

      return [a.name, sdkConfig];
    }),
  );
}
