interface MessageInfo {
  role: string;
  agent?: string;
  sessionID?: string;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

interface SessionState {
  sawPrometheus: boolean;
  sawMomus: boolean;
  warningCounts: {
    prometheus: number;
    momus: number;
  };
  overrideCounts: {
    prometheus: number;
    momus: number;
  };
  seenWarningFingerprints: Set<string>;
  seenOverrideFingerprints: Set<string>;
}

export interface MustInvokeSessionStats {
  sawPrometheus: boolean;
  sawMomus: boolean;
  warningCounts: {
    prometheus: number;
    momus: number;
  };
  overrideCounts: {
    prometheus: number;
    momus: number;
  };
}

interface EventInput {
  event: {
    type: string;
    properties?: {
      info?: { id?: string; parentID?: string };
      sessionID?: string;
      agentName?: string;
    };
  };
}

const MUST_INVOKE_WARNING_OPEN = '<must_invoke_warning>';
const MUST_INVOKE_WARNING_CLOSE = '</must_invoke_warning>';
const COMMIT_REQUEST_PATTERN =
  /\b(git commit|commit it|commit this|create (?:a )?commit|make (?:a )?commit|commit these changes)\b/i;
const PLANNING_REQUEST_PATTERN =
  /\b(refactor|architecture|re-architect|multi-file|multiple files|across files|trade[- ]?off|system design|wiring)\b/i;

function getTextParts(message: MessageWithParts): MessagePart[] {
  return message.parts.filter(
    (part) => part.type === 'text' && typeof part.text === 'string',
  );
}

function getCombinedText(message: MessageWithParts): string {
  return getTextParts(message)
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function hasOverride(text: string, agentName: 'momus' | 'prometheus'): boolean {
  const overrideToken = new RegExp(`#override:${agentName}:`, 'i');
  if (overrideToken.test(text)) {
    return true;
  }

  if (agentName === 'momus') {
    return /\b(skip review|just commit it|waive review)\b/i.test(text);
  }

  return /\b(skip plan|no plan needed|just do it)\b/i.test(text);
}

function findExplicitOverrideToken(
  text: string,
  agentName: 'momus' | 'prometheus',
): string | undefined {
  return text.match(new RegExp(`#override:${agentName}:[^\n]+`, 'i'))?.[0];
}

function buildWarningText(lines: string[]): string {
  return `${MUST_INVOKE_WARNING_OPEN}\n${lines.join('\n')}\n${MUST_INVOKE_WARNING_CLOSE}`;
}

export function createMustInvokeGuardHook() {
  const childToParent = new Map<string, string>();
  const sessionState = new Map<string, SessionState>();

  function ensureState(sessionID: string): SessionState {
    const existing = sessionState.get(sessionID);
    if (existing) {
      return existing;
    }

    const state: SessionState = {
      sawPrometheus: false,
      sawMomus: false,
      warningCounts: { prometheus: 0, momus: 0 },
      overrideCounts: { prometheus: 0, momus: 0 },
      seenWarningFingerprints: new Set<string>(),
      seenOverrideFingerprints: new Set<string>(),
    };
    sessionState.set(sessionID, state);
    return state;
  }

  function recordOverrideSightings(state: SessionState, text: string): void {
    for (const agentName of ['prometheus', 'momus'] as const) {
      const token = findExplicitOverrideToken(text, agentName);
      if (!token) {
        continue;
      }

      const fingerprint = `${agentName}:${token.toLowerCase()}`;
      if (state.seenOverrideFingerprints.has(fingerprint)) {
        continue;
      }

      state.seenOverrideFingerprints.add(fingerprint);
      state.overrideCounts[agentName] += 1;
    }
  }

  function recordWarningInjection(
    state: SessionState,
    agentName: 'prometheus' | 'momus',
    text: string,
  ): void {
    const fingerprint = `${agentName}:${text.toLowerCase()}`;
    if (state.seenWarningFingerprints.has(fingerprint)) {
      return;
    }

    state.seenWarningFingerprints.add(fingerprint);
    state.warningCounts[agentName] += 1;
  }

  function getSessionStats(sessionID: string): MustInvokeSessionStats {
    const state = ensureState(sessionID);
    return {
      sawPrometheus: state.sawPrometheus,
      sawMomus: state.sawMomus,
      warningCounts: { ...state.warningCounts },
      overrideCounts: { ...state.overrideCounts },
    };
  }

  return {
    event: async (input: EventInput): Promise<void> => {
      const event = input.event;

      if (event.type === 'session.created') {
        const info = event.properties?.info;
        if (info?.id && info.parentID) {
          childToParent.set(info.id, info.parentID);
        }
        return;
      }

      if (event.type === 'subagent.session.created') {
        const childSessionID = event.properties?.sessionID;
        const agentName = event.properties?.agentName;
        if (!childSessionID || !agentName) {
          return;
        }

        const parentSessionID = childToParent.get(childSessionID);
        if (!parentSessionID) {
          return;
        }

        const state = ensureState(parentSessionID);
        if (agentName === 'prometheus') {
          state.sawPrometheus = true;
        }
        if (agentName === 'momus') {
          state.sawMomus = true;
        }
        return;
      }

      if (event.type === 'session.deleted') {
        const sessionID =
          event.properties?.sessionID ?? event.properties?.info?.id;
        if (!sessionID) {
          return;
        }
        childToParent.delete(sessionID);
        sessionState.delete(sessionID);
      }
    },

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const lastUserMessage = [...output.messages]
        .reverse()
        .find((message) => message.info.role === 'user');

      if (!lastUserMessage) {
        return;
      }

      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const textParts = getTextParts(lastUserMessage);
      const textPart = textParts[0];
      const originalText = getCombinedText(lastUserMessage);
      const sessionID = lastUserMessage.info.sessionID;
      if (!textPart || !originalText || !sessionID) {
        return;
      }

      if (originalText.includes(MUST_INVOKE_WARNING_OPEN)) {
        return;
      }

      const state = ensureState(sessionID);
      recordOverrideSightings(state, originalText);
      const warnings: string[] = [];

      if (
        COMMIT_REQUEST_PATTERN.test(originalText) &&
        !state.sawMomus &&
        !hasOverride(originalText, 'momus')
      ) {
        recordWarningInjection(state, 'momus', originalText);
        warnings.push(
          'Review gate reminder: run Momus before a non-trivial commit, or include #override:momus:<reason>.',
        );
      }

      if (
        PLANNING_REQUEST_PATTERN.test(originalText) &&
        !state.sawPrometheus &&
        !hasOverride(originalText, 'prometheus')
      ) {
        recordWarningInjection(state, 'prometheus', originalText);
        warnings.push(
          'Planning gate reminder: run Prometheus before multi-file or architecture-affecting work, or include #override:prometheus:<reason>.',
        );
      }

      if (warnings.length === 0) {
        return;
      }

      textPart.text = `${buildWarningText(warnings)}\n\n---\n\n${originalText}`;
    },

    getSessionStats,
  };
}
