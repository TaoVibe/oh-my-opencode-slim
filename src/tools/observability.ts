import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type {
  BackgroundTaskManager,
  MultiplexerSessionManager,
} from '../background';

const z = tool.schema;

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none';
}

export function createObservabilityTool(
  backgroundManager: BackgroundTaskManager,
  multiplexerSessionManager: MultiplexerSessionManager,
): Record<string, ToolDefinition> {
  const observability_status = tool({
    description: `Show current runtime status for background agents and panes.

Returns:
- counts by task state
- active background work items
- configured model / variant / fallback chain when known
- tracked multiplexer panes`,
    args: {
      include_completed: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include completed/failed/cancelled tasks'),
    },
    async execute(args) {
      const includeCompleted = args.include_completed ?? false;
      const allTasks = backgroundManager.getTaskSnapshots();
      const tasks = includeCompleted
        ? allTasks
        : allTasks.filter(
            (task) =>
              task.status === 'pending' ||
              task.status === 'starting' ||
              task.status === 'running',
          );
      const panes = multiplexerSessionManager.getTrackedSessions();

      const counts = {
        pending: allTasks.filter((task) => task.status === 'pending').length,
        starting: allTasks.filter((task) => task.status === 'starting').length,
        running: allTasks.filter((task) => task.status === 'running').length,
        completed: allTasks.filter((task) => task.status === 'completed').length,
        failed: allTasks.filter((task) => task.status === 'failed').length,
        cancelled: allTasks.filter((task) => task.status === 'cancelled').length,
      };

      const lines = [
        'Runtime Status',
        `Tasks: pending=${counts.pending}, starting=${counts.starting}, running=${counts.running}, completed=${counts.completed}, failed=${counts.failed}, cancelled=${counts.cancelled}`,
        `Panes: ${panes.length}`,
        '',
        'Background Tasks',
      ];

      if (tasks.length === 0) {
        lines.push('(none)');
      } else {
        for (const task of tasks) {
          lines.push(
            `${task.id} | ${task.agent} | ${task.status} | ${task.description}`,
          );
          lines.push(`  model=${task.configuredModel ?? 'unknown'}`);
          lines.push(`  variant=${task.variant ?? 'none'}`);
          lines.push(`  fallback=${formatList(task.fallbackChain)}`);
          lines.push(`  session=${task.sessionId ?? 'not started yet'}`);
        }
      }

      lines.push('', 'Multiplexer Panes');
      if (panes.length === 0) {
        lines.push('(none)');
      } else {
        for (const pane of panes) {
          lines.push(
            `${pane.paneId} | ${pane.title} | session=${pane.sessionId} | parent=${pane.parentId}`,
          );
        }
      }

      return lines.join('\n');
    },
  });

  return { observability_status };
}
