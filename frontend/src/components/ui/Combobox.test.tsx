import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Combobox } from './Combobox';

const OPTIONS = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

describe('Combobox', () => {
  it('renders the trigger with placeholder when no value selected', () => {
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        placeholder="Pick a fruit"
        aria-label="Fruit"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toBeInTheDocument();
    expect(screen.getByText('Pick a fruit')).toBeInTheDocument();
  });

  it('shows the selected label in the trigger', () => {
    render(
      <Combobox
        options={OPTIONS}
        value="banana"
        onChange={vi.fn()}
        aria-label="Fruit"
      />,
    );
    expect(screen.getByText('Banana')).toBeInTheDocument();
  });

  it('opens the listbox on click', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        aria-label="Fruit"
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('filters options when typing in the search input', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        aria-label="Fruit"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    const searchInput = screen.getByPlaceholderText('Search…');
    await user.type(searchInput, 'an');

    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0]).toHaveTextContent('Banana');
  });

  it('calls onChange and closes the popover when an option is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={onChange}
        aria-label="Fruit"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    const cherryOption = within(screen.getByRole('listbox')).getByRole('option', {
      name: 'Cherry',
    });
    await user.click(cherryOption);

    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('navigates options with arrow keys and selects with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={onChange}
        aria-label="Fruit"
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);

    // Focus the search input and use arrow-down to navigate
    const searchInput = screen.getByPlaceholderText('Search…');
    await user.type(searchInput, '{ArrowDown}');
    await user.type(searchInput, '{ArrowDown}');
    await user.type(searchInput, '{Enter}');

    // Second item (index 1) is Banana
    expect(onChange).toHaveBeenCalledWith('banana');
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        aria-label="Fruit"
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
