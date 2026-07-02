import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useCreateParam } from './useCreateParam';

function Probe({ open }: { open: () => void }) {
  useCreateParam(open);
  const loc = useLocation();
  return <div data-testid="search">{loc.search}</div>;
}

describe('useCreateParam', () => {
  it('fires open() once and strips ?create=1 while preserving other params', async () => {
    const open = vi.fn();
    render(
      <MemoryRouter initialEntries={['/companies?create=1&x=2']}>
        <Probe open={open} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).not.toMatch(/create/);
    expect(search).toMatch(/x=2/);
  });

  it('does not fire without the param', () => {
    const open = vi.fn();
    render(
      <MemoryRouter initialEntries={['/companies']}>
        <Probe open={open} />
      </MemoryRouter>,
    );
    expect(open).not.toHaveBeenCalled();
  });
});
