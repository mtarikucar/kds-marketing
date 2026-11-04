import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import tr from '@/i18n/tr.json';
import '@/i18n/config';
import { ApiError } from '@/api/client';
import { Spinner } from '@/components/ui';
import { QueryState } from './QueryState';

const failed = (code: string) => ({
  isLoading: false,
  isError: true,
  error: new ApiError(code, 'gate', {}, 409),
  refetch: () => undefined,
});

describe('QueryState', () => {
  it('turns a strategy gate into a next step, never a red error with a pointless retry', () => {
    render(<MemoryRouter><QueryState query={failed('STRATEGY_REQUIRED')} /></MemoryRouter>);
    expect(screen.getByText(tr.gates.strategyBody)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: tr.gates.strategyLink })).toHaveAttribute('href', '/strategy');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tr.common.retry })).not.toBeInTheDocument();
  });

  it('sends an inactive workspace to billing', () => {
    render(<MemoryRouter><QueryState query={failed('WORKSPACE_INACTIVE')} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: tr.gates.inactiveLink })).toHaveAttribute('href', '/billing');
  });

  it('keeps the error and retry for a real failure', () => {
    render(<MemoryRouter><QueryState query={failed('INTERNAL')} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tr.common.retry })).toBeInTheDocument();
  });
});

describe('Spinner', () => {
  it('has its own size, so it never stretches across a loading card', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toHaveClass('h-5', 'w-5');
  });
});
