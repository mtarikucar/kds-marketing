import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CrewsTab } from './CrewsTab';

const patch = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: () => Promise.resolve({ data: [] }),
    post: () => Promise.resolve({ data: {} }),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const crew = { id: 'c1', name: 'Alpha', dailyCapacity: 3, active: true, notes: 'old notes' };

describe('CrewsTab — clearing notes on edit', () => {
  beforeEach(() => {
    patch.mockReset();
    patch.mockResolvedValue({ data: {} });
  });

  it('sends notes:"" when the notes field is cleared (a PATCH must blank it, not keep it)', async () => {
    const user = userEvent.setup();
    render(<CrewsTab isManager crews={[crew] as any} onInvalidate={vi.fn()} />, { wrapper });

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const notesField = await screen.findByDisplayValue('old notes');
    await user.clear(notesField);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/installations/crews/c1',
        expect.objectContaining({ notes: '' }),
      ),
    );
  });
});
