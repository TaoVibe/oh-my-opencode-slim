/**
 * Category-to-Agent Routing Configuration
 *
 * Maps task categories to optimal agents based on task type and capabilities.
 * This enables intuitive routing: task(category="planning") instead of
 * manually specifying task(agent="prometheus").
 *
 * Category naming follows slim philosophy (simple, intuitive).
 * Full oh-my-opencode uses: visual-engineering, ultrabrain, etc.
 * This is intentional - simple names work better with free-model routing.
 */

import type { AgentName } from './constants';

/**
 * Category type - each category implies certain capabilities
 */
export type Category =
  | 'planning' // structuring goals into plans (prometheus)
  | 'review' // adversarial review, finding flaws (momus)
  | 'implementation' // deep autonomous execution (hephaestus)
  | 'exploration' // codebase search/discovery (explorer)
  | 'research' // docs/API lookup (librarian)
  | 'execution' // bounded implementation (fixer)
  | 'architecture' // strategic decisions (oracle)
  | 'visual'; // UI/UX work (designer)

/**
 * Category → Agent mapping
 * Note: 'implementation' maps to hephaestus but hephaestus is NOT in
 * ORCHESTRATABLE_AGENTS - requires explicit agent= call for security.
 * Categories route to safer agents; hephaestus needs explicit intent.
 */
export const CATEGORY_TO_AGENT: Record<Category, AgentName> = {
  planning: 'prometheus',
  review: 'momus',
  implementation: 'hephaestus',
  exploration: 'explorer',
  research: 'librarian',
  execution: 'fixer',
  architecture: 'oracle',
  visual: 'designer',
};

/**
 * Reverse lookup: which categories can an agent handle?
 * hephaestus is listed but NOT routable via category (security)
 */
export const AGENT_TO_CATEGORIES: Record<AgentName, readonly Category[]> = {
  prometheus: ['planning'],
  momus: ['review'],
  hephaestus: ['implementation'],
  explorer: ['exploration'],
  librarian: ['research'],
  fixer: ['execution'],
  oracle: ['architecture'],
  designer: ['visual'],
  // Internal agents not directly category-routable
  orchestrator: [],
  council: [],
  councillor: [],
  'council-master': [],
};

/**
 * Category descriptions for error messages / documentation
 */
export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  planning: 'Planning gate - structures goals into executable plans',
  review: 'Adversarial review - finds flaws, missing pieces, risks',
  implementation:
    'Deep autonomous execution - complex multi-step work (requires explicit agent= call)',
  exploration: 'Codebase search - discovers files, patterns, structure',
  research: 'Documentation lookup - finds API docs, examples, usage',
  execution: 'Bounded implementation - well-scoped changes, tests',
  architecture:
    'Strategic advisor - architectural decisions, high-stakes choices',
  visual: 'UI/UX specialist - visual polish, responsive layouts',
};

/**
 * Resolve a category to its default agent.
 * Returns undefined if category is not recognized.
 */
export function resolveCategory(category: string): AgentName | undefined {
  const normalized = category.toLowerCase().trim() as Category;
  return CATEGORY_TO_AGENT[normalized];
}

/**
 * Check if a category name is valid.
 */
export function isValidCategory(category: string): category is Category {
  return category.toLowerCase().trim() in CATEGORY_TO_AGENT;
}

/**
 * Get all valid category names.
 */
export const VALID_CATEGORIES = Object.keys(CATEGORY_TO_AGENT) as Category[];

/**
 * Get formatted list of valid categories for error messages.
 */
export function getValidCategoriesString(): string {
  return VALID_CATEGORIES.join(', ');
}

/**
 * Get category routing hint for error messages.
 */
export function getCategoryRoutingHint(): string {
  return VALID_CATEGORIES.map((c) => `${c}→${CATEGORY_TO_AGENT[c]}`).join(', ');
}
