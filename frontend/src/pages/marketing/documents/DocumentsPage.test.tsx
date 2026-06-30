import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DocumentsPage from './DocumentsPage';

const get = vi.fn();
const del = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: (...args: unknown[]) => del(...args),
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
    del.mockReset();
    del.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: DOCS }) : Promise.resolve({ data: {} }),
    );
  });

  it('lists documents with title and status', async () => {
    render(<DocumentsPage />, { wrapper });
    expect(await screen.findByText('Service agreement')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/documents');
  });

  // Deleting one document must not disable Delete on the others, and the acting
  // row's Delete locks while in flight so a double-click can't 404 on the second.
  it("deleting one document disables only that document's Delete button", async () => {
    const user = userEvent.setup();
    const draft = (id: string, title: string) => ({ ...DOCS[0], id, title, status: 'DRAFT', signerName: null, signedAt: null });
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: [draft('d1', 'Doc 1'), draft('d2', 'Doc 2')] }) : Promise.resolve({ data: {} }),
    );
    del.mockImplementation(() => new Promise(() => {})); // delete never resolves → stays pending

    render(<DocumentsPage />, { wrapper });
    await screen.findByText('Doc 1');

    const delBtns = screen.getAllByTitle('Delete');
    expect(delBtns).toHaveLength(2);
    await user.click(delBtns[0]);
    expect(del).toHaveBeenCalledWith('/documents/d1');

    const after = screen.getAllByTitle('Delete');
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
