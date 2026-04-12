import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import {
  ALL_AGENT_NAMES,
  SUBAGENT_NAMES,
} from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getCategoryRoutingHint,
  getValidCategoriesString,
  isValidCategory,
  resolveCategory,
} from '../config/categories';

const z = tool.schema;

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
  const validCategories = getValidCategoriesString();

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
      agent: z
        .string()
        .optional()
        .describe(`Agent to use: ${agentNames}`),
      category: z
        .string()
        .optional()
        .describe(`Task category (alternative to agent): ${validCategories}`),
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

      // Resolve agent - either direct or via category
      let resolvedAgent: string;

      if (args.category !== undefined && args.category !== null) {
        if (args.agent !== undefined && args.agent !== null) {
          const cat = String(args.category);
          const resolved = resolveCategory(cat);
          return `Provide either category OR agent, not both. Category "${cat}" resolves to "${resolved}".`;
        }

        const category = String(args.category);
        if (!isValidCategory(category)) {
          return `Invalid category "${category}". Valid categories: ${validCategories}`;
        }
        const agent = resolveCategory(category);
        if (!agent) {
          return `Category "${category}" has no default agent`;
        }
        resolvedAgent = agent;
      } else if (args.agent !== undefined && args.agent !== null) {
        resolvedAgent = String(args.agent);
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

      return `Background task launched.

Task ID: ${task.id}
Agent: ${resolvedAgent}${args.category ? ` (via category: ${args.category})` : ''}
Status: ${task.status}

Use \`background_output\` with task_id="${task.id}" to get results.`;
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

  return { background_task, background_output, background_cancel };
}
