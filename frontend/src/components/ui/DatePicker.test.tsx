import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { DatePicker } from './DatePicker';

describe('DatePicker', () => {
  it('renders trigger with placeholder when no value', () => {
    render(<DatePicker value={null} onChange={vi.fn()} placeholder="Pick a date" />);
    expect(screen.getByText('Pick a date')).toBeInTheDocument();
  });

  it('renders trigger with formatted date when value is set', () => {
    render(<DatePicker value={new Date(2024, 0, 15)} onChange={vi.fn()} />);
    // date-fns format 'PPP' renders e.g. "January 15th, 2024"
    expect(screen.getByText(/January/)).toBeInTheDocument();
  });

  it('opens the calendar popover on click', async () => {
    const user = userEvent.setup();
    render(<DatePicker value={null} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Date' }));
    // react-day-picker renders a grid with role="grid"
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('calls onChange with a Date and closes when a day is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // Use a fixed month so we can reliably find day buttons.
    // react-day-picker v10 renders each day as a <button> whose aria-label is the
    // full formatted date (e.g. "Monday, January 15th, 2024"). We find the button
    // whose text content is "15" inside the grid.
    render(
      <DatePicker
        value={new Date(2024, 0, 1)}
        onChange={onChange}
        aria-label="Choose date"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose date' }));

    // Find the day button by its text content (the day number displayed in the cell)
    const grid = screen.getByRole('grid');
    const dayButtons = grid.querySelectorAll('button');
    const day15 = Array.from(dayButtons).find((btn) => btn.textContent?.trim() === '15');
    expect(day15).toBeTruthy();
    await user.click(day15!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const calledWith = onChange.mock.calls[0][0];
    expect(calledWith).toBeInstanceOf(Date);
    expect(calledWith.getDate()).toBe(15);
    // Popover should close after selection
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('uses aria-label on the trigger button', () => {
    render(
      <DatePicker value={null} onChange={vi.fn()} aria-label="Departure date" />,
    );
    expect(screen.getByRole('button', { name: 'Departure date' })).toBeInTheDocument();
  });
});
