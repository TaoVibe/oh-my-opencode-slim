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
 * Resolution priority:
 * 1. If category provided → resolve to agent (category wins)
 * 2. Else if subagent_type provided → use directly
 * 3. Else → error
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

  // Category takes precedence if provided
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
export function formatTaskLaunchMessage(
  task: { id: string; status: string },
  resolved: ResolvedAgent,
  runInBackground: boolean,
): string {
  const categoryNote =
    resolved.via === 'category' ? ` (via category: ${resolved.category})` : '';

  if (runInBackground) {
    return `Background task launched.

Task ID: ${task.id}
Agent: ${resolved.agent}${categoryNote}
Status: ${task.status}

Use \`background_output\` with task_id="${task.id}" to get results.`;
  }

  return `Task ID: ${task.id} (use background_output to get results)`;
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
