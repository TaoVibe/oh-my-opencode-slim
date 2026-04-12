import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import { ALL_AGENT_NAMES } from '../config';
import {
  checkAgentAllowed,
  formatTaskLaunchMessage,
  getValidCategoriesString,
  resolveRequestedAgent,
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
      subagent_type: optionalTrimmedString().describe(
        `Agent to use: ${agentNames}`,
      ),
      category: optionalTrimmedString().describe(
        `Task category (alternative to subagent_type): ${validCategories}`,
      ),
      run_in_background: z
        .boolean()
        .optional()
        .default(true)
        .describe('Run as background task (default: true)'),
      session_id: optionalTrimmedString().describe('Existing session to continue'),
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

      // Use shared resolution helper
      const resolved = resolveRequestedAgent({
        category: args.category,
        subagent_type: args.subagent_type,
      });

      if ('error' in resolved) {
        return resolved.message;
      }

      // Check agent allowed
      const allowed = manager.getAllowedSubagents(parentSessionId);
      const allowedError = checkAgentAllowed(resolved.agent, allowed);
      if (allowedError) {
        return allowedError.message;
      }

      const task = manager.launch({
        agent: resolved.agent,
        prompt,
        description,
        parentSessionId,
      });
      const metadata = {
        model: manager.resolveConfiguredModel(resolved.agent, parentSessionId),
        fallbackChain: manager.resolveFallbackChain(
          resolved.agent,
          parentSessionId,
        ),
      };

      return formatTaskLaunchMessage(task, resolved, runInBackground, metadata);
    },
  });

  return {
    delegate_task,
    task: delegate_task,
  };
}
