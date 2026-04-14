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

const PRESERVED_USER_TURNS = 4;
const MIN_MESSAGES_BEFORE_COMPACTION = 12;
const MAX_USER_REQUESTS = 4;
const MAX_SNIPPET_LENGTH = 220;
const INTERESTING_HEADINGS = [
  'Goal',
  'Assumptions',
  'Risks',
  'Open Questions',
  'Verdict',
  'Disposition',
  'Net Disposition',
] as const;

function getMessageText(message: MessageWithParts): string {
  return message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function shorten(text: string, maxLength: number = MAX_SNIPPET_LENGTH): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractHeadingSection(text: string, heading: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let startIndex = -1;

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].match(new RegExp(`^#{1,6}\\s*${heading}\\b`, 'i'))) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return undefined;
  }

  const sectionLines: string[] = [];
  for (let index = startIndex; index < lines.length; index++) {
    if (/^#{1,6}\s+/.test(lines[index])) {
      break;
    }
    sectionLines.push(lines[index]);
  }

  const section = sectionLines.join('\n').trim();
  return section ? shorten(section) : undefined;
}

function collectLatestSections(
  messages: MessageWithParts[],
): Partial<Record<(typeof INTERESTING_HEADINGS)[number], string>> {
  const found: Partial<Record<(typeof INTERESTING_HEADINGS)[number], string>> = {};

  for (let index = messages.length - 1; index >= 0; index--) {
    const text = getMessageText(messages[index]);
    if (!text) continue;

    for (const heading of INTERESTING_HEADINGS) {
      if (found[heading]) continue;
      const section = extractHeadingSection(text, heading);
      if (section) {
        found[heading] = section;
      }
    }
  }

  return found;
}

function collectPriorUserRequests(messages: MessageWithParts[]): string[] {
  return messages
    .filter((message) => message.info.role === 'user')
    .map(getMessageText)
    .filter(Boolean)
    .slice(-MAX_USER_REQUESTS)
    .map((text) => `- ${shorten(text)}`);
}

function buildSummaryText(messages: MessageWithParts[]): string | undefined {
  const priorRequests = collectPriorUserRequests(messages);
  const latestSections = collectLatestSections(messages);
  const latestRisks = latestSections.Risks;
  const latestAssumptions = latestSections.Assumptions;
  const latestGoal = latestSections.Goal;
  const latestOpenQuestions = latestSections['Open Questions'];
  const latestDisposition =
    latestSections['Net Disposition'] ??
    latestSections.Disposition ??
    latestSections.Verdict;

  const lines = ['<context_summary>', 'Earlier conversation compacted deterministically.'];

  if (priorRequests.length > 0) {
    lines.push('Prior user requests:');
    lines.push(...priorRequests);
  }

  if (latestGoal) {
    lines.push(`Locked goal: ${latestGoal}`);
  }

  if (latestAssumptions) {
    lines.push(`Active assumptions: ${latestAssumptions}`);
  }

  if (latestRisks) {
    lines.push(`Active risks: ${latestRisks}`);
  }

  if (latestOpenQuestions) {
    lines.push(`Open questions: ${latestOpenQuestions}`);
  }

  if (latestDisposition) {
    lines.push(`Latest review state: ${latestDisposition}`);
  }

  lines.push('</context_summary>');

  return lines.length > 2 ? lines.join('\n') : undefined;
}

function findUserMessageIndices(messages: MessageWithParts[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.info.role === 'user') {
      indices.push(index);
    }
  }
  return indices;
}

export function createContextCompactionHook() {
  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;

      if (messages.length < MIN_MESSAGES_BEFORE_COMPACTION) {
        return;
      }

      const userIndices = findUserMessageIndices(messages);
      if (userIndices.length <= PRESERVED_USER_TURNS) {
        return;
      }

      const lastUserIndex = userIndices[userIndices.length - 1];
      const lastUser = messages[lastUserIndex];
      const agent = lastUser?.info.agent;
      if (agent && agent !== 'orchestrator') {
        return;
      }

      const preserveFromIndex = userIndices[userIndices.length - PRESERVED_USER_TURNS];
      if (preserveFromIndex <= 0) {
        return;
      }

      const compactedMessages = messages.slice(0, preserveFromIndex);
      const summaryText = buildSummaryText(compactedMessages);
      if (!summaryText) {
        return;
      }

      const preservedMessages = messages.slice(preserveFromIndex);
      output.messages = [
        {
          info: {
            role: 'assistant',
            agent: 'orchestrator',
            sessionID: lastUser?.info.sessionID,
          },
          parts: [{ type: 'text', text: summaryText }],
        },
        ...preservedMessages,
      ];
    },
  };
}
