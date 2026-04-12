import { describe, expect, test } from 'bun:test';
import {
  createInternalAgentTextPart,
  hasInternalInitiatorMarker,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from './internal-initiator';

describe('internal initiator marker', () => {
  test('uses an invisible sentinel instead of visible comment text', () => {
    expect(SLIM_INTERNAL_INITIATOR_MARKER).not.toContain('SLIM_INTERNAL');
    expect(SLIM_INTERNAL_INITIATOR_MARKER).not.toContain('<!--');
  });

  test('appends the marker to internal text parts', () => {
    const part = createInternalAgentTextPart('internal notification');

    expect(part.text).toContain('internal notification');
    expect(part.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    expect(hasInternalInitiatorMarker(part)).toBe(true);
  });

  test('recognizes the legacy visible marker for resumed sessions', () => {
    expect(
      hasInternalInitiatorMarker({
        type: 'text',
        text: 'old notification\n<!-- SLIM_INTERNAL_INITIATOR -->',
      }),
    ).toBe(true);
  });
});
