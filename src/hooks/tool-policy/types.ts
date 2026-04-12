export type ToolPolicyDecision = 'allow' | 'ask' | 'deny';

export interface ToolPolicyEvaluation {
  decision: ToolPolicyDecision;
  category: string;
  reason?: string;
}

export interface ToolPermissionRequest {
  type?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionRequest {
  tool: string;
  args: Record<string, unknown>;
}
