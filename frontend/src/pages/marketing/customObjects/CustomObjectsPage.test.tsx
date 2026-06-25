import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CustomObjectsPage from './CustomObjectsPage';
import { listObjects, restoreObject } from '../../../features/marketing/api/custom-objects.service';

const OBJECTS = [
  {
    id: 'o1',
    workspaceId: 'ws-1',
    key: 'property',
    labelSingular: 'Property',
    labelPlural: 'Properties',
    primaryField: 'name',
    description: 'Listed properties',
    icon: null,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

vi.mock('../../../features/marketing/api/custom-objects.service', () => ({
  listObjects: vi.fn(() => Promise.resolve(OBJECTS)),
  createObject: vi.fn(() => Promise.resolve(OBJECTS[0])),
  archiveObject: vi.fn(() => Promise.resolve(OBJECTS[0])),
  restoreObject: vi.fn(() => Promise.resolve(OBJECTS[0])),
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { role: 'MANAGER' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CustomObjectsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<CustomObjectsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('lists the workspace custom objects once loaded', async () => {
    render(<CustomObjectsPage />, { wrapper });
    expect(await screen.findByText('Properties')).toBeInTheDocument();
  });

  it('shows the manager-only New object action', () => {
    render(<CustomObjectsPage />, { wrapper });
    expect(screen.getByRole('button', { name: /new object/i })).toBeInTheDocument();
  });

  it('toggles archived visibility and restores an archived object', async () => {
    // Show-archived fetches archived objects; restore re-activates one.
    const archived = { ...OBJECTS[0], archived: true };
    vi.mocked(listObjects).mockResolvedValue([archived]);
    const user = userEvent.setup();
    render(<CustomObjectsPage />, { wrapper });

    await user.click(screen.getByRole('button', { name: /show archived/i }));
    // listObjects requested WITH includeArchived once toggled on.
    expect(vi.mocked(listObjects)).toHaveBeenCalledWith(true);

    const restoreBtn = await screen.findByRole('button', { name: /restore/i });
    await user.click(restoreBtn);
    expect(vi.mocked(restoreObject)).toHaveBeenCalledWith('property');
  });
});
