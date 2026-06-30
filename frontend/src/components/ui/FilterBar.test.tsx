import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { FilterBar } from './FilterBar';

describe('FilterBar', () => {
  it('renders the search input when search prop is provided', () => {
    render(
      <FilterBar
        search={{ value: '', onChange: vi.fn(), placeholder: 'Search leads' }}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Search leads' })).toBeInTheDocument();
  });

  it('debounces typing into a SINGLE onChange with the final value', async () => {
    // delay: null → keystrokes land synchronously (well within the debounce
    // window), so a correct debounce yields exactly one trailing call. Without
    // debouncing this fires three times ('f','fo','foo').
    const user = userEvent.setup({ delay: null });
    const handleChange = vi.fn();
    render(
      <FilterBar
        search={{ value: '', onChange: handleChange, placeholder: 'Search' }}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'foo');

    await waitFor(() => expect(handleChange).toHaveBeenCalledWith('foo'));
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it('mirrors an external value change into the input (reset / deep-link)', () => {
    const { rerender } = render(
      <FilterBar search={{ value: 'alpha', onChange: vi.fn() }} />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('alpha');
    rerender(<FilterBar search={{ value: '', onChange: vi.fn() }} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('does not echo an external value change back through onChange', async () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <FilterBar search={{ value: '', onChange: handleChange }} />,
    );
    rerender(<FilterBar search={{ value: 'seeded', onChange: handleChange }} />);
    // Give any stray debounce timer time to (not) fire.
    await new Promise((r) => setTimeout(r, 350));
    expect(handleChange).not.toHaveBeenCalled();
  });

  it('renders children alongside the search input', () => {
    render(
      <FilterBar search={{ value: '', onChange: vi.fn() }}>
        <button>Filter</button>
      </FilterBar>,
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });

  it('renders without search when search prop is omitted', () => {
    render(
      <FilterBar>
        <button>Status</button>
      </FilterBar>,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Status' })).toBeInTheDocument();
  });

  it('renders the right slot', () => {
    render(
      <FilterBar right={<button>Export</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});
