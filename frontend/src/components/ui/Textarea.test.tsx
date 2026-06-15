import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Textarea } from './Textarea';

describe('Textarea', () => {
  it('renders as a textarea', () => {
    render(<Textarea placeholder="Write something..." />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('typing updates the value', async () => {
    render(<Textarea defaultValue="" />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'hello world');
    expect(textarea).toHaveValue('hello world');
  });

  it('has min-height class', () => {
    render(<Textarea />);
    expect(screen.getByRole('textbox').className).toContain('min-h-[80px]');
  });
});
