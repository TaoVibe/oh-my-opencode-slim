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
export type RoutedLane = 'cheap' | 'value' | 'premium';

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

const LANE_PATTERNS: Readonly<Record<RoutedLane, readonly RegExp[]>> = {
  cheap: [
    /\bquick fix\b/i,
    /\bsmall change\b/i,
    /\bminor\b/i,
    /\btrivial\b/i,
    /\btypo\b/i,
    /\bone[- ]file\b/i,
    /\bnarrow test improvement\b/i,
    /\bsimple test\b/i,
  ],
  value: [
    /\bmedium\b/i,
    /\bmulti[- ]file\b/i,
    /\bresearch\b/i,
    /\binvestigate\b/i,
    /\bdebug\b/i,
    /\boptimi[sz]e\b/i,
  ],
  premium: [
    /\bimportant\b/i,
    /\bbackbone\b/i,
    /\bcritical\b/i,
    /\bhigh[- ]stakes\b/i,
    /\barchitecture\b/i,
    /\bsecurity\b/i,
    /\bdeep\b/i,
    /\brepo[- ]scale\b/i,
  ],
};

export function detectIntent(text: string): RoutedIntent | null {
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(text)) {
      return rule.intent;
    }
  }

  return null;
}

export function detectLane(text: string): RoutedLane | null {
  const matches = (Object.keys(LANE_PATTERNS) as RoutedLane[]).filter((lane) =>
    LANE_PATTERNS[lane].some((pattern) => pattern.test(text)),
  );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

export function buildIntentInstruction(
  intent: RoutedIntent,
  lane?: RoutedLane | null,
): string {
  const rule = INTENT_RULES.find((item) => item.intent === intent);
  if (!rule) {
    return '';
  }

  return [
    '<intent_router>',
    `intent=${rule.intent}`,
    ...(lane ? [`lane_hint=${lane}`] : []),
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
      const lane = detectLane(originalText);
      if (!intent && !lane) {
        return;
      }

      const instruction = intent
        ? buildIntentInstruction(intent, lane)
        : [
            '<intent_router>',
            `lane_hint=${lane}`,
            'Prefer category + lane routing for this request.',
            '</intent_router>',
          ].join('\n');
      if (!instruction) {
        return;
      }

      lastUserMessage.parts[textPartIndex].text =
        `${instruction}\n\n---\n\n${originalText}`;
    },
  };
}
