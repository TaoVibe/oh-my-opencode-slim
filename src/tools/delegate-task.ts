import {
  type PluginInput,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import type { BackgroundTaskManager } from '../background';
import type { PluginConfig } from '../config';
import type { ModelRegistryStore } from '../utils';
import { ALL_AGENT_NAMES } from '../config';
import {
  buildRoutedPrompt,
  getValidRoutingLanesString,
  resolveCategoryRoute,
  checkAgentAllowed,
  formatTaskLaunchMessage,
  getValidCategoriesString,
  resolveRequestedAgent,
} from '../config';
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
  modelRegistry?: ModelRegistryStore,
): Record<string, ToolDefinition> {
  const agentNames = ALL_AGENT_NAMES.join(', ');
  const validCategories = getValidCategoriesString();
  const validLanes = getValidRoutingLanesString();

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
      lane: optionalTrimmedString().describe(
        `Routing lane for category-based selection: ${validLanes}`,
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
        lane: args.lane,
      });

      if ('error' in resolved) {
        return resolved.message;
      }

      const route = resolved.category
        ? resolveCategoryRoute(_pluginConfig, resolved.category, resolved.lane)
        : { agent: undefined, lane: undefined, modelChain: [] };
      const resolvedAgent = route.agent ?? resolved.agent;
      const biasedRouteChain =
        modelRegistry?.getBiasedModelChain(route.modelChain, route.lane) ??
        route.modelChain;

      // Check agent allowed
      const allowed = manager.getAllowedSubagents(parentSessionId);
      const allowedError = checkAgentAllowed(resolvedAgent, allowed);
      if (allowedError) {
        return allowedError.message;
      }

      const routedPrompt = buildRoutedPrompt({
        prompt,
        category: resolved.category,
        lane: route.lane ?? resolved.lane,
        agent: resolvedAgent,
        promptAppend: route.promptAppend,
      });

      const task = manager.launch({
        agent: resolvedAgent,
        prompt: routedPrompt,
        description,
        parentSessionId,
        category: resolved.category,
        lane: route.lane,
        routeModelChain: biasedRouteChain,
      });
      const metadata = {
        model: manager.resolveConfiguredModel(
          resolvedAgent,
          parentSessionId,
          biasedRouteChain,
        ),
        fallbackChain: manager.resolveFallbackChain(
          resolvedAgent,
          parentSessionId,
          biasedRouteChain,
        ),
      };

      return formatTaskLaunchMessage(
        task,
        {
          ...resolved,
          agent: resolvedAgent,
          lane: route.lane ?? resolved.lane,
        },
        runInBackground,
        metadata,
      );
    },
  });

  return {
    delegate_task,
    task: delegate_task,
  };
}
