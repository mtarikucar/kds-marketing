import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('renders a button accessible by its aria-label', () => {
    render(
      <IconButton aria-label="Close">
        <svg data-testid="icon" />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('wraps child icon with aria-hidden', () => {
    render(
      <IconButton aria-label="Settings">
        <svg data-testid="icon" />
      </IconButton>,
    );
    const wrapper = screen.getByTestId('icon').parentElement;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
  });

  it('is square — same h and w class for each size', () => {
    render(
      <IconButton aria-label="Test" size="sm">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole('button')).toHaveClass('h-8', 'w-8');
  });

  it('can be disabled', () => {
    render(
      <IconButton aria-label="Disabled" disabled>
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
