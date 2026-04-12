import { describe, expect, test } from 'bun:test';
import { applyNativePermissionHints } from './native-permissions';

describe('applyNativePermissionHints', () => {
  test('leaves permissions unchanged when feature flag is disabled', () => {
    expect(applyNativePermissionHints({ question: 'allow' }, {})).toEqual({
      question: 'allow',
    });
  });

  test('adds bash ask when feature flag is enabled', () => {
    expect(
      applyNativePermissionHints(
        { question: 'allow' },
        { nativeBashAskAll: true, orchestratorFollowsSessionModel: false },
      ),
    ).toEqual({
      question: 'allow',
      bash: 'ask',
    });
  });

  test('respects existing bash permission', () => {
    expect(
      applyNativePermissionHints(
        { question: 'allow', bash: 'allow' },
        { nativeBashAskAll: true, orchestratorFollowsSessionModel: false },
      ),
    ).toEqual({
      question: 'allow',
      bash: 'allow',
    });
  });
});
