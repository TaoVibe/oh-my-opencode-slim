const LEGACY_SLIM_INTERNAL_INITIATOR_MARKER =
  '<!-- SLIM_INTERNAL_INITIATOR -->';

// Use an invisible sentinel so internal prompts can be detected without
// leaking visible marker text into the chat transcript.
export const SLIM_INTERNAL_INITIATOR_MARKER =
  '\u2063\u2060\u200b\u200c\u200d\u2063\u2060\u200b\u200c\u200d';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createInternalAgentTextPart(text: string): {
  type: 'text';
  text: string;
} {
  return {
    type: 'text',
    text: `${text}\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
  };
}

export function hasInternalInitiatorMarker(part: unknown): boolean {
  if (!isRecord(part) || part.type !== 'text') {
    return false;
  }

  if (typeof part.text !== 'string') {
    return false;
  }

  return (
    part.text.includes(SLIM_INTERNAL_INITIATOR_MARKER) ||
    part.text.includes(LEGACY_SLIM_INTERNAL_INITIATOR_MARKER)
  );
}
