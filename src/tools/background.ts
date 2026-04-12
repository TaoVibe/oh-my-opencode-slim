import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { ALL_AGENT_NAMES } from '../config';
import {
  getCategoryRoutingHint,
  getValidCategoriesString,
  isValidCategory,
  resolveCategory,
} from '../config/categories';
import {
  formatTaskLaunchMessage,
  type ResolvedAgent,
} from '../config/resolution';
import type { MultiplexerConfig } from '../config/schema';

const z = tool.schema;

const optionalTrimmedString = () =>
  z.preprocess((value) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }, z.string().optional());

/**
 * Creates background task management tools for the plugin.
 * @param _ctx - Plugin input context
 * @param manager - Background task manager for launching and tracking tasks
 * @param _multiplexerConfig - Optional multiplexer configuration for session management
 * @param _pluginConfig - Optional plugin configuration for agent variants
 * @returns Object containing background_task, background_output, and background_cancel tools
 */
export function createBackgroundTools(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _multiplexerConfig?: MultiplexerConfig,
  _pluginConfig?: PluginConfig,
): Record<string, ToolDefinition> {
  const agentNames = ALL_AGENT_NAMES.join(', ');
  const overridableAgents = ALL_AGENT_NAMES.filter(
    (name) => !['orchestrator', 'councillor', 'council-master'].includes(name),
  );
  const overridableAgentNames = overridableAgents.join(', ');
  const validCategories = getValidCategoriesString();
  const normalizeOptionalString = (
    value: string | null | undefined,
  ): string | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : undefined;
  };

  const background_task = tool({
    description: `Launch background agent task. Returns task_id immediately.

Flow: launch → wait for automatic notification when complete.

Key behaviors:
- Fire-and-forget: returns task_id in ~1ms
- Parallel: up to 10 concurrent tasks
- Auto-notify: parent session receives result when task completes

You can specify either:
- agent: Direct agent name (e.g., "explorer", "prometheus")
- category: Task category that maps to optimal agent (e.g., "planning", "review")`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      agent: optionalTrimmedString().describe(`Agent to use: ${agentNames}`),
      category: optionalTrimmedString().describe(
        `Task category (alternative to agent): ${validCategories}`,
      ),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const parentSessionId = (toolContext as { sessionID: string }).sessionID;
      const prompt = String(args.prompt);
      const description = String(args.description);

      const categoryArg = normalizeOptionalString(args.category);
      const agentArg = normalizeOptionalString(args.agent);

      // Resolve agent - either direct or via category
      let resolvedAgent: string;

      if (categoryArg) {
        if (agentArg) {
          const cat = categoryArg;
          const resolved = resolveCategory(cat);
          return `Provide either category OR agent, not both. Category "${cat}" resolves to "${resolved}".`;
        }

        const category = categoryArg;
        if (!isValidCategory(category)) {
          return `Invalid category "${category}". Valid categories: ${validCategories}`;
        }
        const agent = resolveCategory(category);
        if (!agent) {
          return `Category "${category}" has no default agent`;
        }
        resolvedAgent = agent;
      } else if (agentArg) {
        resolvedAgent = agentArg;
      } else {
        return `Must provide either agent or category. Category routing: ${getCategoryRoutingHint()}`;
      }

      // Validate agent against delegation rules
      if (!manager.isAgentAllowed(parentSessionId, resolvedAgent)) {
        const allowed = manager.getAllowedSubagents(parentSessionId);
        return `Agent '${resolvedAgent}' is not allowed. Allowed agents: ${allowed.join(', ')}`;
      }

      // Fire-and-forget launch
      const task = manager.launch({
        agent: resolvedAgent,
        prompt,
        description,
        parentSessionId,
      });

      const resolved: ResolvedAgent = categoryArg
        ? { agent: resolvedAgent, via: 'category', category: categoryArg }
        : { agent: resolvedAgent, via: 'subagent_type' };
      const metadata = {
        model: manager.resolveConfiguredModel(resolvedAgent, parentSessionId),
        fallbackChain: manager.resolveFallbackChain(resolvedAgent, parentSessionId),
      };

      return formatTaskLaunchMessage(task, resolved, true, metadata);
    },
  });


  const session_agent_model = tool({
    description: `Manage session-scoped per-agent model overrides for future delegated launches.

Set agent+model to override a delegated agent for the current parent session only.
Use clear=true with agent to remove one override, or clear_all=true to remove all overrides.
Call with no mutation args to inspect current session overrides.`,
    args: {
      agent: optionalTrimmedString().describe(
        `Delegated agent to override: ${overridableAgentNames}`,
      ),
      model: optionalTrimmedString().describe('Override model in provider/model format'),
      clear: z.boolean().optional().default(false).describe('Clear override for one agent'),
      clear_all: z.boolean().optional().default(false).describe('Clear all overrides for current session'),
    },
    async execute(args, toolContext) {
      if (
        !toolContext ||
        typeof toolContext !== 'object' ||
        !('sessionID' in toolContext)
      ) {
        throw new Error('Invalid toolContext: missing sessionID');
      }

      const sessionId = (toolContext as { sessionID: string }).sessionID;
      const agent = normalizeOptionalString(args.agent);
      const model = normalizeOptionalString(args.model);
      const clear = args.clear === true;
      const clearAll = args.clear_all === true;

      if (clearAll) {
        manager.clearSessionAgentModelOverride(sessionId);
        return 'Cleared all session agent model overrides.';
      }

      if (clear) {
        if (!agent) {
          return 'Provide agent when using clear=true, or use clear_all=true.';
        }
        manager.clearSessionAgentModelOverride(sessionId, agent);
        return `Cleared session override for ${agent}.`;
      }

      if (agent && model) {
        if (!overridableAgents.includes(agent as (typeof overridableAgents)[number])) {
          return `Agent '${agent}' is not overridable. Allowed: ${overridableAgentNames}`;
        }
        if (!model.includes('/') || /\s/.test(model)) {
          return 'Model must use provider/model format.';
        }
        manager.setSessionAgentModelOverride(sessionId, agent, model);
        const fallback = manager.resolveFallbackChain(agent, sessionId)
          .filter((item) => item !== model)
          .slice(0, 2)
          .join('→');
        return fallback
          ? `Set session override: ${agent} -> ${model} | fallback=${fallback}`
          : `Set session override: ${agent} -> ${model}`;
      }

      const overrides = manager.getSessionAgentModelOverrides(sessionId);
      const entries = Object.entries(overrides);
      if (entries.length === 0) {
        return 'No session agent model overrides.';
      }

      return [
        'Session Agent Model Overrides',
        ...entries.map(([name, value]) => `${name}=${value}`),
      ].join('\n');
    },
  });

  // Tool for retrieving output from background tasks
  const background_output = tool({
    description: `Get background task results after completion notification received.

timeout=0: returns status immediately (no wait)
timeout=N: waits up to N ms for completion

Returns: results if completed, error if failed, status if running.`,

    args: {
      task_id: z.string().describe('Task ID from background_task'),
      timeout: z
        .number()
        .optional()
        .describe('Wait for completion (in ms, 0=no wait, default: 0)'),
    },
    async execute(args) {
      const taskId = String(args.task_id);
      const timeout =
        typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 0;

      let task = manager.getResult(taskId);

      // Wait for completion if timeout specified
      if (
        task &&
        timeout > 0 &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        task.status !== 'cancelled'
      ) {
        task = await manager.waitForCompletion(taskId, timeout);
      }

      if (!task) {
        return `Task not found: ${taskId}`;
      }

      // Calculate task duration
      const duration = task.completedAt
        ? `${Math.floor((task.completedAt.getTime() - task.startedAt.getTime()) / 1000)}s`
        : `${Math.floor((Date.now() - task.startedAt.getTime()) / 1000)}s`;

      let output = `Task: ${task.id}
 Description: ${task.description}
 Status: ${task.status}
 Duration: ${duration}

 ---

 `;

      // Include task result or error based on status
      if (task.status === 'completed' && task.result != null) {
        output += task.result;
      } else if (task.status === 'failed') {
        output += `Error: ${task.error}`;
      } else if (task.status === 'cancelled') {
        output += '(Task cancelled)';
      } else {
        output += '(Task still running)';
      }

      return output;
    },
  });

  // Tool for canceling running background tasks
  const background_cancel = tool({
    description: `Cancel background task(s).

task_id: cancel specific task
all=true: cancel all running tasks

Only cancels pending/starting/running tasks.`,
    args: {
      task_id: z.string().optional().describe('Specific task to cancel'),
      all: z.boolean().optional().describe('Cancel all running tasks'),
    },
    async execute(args) {
      // Cancel all running tasks if requested
      if (args.all === true) {
        const count = manager.cancel();
        return `Cancelled ${count} task(s).`;
      }

      // Cancel specific task if task_id provided
      if (typeof args.task_id === 'string') {
        const count = manager.cancel(args.task_id);
        return count > 0
          ? `Cancelled task ${args.task_id}.`
          : `Task ${args.task_id} not found or not running.`;
      }

      return 'Specify task_id or use all=true.';
    },
  });

  return {
    background_task,
    session_agent_model,
    background_output,
    background_cancel,
  };
}
