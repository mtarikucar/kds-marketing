import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import PersonasPage from './PersonasPage';
import * as svc from '../../../features/marketing/api/personas.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string } | string) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)) }),
}));
vi.mock('../../../features/marketing/api/personas.service', () => ({
  listPersonas: vi.fn(), createPersona: vi.fn(), planShots: vi.fn(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><PersonasPage /></MemoryRouter></QueryClientProvider>);
}

describe('PersonasPage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('shows the empty state with no personas', async () => {
    (svc.listPersonas as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No personas yet')).toBeInTheDocument();
  });
  it('lists personas with their reference count', async () => {
    (svc.listPersonas as any).mockResolvedValue([{ id: 'p1', name: 'Dr. Aylin', description: null, referenceImageUrls: ['a', 'b'], lockedSeed: 42, voiceId: null, status: 'ACTIVE', createdAt: '' }]);
    renderPage();
    expect(await screen.findByText('Dr. Aylin')).toBeInTheDocument();
  });
});
