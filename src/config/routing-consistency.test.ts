import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract test: routing sources of truth must agree.
 *
 * This test verifies that the three places where model assignments live
 * in the profile JSONC are consistent:
 *
 *   1. presets.qde-standard.<role>.model — the preset definition
 *   2. agents.<role>.model — the custom agent override
 *   3. fallback.chains.<role> — the fallback chain
 *
 * The primary model (first entry) must match across all three sources
 * for every role that appears in more than one source.
 *
 * If a role intentionally diverges, add it to KNOWN_DIVERGENCES below
 * with a reason and review date.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadProfile(): Record<string, unknown> {
  const profilePath = resolve(
    process.env.HOME || '/Users/mdoan',
    '.config/opencode/oh-my-opencode-slim.jsonc',
  );
  const raw = readFileSync(profilePath, 'utf-8');
  // Strip JSONC comments (naive: line-level // comments only)
  const stripped = raw
    .split('\n')
    .map((line: string) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return JSON.parse(stripped) as Record<string, unknown>;
}

function firstModel(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && entry.length > 0) {
    const first = entry[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'id' in first)
      return (first as { id: string }).id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Known intentional divergences
// ---------------------------------------------------------------------------

/**
 * If a role intentionally has a different primary across sources,
 * document it here with reason and review date.
 *
 * Format: `${presetPrimary} != ${agentPrimary}` or similar.
 * Each entry must have a reason and a review-by date.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { reason: string; reviewBy: string }
> = {
  // Example (remove when no divergences exist):
  // 'prometheus:chutes/openai/gpt-oss-120b-TEE != chutes/XiaomiMiMo/MiMo-V2-Flash': {
  //   reason: 'Reliability-first: gpt-oss-120b showed fewer harness failures than MiMo in week of 2026-04-07',
  //   reviewBy: '2026-04-21',
  // },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routing source-of-truth consistency', () => {
  const profile = loadProfile();

  const presets = (profile.presets as Record<string, Record<string, unknown>>)[
    'qde-standard'
  ] as Record<string, Record<string, unknown>>;
  const agents = profile.agents as Record<
    string,
    Record<string, unknown>
  >;
  const fallback = (profile.fallback as Record<string, unknown>)
    .chains as Record<string, unknown>;

  // Roles that appear in presets (the canonical role set)
  const presetRoles = Object.keys(presets);

  for (const role of presetRoles) {
    test(`${role}: preset primary matches fallback chain primary`, () => {
      const presetPrimary = firstModel(presets[role]?.model);
      const fallbackPrimary = firstModel(fallback[role]);

      if (presetPrimary === null || fallbackPrimary === null) {
        // If one source doesn't define this role, skip
        return;
      }

      const divergenceKey = `${role}:${presetPrimary} != ${fallbackPrimary}`;

      if (presetPrimary !== fallbackPrimary) {
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          // Known divergence — check review date
          const reviewBy = new Date(known.reviewBy);
          const now = new Date();
          expect(
            reviewBy > now,
            `Known divergence for ${role} is past its review date (${known.reviewBy}). Review or update.`,
          ).toBe(true);
        } else {
          expect(
            false,
            `Primary mismatch for ${role}: preset=${presetPrimary}, fallback=${fallbackPrimary}. ` +
              `If intentional, add to KNOWN_DIVERGENCES with reason and review date.`,
          ).toBe(true);
        }
      } else {
        // Primaries match — this is the happy path
        expect(presetPrimary).toBe(fallbackPrimary);
      }
    });

    test(`${role}: preset primary matches agent override primary (if defined)`, () => {
      const presetPrimary = firstModel(presets[role]?.model);
      const agentPrimary = firstModel(agents[role]?.model);

      if (presetPrimary === null || agentPrimary === null) {
        // If agent override doesn't define this role, skip
        return;
      }

      const divergenceKey = `${role}:${presetPrimary} != ${agentPrimary}`;

      if (presetPrimary !== agentPrimary) {
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          const reviewBy = new Date(known.reviewBy);
          const now = new Date();
          expect(
            reviewBy > now,
            `Known divergence for ${role} is past its review date (${known.reviewBy}). Review or update.`,
          ).toBe(true);
        } else {
          expect(
            false,
            `Primary mismatch for ${role}: preset=${presetPrimary}, agent=${agentPrimary}. ` +
              `If intentional, add to KNOWN_DIVERGENCES with reason and review date.`,
          ).toBe(true);
        }
      } else {
        expect(presetPrimary).toBe(agentPrimary);
      }
    });
  }

  // Also check agent-only roles (prometheus, momus, hephaestus) against fallback
  const agentRoles = Object.keys(agents);
  for (const role of agentRoles) {
    test(`${role}: agent primary matches fallback chain primary`, () => {
      const agentPrimary = firstModel(agents[role]?.model);
      const fallbackPrimary = firstModel(fallback[role]);

      if (agentPrimary === null || fallbackPrimary === null) {
        return;
      }

      const divergenceKey = `${role}:${agentPrimary} != ${fallbackPrimary}`;

      if (agentPrimary !== fallbackPrimary) {
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          const reviewBy = new Date(known.reviewBy);
          const now = new Date();
          expect(
            reviewBy > now,
            `Known divergence for ${role} is past its review date (${known.reviewBy}). Review or update.`,
          ).toBe(true);
        } else {
          expect(
            false,
            `Primary mismatch for ${role}: agent=${agentPrimary}, fallback=${fallbackPrimary}. ` +
              `If intentional, add to KNOWN_DIVERGENCES with reason and review date.`,
          ).toBe(true);
        }
      } else {
        expect(agentPrimary).toBe(fallbackPrimary);
      }
    });
  }
});