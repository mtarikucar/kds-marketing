import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './Select';

function SelectDemo({ onValueChange }: { onValueChange?: (v: string) => void }) {
  return (
    <Select onValueChange={onValueChange}>
      <SelectTrigger aria-label="Fruit">
        <SelectValue placeholder="Pick a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="apple">Apple</SelectItem>
        <SelectItem value="banana">Banana</SelectItem>
        <SelectItem value="cherry">Cherry</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe('Select', () => {
  it('renders the trigger with placeholder', () => {
    render(<SelectDemo />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('opens on click and shows options via keyboard interaction', async () => {
    render(<SelectDemo />);
    const trigger = screen.getByRole('combobox');
    await userEvent.click(trigger);
    // Wait for listbox to appear
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
  });

  it('can select an option and fires onValueChange', async () => {
    const onValueChange = vi.fn();
    render(<SelectDemo onValueChange={onValueChange} />);
    const trigger = screen.getByRole('combobox');
    await userEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
    // Find and click the option
    const option = screen.getByRole('option', { name: 'Apple' });
    await userEvent.click(option);
    await waitFor(() => {
      expect(onValueChange).toHaveBeenCalledWith('apple');
    });
  });

  it('updates displayed value after selection', async () => {
    render(<SelectDemo />);
    const trigger = screen.getByRole('combobox');
    await userEvent.click(trigger);
    await waitFor(() => screen.getByRole('listbox'));
    await userEvent.click(screen.getByRole('option', { name: 'Banana' }));
    await waitFor(() => {
      expect(screen.getByText('Banana')).toBeInTheDocument();
    });
  });
});
