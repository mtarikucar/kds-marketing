import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('renders as a switch with role="switch"', () => {
    render(<Switch aria-label="Enable notifications" />);
    expect(screen.getByRole('switch', { name: 'Enable notifications' })).toBeInTheDocument();
  });

  it('starts unchecked (aria-checked=false)', () => {
    render(<Switch aria-label="Enable notifications" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles aria-checked on click', async () => {
    render(<Switch aria-label="Enable notifications" />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('is disabled when disabled prop is set', () => {
    render(<Switch aria-label="Enable notifications" disabled />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
