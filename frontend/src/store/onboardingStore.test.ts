import { describe, it, expect, beforeEach } from 'vitest';
import { useOnboardingStore } from './onboardingStore';

describe('onboardingStore', () => {
  beforeEach(() => useOnboardingStore.setState({ dismissed: {} }));

  it('dismiss then reopen toggles a workspace', () => {
    useOnboardingStore.getState().dismiss('w1');
    expect(useOnboardingStore.getState().dismissed.w1).toBe(true);
    useOnboardingStore.getState().reopen('w1');
    expect(useOnboardingStore.getState().dismissed.w1).toBeUndefined();
  });

  it('keeps workspaces independent', () => {
    useOnboardingStore.getState().dismiss('w1');
    expect(!!useOnboardingStore.getState().dismissed.w2).toBe(false);
  });
});
