import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Tag } from './Tag';

describe('Tag', () => {
  it('renders the label text', () => {
    render(<Tag label="React" />);
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('does not render a remove button when onRemove is absent', () => {
    render(<Tag label="React" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a remove button when onRemove is provided', () => {
    render(<Tag label="React" onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Remove React' })).toBeInTheDocument();
  });

  it('fires onRemove when the remove button is clicked', async () => {
    const onRemove = vi.fn();
    render(<Tag label="TypeScript" onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove TypeScript' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('applies tone classes', () => {
    const { container } = render(<Tag label="OK" tone="success" />);
    expect(container.firstChild).toHaveClass('bg-success-subtle', 'text-success');
  });
});
