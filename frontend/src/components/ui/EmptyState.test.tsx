import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="No results" />);
    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="Nothing here" description="Try adding something." />);
    expect(screen.getByText('Try adding something.')).toBeInTheDocument();
  });

  it('does not render description when not provided', () => {
    const { container } = render(<EmptyState title="Empty" />);
    // Should only have one p (the title)
    const paras = container.querySelectorAll('p');
    expect(paras).toHaveLength(1);
  });

  it('renders action slot', () => {
    render(
      <EmptyState
        title="No items"
        action={<button>Create item</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create item' })).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(
      <EmptyState
        title="No data"
        icon={<span data-testid="empty-icon">📭</span>}
      />,
    );
    expect(screen.getByTestId('empty-icon')).toBeInTheDocument();
  });

  it('does not render icon slot when icon is absent', () => {
    const { container } = render(<EmptyState title="Empty" />);
    // No icon span wrapper
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(0);
  });

  it('has dashed border classes', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.firstChild).toHaveClass('border-dashed', 'border-border');
  });

  it('merges custom className', () => {
    const { container } = render(<EmptyState title="X" className="custom-empty" />);
    expect(container.firstChild).toHaveClass('custom-empty');
  });
});
