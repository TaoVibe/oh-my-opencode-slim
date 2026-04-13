import { describe, expect, test } from 'bun:test';
import { createReviewerOutputValidateHook } from './hook';

describe('reviewer-output-validate hook', () => {
  test('appends warning for suspicious short oracle review output', async () => {
    const hook = createReviewerOutputValidateHook({} as never);
    const output = {
      output: `Task: bg_oracle\n Description: Review 5 routing drafts\n Agent: oracle\n Status: completed\n Duration: 5s\n\n ---\n\n Draft 1: ok`,
    };

    await hook['tool.execute.after']({ tool: 'background_output' }, output);

    expect(output.output).toContain('[review validation warning]');
    expect(output.output).toContain('draft review result is unusually short');
  });

  test('does nothing for non-review agents', async () => {
    const hook = createReviewerOutputValidateHook({} as never);
    const output = {
      output: `Task: bg_explorer\n Description: Map codebase\n Agent: explorer\n Status: completed\n Duration: 5s\n\n ---\n\n all good`,
    };

    await hook['tool.execute.after']({ tool: 'background_output' }, output);

    expect(output.output).not.toContain('[review validation warning]');
  });

  test('does nothing for normal code review without draft workflow', async () => {
    const hook = createReviewerOutputValidateHook({} as never);
    const output = {
      output: `Task: bg_oracle\n Description: Review routing policy\n Agent: oracle\n Status: completed\n Duration: 5s\n\n ---\n\n P1: route mismatch\nP2: stale doc`,
    };

    await hook['tool.execute.after']({ tool: 'background_output' }, output);

    expect(output.output).not.toContain('[review validation warning]');
  });
});
