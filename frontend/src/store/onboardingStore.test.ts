import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useOnboardingStore } from './onboardingStore';

describe('onboardingStore', () => {
  beforeEach(() => useOnboardingStore.setState({ dismissed: {} }));

  it('migrates a legacy localStorage dismissal into the store on load', async () => {
    localStorage.setItem('marketing:onboarding:dismissed:wLegacy', '1');
    localStorage.removeItem('kds-onboarding');
    vi.resetModules();
    const mod = await import('./onboardingStore');
    expect(mod.useOnboardingStore.getState().dismissed.wLegacy).toBe(true);
    // legacy key is consumed so it never re-applies
    expect(localStorage.getItem('marketing:onboarding:dismissed:wLegacy')).toBeNull();
  });

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
