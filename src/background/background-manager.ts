/**
 * Background Task Manager
 *
 * Manages long-running AI agent tasks that execute in separate sessions.
 * Background tasks run independently from the main conversation flow, allowing
 * the user to continue working while tasks complete asynchronously.
 *
 * Key features:
 * - Fire-and-forget launch (returns task_id immediately)
 * - Creates isolated sessions for background work
 * - Event-driven completion detection via session.status
 * - Start queue with configurable concurrency limit
 * - Supports task cancellation and result retrieval
 */

import type { PluginInput } from '@opencode-ai/plugin';
import type { BackgroundTaskConfig, PluginConfig } from '../config';
import {
  assertModelAllowed,
  DEFAULT_MODELS,
  FALLBACK_FAILOVER_TIMEOUT_MS,
  filterAllowedModels,
  SUBAGENT_DELEGATION_RULES,
  shouldFailClosed,
} from '../config';
import type { MultiplexerConfig } from '../config/schema';
import { getMultiplexer } from '../multiplexer';
import {
  applyAgentVariant,
  ModelRegistryStore,
  type ModelHealthSnapshot,
  ModelHealthTracker,
  resolveAgentVariant,
} from '../utils';
import { extractUsageMetrics } from '../utils/session';
import { log } from '../utils/logger';
import {
  extractSessionResult,
  type PromptBody,
  type SessionUsageMetrics,
  parseModelReference,
  promptWithTimeout,
} from '../utils/session';
import { SubagentDepthTracker } from './subagent-depth';

type OpencodeClient = PluginInput['client'];

/**
 * Represents a background task running in an isolated session.
 * Tasks are tracked from creation through completion or failure.
 */
export interface BackgroundTask {
  id: string; // Unique task identifier (e.g., "bg_abc123")
  sessionId?: string; // OpenCode session ID (set when starting)
  description: string; // Human-readable task description
  agent: string; // Agent name handling the task
  status:
    | 'pending'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';
  result?: string; // Final output from the agent (when completed)
  error?: string; // Error message (when failed)
  config: BackgroundTaskConfig; // Task configuration
  parentSessionId: string; // Parent session ID for notifications
  startedAt: Date; // Task creation timestamp
  completedAt?: Date; // Task completion/failure timestamp
  resultConsumedAt?: Date; // First time parent fetched a completed result
  prompt: string; // Initial prompt
  category?: string; // Source routing category (if any)
  lane?: string; // Source routing lane (if any)
  routeModelChain?: string[]; // Category/lane-specific chain override
}

/**
 * Options for launching a new background task.
 */
export interface LaunchOptions {
  agent: string; // Agent to handle the task
  prompt: string; // Initial prompt to send to the agent
  description: string; // Human-readable task description
  parentSessionId: string; // Parent session ID for task hierarchy
  category?: string;
  lane?: string;
  routeModelChain?: string[];
}

export interface BackgroundTaskSnapshot {
  id: string;
  sessionId?: string;
  description: string;
  agent: string;
  status: BackgroundTask['status'];
  parentSessionId: string;
  startedAt: string;
  completedAt?: string;
  resultConsumedAt?: string;
  configuredModel?: string;
  variant?: string;
  fallbackChain: string[];
  category?: string;
  lane?: string;
  routeModelChain?: string[];
}

export interface SessionAgentModelOverrideSnapshot {
  sessionId: string;
  overrides: Record<string, string>;
}

function generateTaskId(): string {
  return `bg_${Math.random().toString(36).substring(2, 10)}`;
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private tasksBySessionId = new Map<string, string>();
  private sessionsStarting = new Set<string>();
  // Track which agent type owns each session for delegation permission checks
  private agentBySessionId = new Map<string, string>();
  private depthTracker: SubagentDepthTracker;
  private client: OpencodeClient;
  private directory: string;
  private tmuxEnabled: boolean;
  private config?: PluginConfig;
  private backgroundConfig: BackgroundTaskConfig;
  private modelHealth: ModelHealthTracker;
  private modelRegistry?: ModelRegistryStore;

  // Start queue
  private startQueue: BackgroundTask[] = [];
  private activeStarts = 0;
  private maxConcurrentStarts: number;

  // Completion waiting
  private completionResolvers = new Map<
    string,
    (task: BackgroundTask) => void
  >();
  private sessionAgentModelOverrides = new Map<string, Map<string, string>>();

  constructor(
    ctx: PluginInput,
    multiplexerConfig?: MultiplexerConfig,
    config?: PluginConfig,
    modelRegistry?: ModelRegistryStore,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    // Check if multiplexer is actually available (handles 'auto' type correctly)
    this.tmuxEnabled =
      multiplexerConfig !== undefined &&
      multiplexerConfig.type !== 'none' &&
      multiplexerConfig.type !== undefined &&
      getMultiplexer(multiplexerConfig) !== null;
    this.config = config;
    this.backgroundConfig = config?.background ?? {
      maxConcurrentStarts: 10,
    };
    this.maxConcurrentStarts = this.backgroundConfig.maxConcurrentStarts;
    this.depthTracker = new SubagentDepthTracker();
    this.modelHealth = new ModelHealthTracker(config?.fallback?.health);
    this.modelRegistry = modelRegistry;
  }

  /**
   * Look up the delegation rules for an agent type.
   * Unknown agent types default to explorer-only access, making it easy
   * to add new background agent types without updating SUBAGENT_DELEGATION_RULES.
   */
  private getSubagentRules(agentName: string): readonly string[] {
    return (
      SUBAGENT_DELEGATION_RULES[
        agentName as keyof typeof SUBAGENT_DELEGATION_RULES
      ] ?? ['explorer']
    );
  }

  /**
   * Check if a parent session is allowed to delegate to a specific agent type.
   * @param parentSessionId - The session ID of the parent
   * @param requestedAgent - The agent type being requested
   * @returns true if allowed, false if not
   */
  isAgentAllowed(parentSessionId: string, requestedAgent: string): boolean {
    // Untracked sessions are the root orchestrator (created by OpenCode, not by us)
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';

    const allowedSubagents = this.getSubagentRules(parentAgentName);

    if (allowedSubagents.length === 0) return false;

    return allowedSubagents.includes(requestedAgent);
  }

  /**
   * Get the list of allowed subagents for a parent session.
   * @param parentSessionId - The session ID of the parent
   * @returns Array of allowed agent names, empty if none
   */
  getAllowedSubagents(parentSessionId: string): readonly string[] {
    // Untracked sessions are the root orchestrator (created by OpenCode, not by us)
    const parentAgentName =
      this.agentBySessionId.get(parentSessionId) ?? 'orchestrator';

    return this.getSubagentRules(parentAgentName);
  }

  /**
   * Launch a new background task (fire-and-forget).
   *
   * Phase A (sync): Creates task record and returns immediately.
   * Phase B (async): Session creation and prompt sending happen in background.
   *
   * @param opts - Task configuration options
   * @returns The created background task with pending status
   */
  launch(opts: LaunchOptions): BackgroundTask {
    const task: BackgroundTask = {
      id: generateTaskId(),
      sessionId: undefined,
      description: opts.description,
      agent: opts.agent,
      status: 'pending',
      startedAt: new Date(),
      config: {
        maxConcurrentStarts: this.maxConcurrentStarts,
      },
      parentSessionId: opts.parentSessionId,
      prompt: opts.prompt,
      category: opts.category,
      lane: opts.lane,
      routeModelChain: opts.routeModelChain,
    };

    this.tasks.set(task.id, task);

    // Queue task for background start
    this.enqueueStart(task);

    log(`[background-manager] task launched: ${task.id}`, {
      agent: opts.agent,
      description: opts.description,
    });

    return task;
  }

  /**
   * Enqueue task for background start.
   */
  private enqueueStart(task: BackgroundTask): void {
    this.startQueue.push(task);
    this.processQueue();
  }

  /**
   * Process start queue with concurrency limit.
   */
  private processQueue(): void {
    while (
      this.activeStarts < this.maxConcurrentStarts &&
      this.startQueue.length > 0
    ) {
      const task = this.startQueue.shift();
      if (!task) break;
      this.startTask(task);
    }
  }

  private getSessionAgentModelOverride(
    sessionId: string | undefined,
    agentName: string,
  ): string | undefined {
    if (!sessionId) return undefined;
    return this.sessionAgentModelOverrides.get(sessionId)?.get(agentName);
  }

  setSessionAgentModelOverride(
    sessionId: string,
    agentName: string,
    model: string,
  ): void {
    assertModelAllowed(model, this.config, `session override for ${agentName}`);
    const sessionOverrides =
      this.sessionAgentModelOverrides.get(sessionId) ?? new Map<string, string>();
    sessionOverrides.set(agentName, model);
    this.sessionAgentModelOverrides.set(sessionId, sessionOverrides);
  }

  clearSessionAgentModelOverride(sessionId: string, agentName?: string): void {
    if (!agentName) {
      this.sessionAgentModelOverrides.delete(sessionId);
      return;
    }

    const sessionOverrides = this.sessionAgentModelOverrides.get(sessionId);
    if (!sessionOverrides) return;
    sessionOverrides.delete(agentName);
    if (sessionOverrides.size === 0) {
      this.sessionAgentModelOverrides.delete(sessionId);
    }
  }

  getSessionAgentModelOverrides(
    sessionId: string,
  ): Record<string, string> {
    return Object.fromEntries(
      this.sessionAgentModelOverrides.get(sessionId)?.entries() ?? [],
    );
  }

  getAllSessionAgentModelOverrideSnapshots(): SessionAgentModelOverrideSnapshot[] {
    return Array.from(this.sessionAgentModelOverrides.entries()).map(
      ([sessionId, overrides]) => ({
        sessionId,
        overrides: Object.fromEntries(overrides),
      }),
    );
  }

  resolveFallbackChain(
    agentName: string,
    sessionId?: string,
    routeModelChain?: string[],
  ): string[] {
    const sessionOverride = this.getSessionAgentModelOverride(sessionId, agentName);
    const fallback = this.config?.fallback;
    const chains = fallback?.chains as
      | Record<string, string[] | undefined>
      | undefined;
    const configuredChain = chains?.[agentName] ?? [];
    const primary = this.config?.agents?.[agentName]?.model;

    const chain: string[] = [];
    const seen = new Set<string>();

    // primary may be a string, an array of string|{id,variant?}, or undefined
    let primaryIds: string[];
    if (Array.isArray(primary)) {
      primaryIds = primary.map((m) => (typeof m === 'string' ? m : m.id));
    } else if (typeof primary === 'string') {
      primaryIds = [primary];
    } else {
      primaryIds = [];
    }
    const modelsToUse = sessionOverride
      ? [sessionOverride, ...(routeModelChain ?? []), ...primaryIds, ...configuredChain]
      : [...(routeModelChain ?? []), ...primaryIds, ...configuredChain];
    for (const model of modelsToUse) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      chain.push(model);
    }

    return this.modelHealth.filterChain(filterAllowedModels(chain, this.config));
  }

  resolveConfiguredModel(
    agentName: string,
    sessionId?: string,
    routeModelChain?: string[],
  ): string | undefined {
    const sessionOverride = this.getSessionAgentModelOverride(sessionId, agentName);
    if (sessionOverride) {
      return this.modelHealth.filterChain(
        filterAllowedModels([sessionOverride], this.config),
      )[0];
    }
    const model = this.config?.agents?.[agentName]?.model;

    if (Array.isArray(model)) {
      const first = model[0];
      return this.modelHealth.filterChain(
        filterAllowedModels(
        [
          ...(routeModelChain ?? []),
          typeof first === 'string' ? first : first?.id,
        ].filter(
          (value): value is string => Boolean(value),
        ),
          this.config,
        ),
      )[0];
    }

    if (typeof model === 'string') {
      return this.modelHealth.filterChain(
        filterAllowedModels([...(routeModelChain ?? []), model], this.config),
      )[0];
    }

    return this.modelHealth.filterChain(
      filterAllowedModels(
        [
          ...(routeModelChain ?? []),
          DEFAULT_MODELS[agentName as keyof typeof DEFAULT_MODELS],
        ].filter((value): value is string => Boolean(value)),
        this.config,
      ),
    )[0];
  }

  resolveConfiguredVariant(
    agentName: string,
    sessionId?: string,
  ): string | undefined {
    if (this.getSessionAgentModelOverride(sessionId, agentName)) {
      return undefined;
    }
    const configuredVariant = this.config?.agents?.[agentName]?.variant;
    if (typeof configuredVariant === 'string' && configuredVariant.trim()) {
      return configuredVariant.trim();
    }

    return undefined;
  }

  /**
   * Calculate tool permissions for a spawned agent based on its own delegation rules.
   * Agents that cannot delegate (leaf nodes) get delegation tools disabled entirely,
   * preventing models from even seeing tools they can never use.
   *
   * @param agentName - The agent type being spawned
   * @returns Tool permissions object with background_task and task enabled/disabled
   */
  private calculateToolPermissions(agentName: string): {
    background_task: boolean;
    task: boolean;
  } {
    const allowedSubagents = this.getSubagentRules(agentName);

    // Leaf agents (no delegation rules) get tools hidden entirely
    if (allowedSubagents.length === 0) {
      return { background_task: false, task: false };
    }

    // Agent can delegate - enable the delegation tools
    // The restriction of WHICH specific subagents are allowed is enforced
    // by the background_task tool via isAgentAllowed()
    return { background_task: true, task: true };
  }

  /**
   * Start a task in the background (Phase B).
   */
  private async startTask(task: BackgroundTask): Promise<void> {
    task.status = 'starting';
    this.activeStarts++;

    // Check if cancelled after incrementing activeStarts (to catch race)
    // Use type assertion since cancel() can change status during race condition
    if ((task as BackgroundTask & { status: string }).status === 'cancelled') {
      this.completeTask(task, 'cancelled', 'Task cancelled before start');
      return;
    }

    try {
      // Check subagent spawn depth BEFORE creating session
      const parentDepth = this.depthTracker.getDepth(task.parentSessionId);
      if (parentDepth + 1 > this.depthTracker.maxDepth) {
        log('[background-manager] spawn blocked: max depth exceeded', {
          parentSessionId: task.parentSessionId,
          parentDepth,
          maxDepth: this.depthTracker.maxDepth,
        });
        this.completeTask(task, 'failed', 'Subagent depth exceeded');
        return;
      }

      // Create session
      const session = await this.client.session.create({
        body: {
          parentID: task.parentSessionId,
          title: `Background: ${task.description}`,
        },
        query: { directory: this.directory },
      });

      if (!session.data?.id) {
        throw new Error('Failed to create background session');
      }

      task.sessionId = session.data.id;
      this.tasksBySessionId.set(session.data.id, task.id);
      this.sessionsStarting.add(session.data.id);
      // Track the agent type for this session for delegation checks
      this.agentBySessionId.set(session.data.id, task.agent);
      task.status = 'running';

      // Register depth after session creation succeeds
      this.depthTracker.registerChild(task.parentSessionId, session.data.id);

      // Give TmuxSessionManager time to spawn the pane
      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Calculate tool permissions based on the spawned agent's own delegation rules
      const toolPermissions = this.calculateToolPermissions(task.agent);

      // Send prompt
      const promptQuery: Record<string, string> = { directory: this.directory };
      const resolvedVariant = resolveAgentVariant(this.config, task.agent);
      const configuredModel = this.resolveConfiguredModel(
        task.agent,
        task.parentSessionId,
        task.routeModelChain,
      );
      const basePromptBody = applyAgentVariant(resolvedVariant, {
        agent: task.agent,
        tools: toolPermissions,
        parts: [{ type: 'text' as const, text: task.prompt }],
      } as PromptBody) as unknown as PromptBody;

      const fallbackEnabled = this.config?.fallback?.enabled ?? true;
      const timeoutMs = fallbackEnabled
        ? (this.config?.fallback?.timeoutMs ?? FALLBACK_FAILOVER_TIMEOUT_MS)
        : 0; // 0 = no timeout when fallback disabled
      const retryDelayMs = this.config?.fallback?.retryDelayMs ?? 500;
      const chain = fallbackEnabled
        ? this.resolveFallbackChain(
            task.agent,
            task.parentSessionId,
            task.routeModelChain,
          )
        : [];
      const attemptModels = chain.length > 0 ? chain : [undefined];

      const errors: string[] = [];
      let succeeded = false;
      const sessionId = session.data.id;

      const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;

      if (shouldFailClosed(this.config) && !configuredModel) {
        throw new Error(
          `No allowed model configured for ${task.agent} in current stack policy`,
        );
      }

      for (let i = 0; i < attemptModels.length; i++) {
        const model = attemptModels[i];
        const modelLabel = model ?? 'default-model';
        const startedAt = Date.now();
        let usage: SessionUsageMetrics | undefined;
        try {
          const body: PromptBody = {
            ...basePromptBody,
            model: undefined,
          };

          if (model) {
            const ref = parseModelReference(model);
            if (!ref) {
              throw new Error(`Invalid fallback model format: ${model}`);
            }
            body.model = ref;
          }

          if (i > 0) {
            log(
              `[background-manager] fallback attempt ${i + 1}/${attemptModels.length}: ${modelLabel}`,
              { taskId: task.id },
            );
          }

          const promptResult = await promptWithTimeout(
            this.client,
            {
              path: { id: sessionId },
              body,
              query: promptQuery,
            },
            timeoutMs,
          );
          usage = extractUsageMetrics(promptResult);

          // Detect silent empty responses (e.g. provider rate-limited
          // without error). When retry_on_empty is enabled (default),
          // treat as failure so the fallback chain continues.
          const extraction = await extractSessionResult(this.client, sessionId);
          if (retryOnEmpty && extraction.empty) {
            throw new Error('Empty response from provider');
          }

          this.modelHealth.recordSuccess(model);
          if (model) {
            this.modelRegistry?.recordSuccess({
              model,
              source: 'background',
              latencyMs: Date.now() - startedAt,
              usage,
            });
          }
          this.completeTask(task, 'completed', extraction.text);
          succeeded = true;
          break;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`${modelLabel}: ${msg}`);
          this.modelHealth.recordFailure(model, msg);
          if (model) {
            this.modelRegistry?.recordFailure({
              model,
              source: 'background',
              error: msg,
              latencyMs: Date.now() - startedAt,
              usage,
            });
          }
          log(`[background-manager] model failed: ${modelLabel} — ${msg}`, {
            taskId: task.id,
          });

          // Abort the session before trying the next model.
          // The previous prompt may still be running server-side;
          // without aborting, the session stays busy and rejects
          // subsequent prompts, breaking the entire fallback chain.
          if (i < attemptModels.length - 1) {
            try {
              await this.client.session.abort({
                path: { id: sessionId },
              });
              // Allow server time to finalize the abort before
              // the next prompt attempt (matches reference impl).
              await new Promise((r) => setTimeout(r, retryDelayMs));
            } catch {
              // Session may already be idle; safe to ignore.
            }
          }
        }
      }

      if (!succeeded) {
        throw new Error(`All fallback models failed. ${errors.join(' | ')}`);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.completeTask(task, 'failed', errorMessage);
    } finally {
      if (task.sessionId) {
        this.sessionsStarting.delete(task.sessionId);
      }
      this.activeStarts--;
      this.processQueue();
    }
  }

  /**
   * Handle session.status events for completion detection.
   * Uses session.status instead of deprecated session.idle.
   */
  async handleSessionStatus(event: {
    type: string;
    properties?: { sessionID?: string; status?: { type: string } };
  }): Promise<void> {
    if (event.type !== 'session.status') return;

    const sessionId = event.properties?.sessionID;
    if (!sessionId) return;

    const taskId = this.tasksBySessionId.get(sessionId);
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;

    if (this.sessionsStarting.has(sessionId)) {
      return;
    }

    // Check if session is idle (completed)
    if (event.properties?.status?.type === 'idle') {
      await this.extractAndCompleteTask(task);
    }
  }

  /**
   * Handle session.deleted events for cleanup.
   * When a session is deleted, cancel associated tasks and clean up.
   */
  async handleSessionDeleted(event: {
    type: string;
    properties?: { info?: { id?: string }; sessionID?: string };
  }): Promise<void> {
    if (event.type !== 'session.deleted') return;

    const sessionId = event.properties?.info?.id ?? event.properties?.sessionID;
    if (!sessionId) return;

    this.clearSessionAgentModelOverride(sessionId);

    const taskId = this.tasksBySessionId.get(sessionId);
    if (!taskId) return;

    const task = this.tasks.get(taskId);
    if (!task) return;

    // Only handle if task is still active
    if (task.status === 'running' || task.status === 'pending') {
      log(`[background-manager] Session deleted, cancelling task: ${task.id}`);

      // Mark as cancelled
      (task as BackgroundTask & { status: string }).status = 'cancelled';
      task.completedAt = new Date();
      task.error = 'Session deleted';

      // Clean up session tracking
      this.tasksBySessionId.delete(sessionId);
      this.agentBySessionId.delete(sessionId);
      this.depthTracker.cleanup(sessionId);

      // Resolve any waiting callers
      const resolver = this.completionResolvers.get(taskId);
      if (resolver) {
        resolver(task);
        this.completionResolvers.delete(taskId);
      }

      log(
        `[background-manager] Task cancelled due to session deletion: ${task.id}`,
      );
    }
  }

  /**
   * Extract task result and mark complete.
   * When retry_on_empty is enabled (default), empty responses are
   * treated as failures so the fallback chain can retry.
   * When disabled, empty responses succeed with an empty string result.
   */
  private async extractAndCompleteTask(task: BackgroundTask): Promise<void> {
    if (!task.sessionId) return;

    const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;

    try {
      const extraction = await extractSessionResult(
        this.client,
        task.sessionId,
      );

      if (extraction.empty && retryOnEmpty) {
        this.completeTask(task, 'failed', 'Empty response from provider');
      } else {
        this.completeTask(task, 'completed', extraction.text);
      }
    } catch (error) {
      this.completeTask(
        task,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Complete a task and notify waiting callers.
   */
  private completeTask(
    task: BackgroundTask,
    status: 'completed' | 'failed' | 'cancelled',
    resultOrError: string,
  ): void {
    // Don't check for 'cancelled' here - cancel() may set status before calling
    if (task.status === 'completed' || task.status === 'failed') {
      return; // Already completed
    }

    task.status = status;
    task.completedAt = new Date();

    if (status === 'completed') {
      task.result = resultOrError;
    } else {
      task.error = resultOrError;
    }

    // Clean up session tracking maps as fallback
    // (handleSessionDeleted also does this when session.deleted event fires)
    if (task.sessionId) {
      this.tasksBySessionId.delete(task.sessionId);
      this.agentBySessionId.delete(task.sessionId);
    }

    // Abort session to trigger pane cleanup and free resources
    if (task.sessionId) {
      this.client.session
        .abort({
          path: { id: task.sessionId },
        })
        .catch(() => {});
    }

    // Resolve waiting callers
    const resolver = this.completionResolvers.get(task.id);
    if (resolver) {
      resolver(task);
      this.completionResolvers.delete(task.id);
    }

    log(`[background-manager] task ${status}: ${task.id}`, {
      description: task.description,
    });
  }

  /**
   * Retrieve the current state of a background task.
   *
   * @param taskId - The task ID to retrieve
   * @returns The task object, or null if not found
   */
  getResult(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  markResultConsumed(taskId: string): BackgroundTask | null {
    const task = this.tasks.get(taskId) ?? null;
    if (!task || task.status !== 'completed') {
      return task;
    }

    if (!task.resultConsumedAt) {
      task.resultConsumedAt = new Date();
    }

    return task;
  }

  getTaskSnapshots(): BackgroundTaskSnapshot[] {
    return Array.from(this.tasks.values()).map((task) => ({
      id: task.id,
      sessionId: task.sessionId,
      description: task.description,
      agent: task.agent,
      status: task.status,
      parentSessionId: task.parentSessionId,
      startedAt: task.startedAt.toISOString(),
      completedAt: task.completedAt?.toISOString(),
      resultConsumedAt: task.resultConsumedAt?.toISOString(),
      configuredModel: this.resolveConfiguredModel(task.agent, task.parentSessionId),
      variant: this.resolveConfiguredVariant(task.agent, task.parentSessionId),
      fallbackChain: this.resolveFallbackChain(task.agent, task.parentSessionId),
      category: task.category,
      lane: task.lane,
      routeModelChain: task.routeModelChain,
    }));
  }

  getModelHealthSnapshots(): ModelHealthSnapshot[] {
    return this.modelHealth.getSnapshots();
  }

  /**
   * Wait for a task to complete.
   *
   * @param taskId - The task ID to wait for
   * @param timeout - Maximum time to wait in milliseconds (0 = no timeout)
   * @returns The completed task, or null if not found/timeout
   */
  async waitForCompletion(
    taskId: string,
    timeout = 0,
  ): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
    ) {
      return task;
    }

    return new Promise((resolve) => {
      const resolver = (t: BackgroundTask) => resolve(t);
      this.completionResolvers.set(taskId, resolver);

      if (timeout > 0) {
        setTimeout(() => {
          this.completionResolvers.delete(taskId);
          resolve(this.tasks.get(taskId) ?? null);
        }, timeout);
      }
    });
  }

  /**
   * Cancel one or all running background tasks.
   *
   * @param taskId - Optional task ID to cancel. If omitted, cancels all pending/running tasks.
   * @returns Number of tasks cancelled
   */
  cancel(taskId?: string): number {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (
        task &&
        (task.status === 'pending' ||
          task.status === 'starting' ||
          task.status === 'running')
      ) {
        // Clean up any waiting resolver
        this.completionResolvers.delete(taskId);

        // Check if in start queue (must check before marking cancelled)
        const inStartQueue = task.status === 'pending';

        // Mark as cancelled FIRST to prevent race with startTask
        // Use type assertion since we're deliberately changing status before completeTask
        (task as BackgroundTask & { status: string }).status = 'cancelled';

        // Remove from start queue if pending
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === taskId);
          if (idx >= 0) {
            this.startQueue.splice(idx, 1);
          }
        }

        this.completeTask(task, 'cancelled', 'Cancelled by user');
        return 1;
      }
      return 0;
    }

    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === 'pending' ||
        task.status === 'starting' ||
        task.status === 'running'
      ) {
        // Clean up any waiting resolver
        this.completionResolvers.delete(task.id);

        // Check if in start queue (must check before marking cancelled)
        const inStartQueue = task.status === 'pending';

        // Mark as cancelled FIRST to prevent race with startTask
        // Use type assertion since we're deliberately changing status before completeTask
        (task as BackgroundTask & { status: string }).status = 'cancelled';

        // Remove from start queue if pending
        if (inStartQueue) {
          const idx = this.startQueue.findIndex((t) => t.id === task.id);
          if (idx >= 0) {
            this.startQueue.splice(idx, 1);
          }
        }

        this.completeTask(task, 'cancelled', 'Cancelled by user');
        count++;
      }
    }
    return count;
  }

  /**
   * Clean up all tasks.
   */
  cleanup(): void {
    this.startQueue = [];
    this.sessionsStarting.clear();
    this.completionResolvers.clear();
    this.tasks.clear();
    this.tasksBySessionId.clear();
    this.agentBySessionId.clear();
    this.depthTracker.cleanupAll();
  }

  /**
   * Get the depth tracker instance for use by other managers.
   */
  getDepthTracker(): SubagentDepthTracker {
    return this.depthTracker;
  }
}
