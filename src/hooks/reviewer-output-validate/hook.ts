import type { PluginInput } from '@opencode-ai/plugin';

const REVIEW_AGENTS = new Set(['oracle', 'momus']);

function extractHeaderValue(output: string, label: string): string | null {
  const match = output.match(new RegExp(`^ ${label}: (.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function extractBody(output: string): string {
  const marker = '\n ---\n\n ';
  const index = output.indexOf(marker);
  return index >= 0 ? output.slice(index + marker.length).trim() : output.trim();
}

function getDraftNumbers(text: string): number[] {
  return Array.from(text.matchAll(/Draft\s+(\d+)/gi), (match) =>
    Number.parseInt(match[1] ?? '', 10),
  ).filter(Number.isFinite);
}

function buildWarnings(output: string): string[] {
  const status = extractHeaderValue(output, 'Status');
  const agent = extractHeaderValue(output, 'Agent')?.toLowerCase();
  const description = extractHeaderValue(output, 'Description')?.toLowerCase() ?? '';

  if (status !== 'completed' || !agent || !REVIEW_AGENTS.has(agent)) {
    return [];
  }

  const body = extractBody(output);
  const warnings: string[] = [];

  if (!body) {
    warnings.push('review result body is empty');
    return warnings;
  }

  const draftReview = description.includes('draft');
  const draftNumbers = getDraftNumbers(body);

  if (draftReview) {
    if (body.length < 200) {
      warnings.push('draft review result is unusually short');
    }
    if (draftNumbers.length === 0) {
      warnings.push('no explicit draft sections detected');
    } else {
      const unique = [...new Set(draftNumbers)].sort((a, b) => a - b);
      const contiguous = unique.every(
        (value, index) => index === 0 || value === unique[index - 1] + 1,
      );
      if (!contiguous) {
        warnings.push('draft numbering is non-contiguous');
      }
      if (unique[unique.length - 1] > 5) {
        warnings.push('references draft numbers beyond 5; verify no extra items were invented');
      }
    }
  }

  return warnings;
}

export function createReviewerOutputValidateHook(_ctx: PluginInput) {
  return {
    'tool.execute.after': async (
      input: { tool: string },
      output: { output: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'background_output') {
        return;
      }

      if (typeof output.output !== 'string') {
        return;
      }

      const warnings = buildWarnings(output.output);
      if (warnings.length === 0) {
        return;
      }

      output.output += `\n\n[review validation warning]\n- ${warnings.join('\n- ')}\nVerify against the source prompt before trusting this reviewer output.`;
    },
  };
}

export { buildWarnings };
