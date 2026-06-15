import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('renders as a text input', () => {
    render(<Input placeholder="Type here" />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('typing updates the value', async () => {
    render(<Input defaultValue="" />);
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'hello');
    expect(input).toHaveValue('hello');
  });

  it('aria-invalid=true adds danger border class', () => {
    render(<Input aria-invalid="true" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The class is applied via CSS attribute selector aria-[invalid=true]
    expect(input.className).toContain('aria-[invalid=true]:border-danger');
  });

  it('is disabled when disabled prop is set', () => {
    render(<Input disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
