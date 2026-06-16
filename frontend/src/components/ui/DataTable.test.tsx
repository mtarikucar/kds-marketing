import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { DataTable } from './DataTable';

interface Person {
  id: number;
  name: string;
  age: number;
}

const DATA: Person[] = [
  { id: 1, name: 'Charlie', age: 30 },
  { id: 2, name: 'Alice', age: 25 },
  { id: 3, name: 'Bob', age: 40 },
];

// Stable, module-level column defs (not recreated per render).
const COLUMNS: ColumnDef<Person, unknown>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'age', header: 'Age', enableSorting: false },
];

describe('DataTable', () => {
  it('renders a body row per data item', () => {
    render(<DataTable columns={COLUMNS} data={DATA} />);
    expect(screen.getByRole('cell', { name: 'Charlie' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Bob' })).toBeInTheDocument();
  });

  it('toggles aria-sort none -> ascending -> descending on header click (uncontrolled)', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLUMNS} data={DATA} />);

    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    const sortButton = within(nameHeader).getByRole('button');
    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  });

  it('calls onSortingChange when controlled', async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();

    function Controlled() {
      const [sorting, setSorting] = useState<SortingState>([]);
      return (
        <DataTable
          columns={COLUMNS}
          data={DATA}
          sorting={sorting}
          onSortingChange={(s) => {
            onSortingChange(s);
            setSorting(s);
          }}
        />
      );
    }

    render(<Controlled />);
    const nameHeader = screen.getByRole('columnheader', { name: /name/i });
    await user.click(within(nameHeader).getByRole('button'));

    expect(onSortingChange).toHaveBeenCalledTimes(1);
    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'name', desc: false }]);
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('does not make non-sortable headers a button', () => {
    render(<DataTable columns={COLUMNS} data={DATA} />);
    const ageHeader = screen.getByRole('columnheader', { name: 'Age' });
    expect(within(ageHeader).queryByRole('button')).toBeNull();
  });

  it('shows the default empty state when data is empty', () => {
    render(<DataTable columns={COLUMNS} data={[]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows a custom empty state when provided', () => {
    render(<DataTable columns={COLUMNS} data={[]} emptyState={<div>Nothing here</div>} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows skeleton rows when loading and no empty state', () => {
    const { container } = render(
      <DataTable columns={COLUMNS} data={[]} isLoading loadingRowCount={5} />,
    );
    // 5 skeleton rows in tbody.
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(5);
    expect(screen.queryByText('No data')).toBeNull();
  });

  it('fires onRowClick when a clickable row is activated', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable columns={COLUMNS} data={DATA} onRowClick={onRowClick} />);

    const firstDataRow = screen.getByRole('button', { name: /Charlie/i });
    await user.click(firstDataRow);
    expect(onRowClick).toHaveBeenCalledWith(DATA[0]);
  });
});
