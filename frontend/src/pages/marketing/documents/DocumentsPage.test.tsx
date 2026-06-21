import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DocumentsPage from './DocumentsPage';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const DOCS = [
  {
    id: 'd1',
    leadId: null,
    type: 'AGREEMENT',
    title: 'Service agreement',
    status: 'SIGNED',
    signerName: 'Jane Doe',
    signedAt: '2026-06-21T00:00:00Z',
    sentAt: '2026-06-20T00:00:00Z',
    createdAt: '2026-06-19T00:00:00Z',
  },
];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('DocumentsPage', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: DOCS }) : Promise.resolve({ data: {} }),
    );
  });

  it('lists documents with title and status', async () => {
    render(<DocumentsPage />, { wrapper });
    expect(await screen.findByText('Service agreement')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/documents');
  });
});
