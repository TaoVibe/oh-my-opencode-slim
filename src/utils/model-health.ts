import type { FallbackHealthConfig } from '../config/schema';

interface ModelHealthState {
  consecutiveFailures: number;
  cooldownLevel: number;
  cooldownUntil: number;
}

function classifyFailure(message: string): 'immediate' | 'transient' | 'other' {
  const text = message.toLowerCase();

  if (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('empty response')
  ) {
    return 'immediate';
  }

  if (
    /\b429\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('quota exceeded') ||
    text.includes('usage exceeded') ||
    text.includes('overloaded') ||
    text.includes('resource exhausted') ||
    text.includes('gateway') ||
    text.includes('503') ||
    text.includes('502') ||
    text.includes('504') ||
    text.includes('temporarily unavailable')
  ) {
    return 'transient';
  }

  return 'other';
}

export class ModelHealthTracker {
  private readonly states = new Map<string, ModelHealthState>();

  constructor(private readonly config?: FallbackHealthConfig) {}

  isEnabled(): boolean {
    return this.config?.enabled === true;
  }

  isCooling(model: string, now = Date.now()): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    const state = this.states.get(model);
    if (!state) {
      return false;
    }

    if (state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      return false;
    }

    return true;
  }

  filterChain(models: string[]): string[] {
    if (!this.isEnabled()) {
      return models;
    }

    const filtered = models.filter((model) => !this.isCooling(model));
    return filtered.length > 0 ? filtered : models;
  }

  recordSuccess(model?: string): void {
    if (!this.isEnabled() || !model) {
      return;
    }

    this.states.delete(model);
  }

  recordFailure(model: string | undefined, message: string): void {
    if (!this.isEnabled() || !model) {
      return;
    }

    const state = this.states.get(model) ?? {
      consecutiveFailures: 0,
      cooldownLevel: 0,
      cooldownUntil: 0,
    };

    state.consecutiveFailures += 1;
    const failureClass = classifyFailure(message);
    const threshold =
      failureClass === 'immediate' ? 1 : (this.config?.failureThreshold ?? 2);

    if (state.consecutiveFailures >= threshold) {
      state.cooldownLevel += 1;
      const baseCooldown = this.config?.cooldownMs ?? 300_000;
      const maxCooldown = this.config?.maxCooldownMs ?? 1_800_000;
      const backoff = this.config?.backoffMultiplier ?? 2;
      const cooldown = Math.min(
        baseCooldown * backoff ** Math.max(0, state.cooldownLevel - 1),
        maxCooldown,
      );
      state.cooldownUntil = Date.now() + cooldown;
      state.consecutiveFailures = 0;
    }

    this.states.set(model, state);
  }
}
