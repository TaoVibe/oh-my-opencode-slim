import { describe, expect, test } from 'bun:test';
import {
  composeOrchestratorSystemMessages,
  ORCHESTRATOR_PROMPT,
} from './orchestrator';

describe('composeOrchestratorSystemMessages', () => {
  test('keeps stable orchestrator prompt first and routing notice last', () => {
    const result = composeOrchestratorSystemMessages(
      ['user system context'],
      '<RoutingHealth>healthy</RoutingHealth>',
    );

    expect(result).toEqual([
      ORCHESTRATOR_PROMPT,
      'user system context',
      '<RoutingHealth>healthy</RoutingHealth>',
    ]);
  });

  test('does not duplicate orchestrator prompt if already present', () => {
    const result = composeOrchestratorSystemMessages([
      ORCHESTRATOR_PROMPT,
      'extra',
    ]);

    expect(result).toEqual([ORCHESTRATOR_PROMPT, 'extra']);
  });
});
