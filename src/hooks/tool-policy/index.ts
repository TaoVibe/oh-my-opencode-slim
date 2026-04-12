import type { PluginInput } from '@opencode-ai/plugin';
import { classifyPermissionRequest, classifyToolExecution } from './classify';
import type { ToolPermissionRequest, ToolPolicyEvaluation } from './types';

interface ToolPolicyMetadata {
  toolPolicy?: ToolPolicyEvaluation;
  [key: string]: unknown;
}

function getCallId(input: ToolPermissionRequest): string | undefined {
  const metadata = input.metadata;
  const tool =
    typeof metadata?.tool === 'object' && metadata.tool !== null
      ? (metadata.tool as Record<string, unknown>)
      : undefined;

  return (
    (typeof (input as { callID?: unknown }).callID === 'string'
      ? (input as { callID?: string }).callID
      : undefined) ??
    (typeof metadata?.callID === 'string' ? metadata.callID : undefined) ??
    (typeof metadata?.call_id === 'string' ? metadata.call_id : undefined) ??
    (typeof tool?.callID === 'string' ? tool.callID : undefined) ??
    (typeof tool?.call_id === 'string' ? tool.call_id : undefined)
  );
}

export function createToolPolicyHook(_ctx: PluginInput) {
  const evaluations = new Map<string, ToolPolicyEvaluation>();
  const approvedAsks = new Map<string, ToolPolicyEvaluation>();

  return {
    'permission.ask': async (
      input: ToolPermissionRequest,
      output: { status: 'ask' | 'deny' | 'allow' },
    ): Promise<void> => {
      const evaluation = classifyPermissionRequest(input);
      const callID = getCallId(input);
      if (evaluation.decision === 'deny') {
        output.status = 'deny';
        return;
      }

      if (evaluation.decision === 'ask') {
        output.status = 'ask';
        if (callID) {
          approvedAsks.set(callID, evaluation);
        }
      }
    },

    'tool.execute.before': async (
      input: { tool: string; callID: string },
      output: { args: Record<string, unknown> },
    ): Promise<void> => {
      const approvedAsk = approvedAsks.get(input.callID);
      if (approvedAsk) {
        approvedAsks.delete(input.callID);
        evaluations.set(input.callID, approvedAsk);
        return;
      }

      const evaluation = classifyToolExecution({
        tool: input.tool,
        args: output.args,
      });
      evaluations.set(input.callID, evaluation);
      if (evaluation.decision === 'deny') {
        throw new Error(
          evaluation.reason ?? 'Native tool policy blocked the operation',
        );
      }
      if (evaluation.decision === 'ask') {
        throw new Error(
          evaluation.reason ??
            'Approval required, but no native permission gate was triggered.',
        );
      }
    },

    'tool.execute.after': async (
      input: { callID: string },
      output: { metadata: unknown },
    ): Promise<void> => {
      const evaluation = evaluations.get(input.callID);
      evaluations.delete(input.callID);
      if (!evaluation) return;

      const metadata: ToolPolicyMetadata =
        typeof output.metadata === 'object' && output.metadata !== null
          ? (output.metadata as ToolPolicyMetadata)
          : {};
      metadata.toolPolicy = evaluation;
      output.metadata = metadata;
    },
  };
}
