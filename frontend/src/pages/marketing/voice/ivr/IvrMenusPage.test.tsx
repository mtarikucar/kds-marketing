import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import IvrMenusPage from './IvrMenusPage';

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  // Data is defined INSIDE the factory because `vi.mock` is hoisted above all
  // top-level declarations — referencing an outer `const` here is a TDZ error.
  default: {
    get: vi.fn().mockResolvedValue({
      data: [
        {
          id: 'menu-1',
          name: 'Main menu',
          greeting: 'Thanks for calling.',
          enabled: true,
          isRoot: true,
          options: [],
        },
      ],
    }),
    post: vi.fn().mockResolvedValue({ data: { id: 'menu-2' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('IvrMenusPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<IvrMenusPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the new-menu dialog and validates empty fields', async () => {
    render(<IvrMenusPage />, { wrapper });
    // Top-of-page "New menu" action.
    const newBtn = screen.getAllByRole('button', { name: /new menu/i })[0];
    await userEvent.click(newBtn);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toBeInTheDocument();

    // Submit with empty name + greeting → validation errors (role=alert) appear.
    const saveBtn = within(dialog).getByRole('button', { name: /new ivr menu|save/i });
    await userEvent.click(saveBtn);

    const alerts = await within(dialog).findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('renders the fetched menu in the list', async () => {
    render(<IvrMenusPage />, { wrapper });
    expect(await screen.findAllByText('Main menu')).not.toHaveLength(0);
  });
});
