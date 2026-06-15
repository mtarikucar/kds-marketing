import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Table, THead, TBody, TR, TH, TD } from './Table';

describe('Table primitives', () => {
  it('renders a basic table with header and cells', () => {
    render(
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH numeric>Amount</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>Alice</TD>
            <TD numeric>42</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '42' })).toBeInTheDocument();
  });

  it('applies tabular-nums + end alignment to numeric cells only', () => {
    render(
      <Table>
        <TBody>
          <TR>
            <TD>plain</TD>
            <TD numeric>numeric</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(screen.getByRole('cell', { name: 'numeric' })).toHaveClass('text-end', 'tabular-nums');
    expect(screen.getByRole('cell', { name: 'plain' })).not.toHaveClass('tabular-nums');
  });
});
