import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DocumentsPage from './DocumentsPage';

const get = vi.fn();
const del = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
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
    post.mockReset();
    del.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: { status: 'SENT', publicToken: 'esign_tok', sent: true, to: 'jane@example.com', via: 'platform', signUrl: 'https://x/d/esign_tok' } });
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

  // `esign-not-emailed`: the page's only send-ish control used to be copyLink(),
  // which mints a token and puts it on the REP'S clipboard — the customer was
  // never told. POST /documents/:id/email is the route that actually mails the
  // signing request, and until this test it had no caller anywhere in the repo.
  it('emails the agreement for signature instead of only copying the link', async () => {
    const user = userEvent.setup();
    const draft = { ...DOCS[0], id: 'd1', leadId: 'lead-1', status: 'DRAFT', signerName: null, signedAt: null };
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: [draft] }) : Promise.resolve({ data: {} }),
    );

    render(<DocumentsPage />, { wrapper });
    await screen.findByText('Service agreement');

    await user.click(screen.getByTitle('Email for signature'));
    expect(post).toHaveBeenCalledWith('/documents/d1/email');
  });

  // The backend 400s with "This agreement has no contact to email" when the
  // document has no lead, so don't offer an action that is already doomed.
  // Copy-the-link stays available: it is the manual fallback for exactly this.
  it('cannot email a document that has no contact, but can still copy its link', async () => {
    const orphan = { ...DOCS[0], id: 'd2', leadId: null, status: 'DRAFT', signerName: null, signedAt: null };
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: [orphan] }) : Promise.resolve({ data: {} }),
    );

    render(<DocumentsPage />, { wrapper });
    await screen.findByText('Service agreement');

    // Disabled, and the tooltip says WHY rather than leaving a dead control.
    expect(screen.queryByTitle('Email for signature')).not.toBeInTheDocument();
    expect(screen.getByTitle('Link this document to a contact to email it')).toBeDisabled();
    expect(screen.getByTitle('Copy signing link')).not.toBeDisabled();
  });

  // The manual path must keep working untouched: it is what a rep falls back to
  // when delivery fails, and the document stays SENT with a live link.
  it('still mints and copies the signing link from the copy action', async () => {
    // userEvent.setup() installs its own navigator.clipboard stub.
    const user = userEvent.setup();
    const sent ={ ...DOCS[0], id: 'd3', leadId: 'lead-1', status: 'SENT', signerName: null, signedAt: null };
    get.mockImplementation((url: string) =>
      url === '/documents' ? Promise.resolve({ data: [sent] }) : Promise.resolve({ data: {} }),
    );

    render(<DocumentsPage />, { wrapper });
    await screen.findByText('Service agreement');

    await user.click(screen.getByTitle('Copy signing link'));
    expect(post).toHaveBeenCalledWith('/documents/d3/send');
  });
});
