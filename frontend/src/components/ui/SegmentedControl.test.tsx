import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { SegmentedControl } from './SegmentedControl';

const options = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

function Controlled() {
  const [value, setValue] = useState('day');
  return (
    <SegmentedControl
      options={options}
      value={value}
      onChange={setValue}
      aria-label="Time range"
    />
  );
}

describe('SegmentedControl', () => {
  it('renders a group with aria-label', () => {
    render(<Controlled />);
    expect(screen.getByRole('group', { name: 'Time range' })).toBeInTheDocument();
  });

  it('renders all options as buttons', () => {
    render(<Controlled />);
    expect(screen.getByRole('button', { name: 'Day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
  });

  it('marks the selected option as aria-pressed=true', () => {
    render(<Controlled />);
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('changes selection when a different option is clicked', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onChange with the clicked option value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={options}
        value="day"
        onChange={onChange}
        aria-label="Time range"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Month' }));
    expect(onChange).toHaveBeenCalledWith('month');
  });

  it('does not call onChange when clicking the already-selected option... but still calls', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={options}
        value="week"
        onChange={onChange}
        aria-label="Time range"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Week' }));
    expect(onChange).toHaveBeenCalledWith('week');
  });

  it('merges custom className onto group container', () => {
    const { container } = render(
      <SegmentedControl
        options={options}
        value="day"
        onChange={vi.fn()}
        aria-label="Test"
        className="custom-segment"
      />,
    );
    expect(container.firstChild).toHaveClass('custom-segment');
  });

  it('applies selected styles to the active option', () => {
    render(
      <SegmentedControl
        options={options}
        value="week"
        onChange={vi.fn()}
        aria-label="Test"
      />,
    );
    const weekBtn = screen.getByRole('button', { name: 'Week' });
    expect(weekBtn).toHaveClass('bg-surface', 'text-foreground', 'shadow-sm');
  });
});
