import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import VoicePage from './VoicePage';
import marketingApi from '../../features/marketing/api/marketingApi';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
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

describe('VoicePage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<VoicePage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the select-a-call prompt when no call is selected', () => {
    render(<VoicePage />, { wrapper });
    expect(screen.getByText(/select a call|voice\.selectPrompt/i)).toBeInTheDocument();
  });

  it('shows a "Lead" link for a personalized IVR call (leadId stamped) and none for an unmatched one', async () => {
    (marketingApi.get as any).mockResolvedValue({
      data: [
        { id: 'call-1', fromNumber: '05551112233', toNumber: '08508407303', status: 'COMPLETED', turns: 2, createdAt: new Date().toISOString(), leadId: 'lead-1' },
        { id: 'call-2', fromNumber: '05559998877', toNumber: '08508407303', status: 'COMPLETED', turns: 1, createdAt: new Date().toISOString(), leadId: null },
      ],
    });
    render(<VoicePage />, { wrapper });
    const link = await screen.findByRole('link', { name: /lead/i });
    expect(link).toHaveAttribute('href', '/leads/lead-1');
    // exactly one match — the second (unmatched) call has no Lead link
    expect(screen.getAllByRole('link', { name: /lead/i })).toHaveLength(1);
  });
});
