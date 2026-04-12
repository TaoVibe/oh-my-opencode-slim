/**
 * Shared agent resolution helper
 *
 * This module provides a single source of truth for resolving:
 * - category → agent mapping
 * - subagent_type → agent validation
 * - mutual exclusivity logic
 *
 * Used by both background_task and delegate_task tools.
 */

import {
  CATEGORY_TO_AGENT,
  type Category,
  getCategoryRoutingHint,
  getValidCategoriesString,
  isValidCategory,
  resolveCategory,
} from './categories';
import type { AgentName } from './constants';

export interface TaskLaunchMetadata {
  model?: string;
  fallbackChain?: string[];
}

/**
 * Result of resolving an agent request
 */
export interface ResolvedAgent {
  agent: string;
  via: 'category' | 'subagent_type';
  category?: string;
}

/**
 * Error result
 */
export interface ResolutionError {
  error: true;
  message: string;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Unified agent resolution from task arguments.
 *
 * Resolution rules:
 * 1. category and subagent_type are mutually exclusive
 * 2. If category provided → resolve to agent
 * 3. Else if subagent_type provided → use directly
 * 4. Else → error
 *
 * @param args - Task arguments with optional category/subagent_type
 * @returns Resolved agent or error
 */
export function resolveRequestedAgent(args: {
  category?: string | null;
  subagent_type?: string | null;
}): ResolvedAgent | ResolutionError {
  const validCategories = getValidCategoriesString();
  const category = normalizeOptionalString(args.category)?.toLowerCase();
  const subagentType = normalizeOptionalString(args.subagent_type);

  if (category && subagentType) {
    const resolved = resolveCategory(category);
    const target = resolved ? ` Category "${category}" resolves to "${resolved}".` : '';
    return {
      error: true,
      message: `Provide either subagent_type OR category, not both.${target}`,
    };
  }

  if (category) {
    if (!isValidCategory(category)) {
      return {
        error: true,
        message: `Invalid category "${category}". Valid categories: ${validCategories}`,
      };
    }

    const agent = resolveCategory(category);
    if (!agent) {
      return {
        error: true,
        message: `Category "${category}" has no default agent`,
      };
    }

    return {
      agent,
      via: 'category',
      category,
    };
  }

  // Direct subagent_type
  if (subagentType) {
    return {
      agent: subagentType,
      via: 'subagent_type',
    };
  }

  // Neither provided
  return {
    error: true,
    message: `Must provide either subagent_type or category. Category routing: ${getCategoryRoutingHint()}`,
  };
}

/**
 * Check if an agent is allowed for delegation.
 *
 * @param agent - Agent name to check
 * @param allowedAgents - List of allowed agent names
 * @returns Error if not allowed, null if allowed
 */
export function checkAgentAllowed(
  agent: string,
  allowedAgents: readonly string[],
): ResolutionError | null {
  if (!allowedAgents.includes(agent as AgentName)) {
    return {
      error: true,
      message: `Agent '${agent}' is not allowed. Allowed agents: ${allowedAgents.join(', ')}`,
    };
  }
  return null;
}

/**
 * Format a successful task launch message.
 */
function formatLaunchMetadata(metadata?: TaskLaunchMetadata): string {
  if (!metadata?.model) {
    return '';
  }

  const fallback = (metadata.fallbackChain ?? []).filter(
    (model) => model && model !== metadata.model,
  );
  const compactFallback = fallback.slice(0, 2).join('→');
  return compactFallback
    ? `Model: ${metadata.model} | Fallback: ${compactFallback}`
    : `Model: ${metadata.model}`;
}

export function formatTaskLaunchMessage(
  task: { id: string; status: string },
  resolved: ResolvedAgent,
  runInBackground: boolean,
  metadata?: TaskLaunchMetadata,
): string {
  const categoryNote =
    resolved.via === 'category' ? ` (via category: ${resolved.category})` : '';
  const metadataLine = formatLaunchMetadata(metadata);
  const metadataBlock = metadataLine ? `
${metadataLine}` : '';

  if (runInBackground) {
    return `Background task launched.

Task ID: ${task.id}
Agent: ${resolved.agent}${categoryNote}
Status: ${task.status}${metadataBlock}

Use \`background_output\` with task_id="${task.id}" to get results.`;
  }

  return `Task ID: ${task.id}${metadataBlock} (use background_output to get results)`;
}

// Re-export commonly used category utilities
export {
  CATEGORY_TO_AGENT,
  isValidCategory,
  resolveCategory,
  getValidCategoriesString,
  getCategoryRoutingHint,
  type Category,
};
