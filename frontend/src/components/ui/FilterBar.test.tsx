import { render, screen } from '@testing-library/react';
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

  it('calls onChange when the search input changes', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <FilterBar
        search={{ value: '', onChange: handleChange, placeholder: 'Search' }}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'foo');
    expect(handleChange).toHaveBeenCalled();
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
