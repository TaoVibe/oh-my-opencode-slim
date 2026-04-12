interface MessageInfo {
  role: string;
  agent?: string;
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

export type RoutedIntent = 'deep_research' | 'deep_review';

interface IntentRule {
  intent: RoutedIntent;
  pattern: RegExp;
}

export const INTENT_ALIASES: Readonly<Record<RoutedIntent, readonly string[]>> =
  {
    deep_research: ['deep research', 'research deeply'],
    deep_review: ['deep review', 'thorough review', 'review deeply'],
  };

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildIntentRules(): readonly IntentRule[] {
  return Object.entries(INTENT_ALIASES).map(([intent, aliases]) => ({
    intent: intent as RoutedIntent,
    pattern: new RegExp(`\\b(?:${aliases.map(escapeRegex).join('|')})\\b`, 'i'),
  }));
}

const INTENT_RULES = buildIntentRules();

export function detectIntent(text: string): RoutedIntent | null {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) {
      return rule.intent;
    }
  }

  return null;
}

export function buildIntentInstruction(intent: RoutedIntent): string {
  const rule = INTENT_RULES.find((item) => item.intent === intent);
  if (!rule) {
    return '';
  }

  return [
    '<intent_router>',
    `intent=${rule.intent}`,
    'Follow the orchestrator workflow for this intent.',
    '</intent_router>',
  ].join('\n');
}

/**
 * Inject hidden routing hints for special workflow phrases.
 * Runs pre-send, so nothing is shown in the UI.
 */
export function createIntentRouterHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;
      if (messages.length === 0) {
        return;
      }

      let lastUserMessageIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === 'user') {
          lastUserMessageIndex = index;
          break;
        }
      }

      if (lastUserMessageIndex === -1) {
        return;
      }

      const lastUserMessage = messages[lastUserMessageIndex];
      const agent = lastUserMessage.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const textPartIndex = lastUserMessage.parts.findIndex(
        (part) => part.type === 'text' && part.text !== undefined,
      );
      if (textPartIndex === -1) {
        return;
      }

      const originalText = lastUserMessage.parts[textPartIndex].text ?? '';
      if (originalText.includes('<intent_router>')) {
        return;
      }

      const intent = detectIntent(originalText);
      if (!intent) {
        return;
      }

      const instruction = buildIntentInstruction(intent);
      if (!instruction) {
        return;
      }

      lastUserMessage.parts[textPartIndex].text =
        `${instruction}\n\n---\n\n${originalText}`;
    },
  };
}
