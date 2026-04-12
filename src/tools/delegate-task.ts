import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { ALL_AGENT_NAMES } from '../config';
import type { MultiplexerConfig } from '../config/schema';
import {
  getCategoryRoutingHint,
  getValidCategoriesString,
  isValidCategory,
  resolveCategory,
} from '../config/categories';

const z = tool.schema;

export function createDelegateTaskTool(
  _ctx: PluginInput,
  manager: BackgroundTaskManager,
  _multiplexerConfig?: MultiplexerConfig,
  _pluginConfig?: PluginConfig,
): Record<string, ToolDefinition> {
  const agentNames = ALL_AGENT_NAMES.join(', ');
  const validCategories = getValidCategoriesString();

  const delegate_task = tool({
    description: `Delegate task to a specialist agent. Returns task_id immediately.

Flow: launch → wait for automatic notification when complete.

Key behaviors:
- Fire-and-forget: returns task_id in ~1ms
- Parallel: up to 10 concurrent tasks
- Auto-notify: parent session receives result when task completes

You can specify either:
- subagent_type: Direct agent name (e.g., "explorer", "prometheus")
- category: Task category that maps to optimal agent (e.g., "planning", "review")`,

    args: {
      description: z
        .string()
        .describe('Short description of the task (5-10 words)'),
      prompt: z.string().describe('The task prompt for the agent'),
      subagent_type: z
        .string()
        .optional()
        .describe(`Agent to use: ${agentNames}`),
      category: z
        .string()
        .optional()
        .describe(`Task category (alternative to subagent_type): ${validCategories}`),
      run_in_background: z
        .boolean()
        .optional()
        .default(true)
        .describe('Run as background task (default: true)'),
      session_id: z.string().optional().describe('Existing session to continue'),
      load_skills: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Skills to inject'),
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
      const runInBackground = args.run_in_background ?? true;

      let resolvedAgent: string;

      if (args.category !== undefined && args.category !== null) {
        if (args.subagent_type !== undefined && args.subagent_type !== null) {
          const cat = String(args.category);
          const resolved = resolveCategory(cat);
          return `Provide either category OR subagent_type, not both. Category "${cat}" resolves to "${resolved}".`;
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
      } else if (args.subagent_type !== undefined && args.subagent_type !== null) {
        resolvedAgent = String(args.subagent_type);
      } else {
        return `Must provide either subagent_type or category. Category routing: ${getCategoryRoutingHint()}`;
      }

      if (!manager.isAgentAllowed(parentSessionId, resolvedAgent)) {
        const allowed = manager.getAllowedSubagents(parentSessionId);
        return `Agent '${resolvedAgent}' is not allowed. Allowed agents: ${allowed.join(', ')}`;
      }

      const task = manager.launch({
        agent: resolvedAgent,
        prompt,
        description,
        parentSessionId,
      });

      if (runInBackground) {
        return `Background task launched.

Task ID: ${task.id}
Agent: ${resolvedAgent}${args.category ? ` (via category: ${args.category})` : ''}
Status: ${task.status}

Use \`background_output\` with task_id="${task.id}" to get results.`;
      }

      return `Task ID: ${task.id} (use background_output to get results)`;
    },
  });

  return {
    delegate_task,
    task: delegate_task,
  };
}