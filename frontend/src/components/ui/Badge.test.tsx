import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders its text content', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies neutral tone by default', () => {
    const { container } = render(<Badge>Neutral</Badge>);
    expect(container.firstChild).toHaveClass('bg-surface-muted', 'text-muted-foreground');
  });

  it('applies success tone classes', () => {
    const { container } = render(<Badge tone="success">OK</Badge>);
    expect(container.firstChild).toHaveClass('bg-success-subtle', 'text-success');
  });

  it('applies warning tone classes', () => {
    const { container } = render(<Badge tone="warning">Warn</Badge>);
    expect(container.firstChild).toHaveClass('bg-warning-subtle', 'text-warning');
  });

  it('applies danger tone classes', () => {
    const { container } = render(<Badge tone="danger">Error</Badge>);
    expect(container.firstChild).toHaveClass('bg-danger-subtle', 'text-danger');
  });

  it('applies info tone classes', () => {
    const { container } = render(<Badge tone="info">Info</Badge>);
    expect(container.firstChild).toHaveClass('bg-info-subtle', 'text-info');
  });

  it('applies sm size classes', () => {
    const { container } = render(<Badge size="sm">Small</Badge>);
    expect(container.firstChild).toHaveClass('px-2', 'py-0.5');
  });
});
