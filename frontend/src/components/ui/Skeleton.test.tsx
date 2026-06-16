import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('renders with animate-pulse class', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveClass('animate-pulse');
  });

  it('renders with bg-surface-muted class', () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveClass('bg-surface-muted');
  });

  it('renders with role="presentation"', () => {
    render(<Skeleton />);
    expect(screen.getByRole('presentation')).toBeInTheDocument();
  });

  it('merges custom className', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    expect(container.firstChild).toHaveClass('h-4', 'w-24');
  });
});
