import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Separator } from './Separator';

describe('Separator', () => {
  it('renders with role="none" when decorative (default)', () => {
    render(<Separator />);
    expect(screen.getByRole('none')).toBeInTheDocument();
  });

  it('renders with role="separator" when decorative={false}', () => {
    render(<Separator decorative={false} />);
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('defaults to horizontal orientation', () => {
    const { container } = render(<Separator />);
    expect(container.firstChild).toHaveClass('h-px', 'w-full');
  });

  it('renders vertical orientation classes', () => {
    const { container } = render(<Separator orientation="vertical" />);
    expect(container.firstChild).toHaveClass('h-full', 'w-px');
  });

  it('merges custom className', () => {
    const { container } = render(<Separator className="my-4" />);
    expect(container.firstChild).toHaveClass('my-4');
  });
});
