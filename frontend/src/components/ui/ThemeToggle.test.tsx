import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { useThemeStore } from '@/store/themeStore';

describe('ThemeToggle', () => {
  beforeEach(() => useThemeStore.setState({ pref: 'system' }));
  it('marks the active pref with aria-pressed', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'System', pressed: true })).toBeInTheDocument();
  });
  it('switches pref on click and toggles <html>.dark', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(useThemeStore.getState().pref).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});
