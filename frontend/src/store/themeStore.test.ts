import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => useThemeStore.setState({ pref: 'system' }));
  it('defaults to system', () => {
    expect(useThemeStore.getState().pref).toBe('system');
  });
  it('setPref updates and persists to localStorage', () => {
    useThemeStore.getState().setPref('dark');
    expect(useThemeStore.getState().pref).toBe('dark');
    expect(localStorage.getItem('kds-theme')).toContain('dark');
  });
});
