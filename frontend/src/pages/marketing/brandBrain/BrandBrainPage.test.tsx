import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import BrandBrainPage from './BrandBrainPage';
import * as svc from '../../../features/marketing/api/brandBrain.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string } | string) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)) }) }));
vi.mock('../../../features/marketing/api/brandBrain.service', () => ({ searchBrandBrain: vi.fn(), reindexBrandBrain: vi.fn() }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><BrandBrainPage /></MemoryRouter></QueryClientProvider>);
}

describe('BrandBrainPage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('shows the start prompt before searching', () => {
    renderPage();
    expect(screen.getByText('Ask your Brand Brain')).toBeInTheDocument();
  });
  it('renders cited results after a search', async () => {
    (svc.searchBrandBrain as any).mockResolvedValue([{ chunkId: 'c1', docId: 'd1', docTitle: 'Pricing FAQ', snippet: 'Implants start at…', score: 0.82 }]);
    renderPage();
    fireEvent.change(screen.getByLabelText('Brand Brain'), { target: { value: 'implant price' } });
    fireEvent.click(screen.getByText('Search'));
    expect(await screen.findByText('Pricing FAQ')).toBeInTheDocument();
    expect(screen.getByText('Implants start at…')).toBeInTheDocument();
  });
});
