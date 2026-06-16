import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ScrollArea } from './ScrollArea';

describe('ScrollArea', () => {
  it('renders children', () => {
    render(
      <ScrollArea>
        <p>Scrollable content</p>
      </ScrollArea>,
    );
    expect(screen.getByText('Scrollable content')).toBeInTheDocument();
  });

  it('renders without crashing when empty', () => {
    const { container } = render(<ScrollArea />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('applies custom className to the root', () => {
    const { container } = render(
      <ScrollArea className="h-64">
        <span>Content</span>
      </ScrollArea>,
    );
    // The root element should contain the custom class
    expect(container.firstChild).toHaveClass('h-64');
  });
});
