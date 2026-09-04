import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The landing chrome pulls in the whole marketing nav; this page's contract is
// the STATE it renders, so keep the test on that.
vi.mock('../landing/LandingNav', () => ({ default: () => <nav /> }));
vi.mock('../landing/LandingFooter', () => ({ default: () => <footer /> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
}));

vi.mock('../../features/marketing/api/dataDeletion.service', () => ({
  fetchDeletionStatus: vi.fn(),
}));

import DataDeletionStatusPage from './DataDeletionStatusPage';
import { fetchDeletionStatus } from '../../features/marketing/api/dataDeletion.service';

function renderPage(path = '/data-deletion-status?code=abc123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/data-deletion-status" element={<DataDeletionStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DataDeletionStatusPage — the page Meta sends the person to', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks the API for the code in the URL', async () => {
    (fetchDeletionStatus as any).mockResolvedValue({
      confirmationCode: 'abc123',
      status: 'COMPLETED',
      receivedAt: '2026-09-02T10:00:00.000Z',
      completedAt: '2026-09-02T10:00:01.000Z',
    });
    renderPage();
    await waitFor(() => expect(fetchDeletionStatus).toHaveBeenCalledWith('abc123'));
  });

  it('says the data WAS deleted for a COMPLETED request', async () => {
    (fetchDeletionStatus as any).mockResolvedValue({
      confirmationCode: 'abc123',
      status: 'COMPLETED',
      receivedAt: '2026-09-02T10:00:00.000Z',
      completedAt: '2026-09-02T10:00:01.000Z',
    });
    renderPage();
    // The HEADING is the load-bearing statement; the body elaborates it.
    expect(await screen.findByRole('heading', { name: /has been deleted/i })).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('says NO DATA WAS FOUND for an UNMATCHED request — never "deleted"', async () => {
    (fetchDeletionStatus as any).mockResolvedValue({
      confirmationCode: 'abc123',
      status: 'UNMATCHED',
      receivedAt: '2026-09-02T10:00:00.000Z',
      completedAt: '2026-09-02T10:00:01.000Z',
    });
    renderPage();
    const heading = await screen.findByRole('heading', { name: /no personal data/i });
    expect(heading).toBeInTheDocument();
    // The honesty this whole feature exists for: an unmatched request must not
    // read as a successful deletion.
    expect(heading.textContent).not.toMatch(/deleted/i);
    expect(screen.queryByRole('heading', { name: /has been deleted/i })).not.toBeInTheDocument();
  });

  it('says the request is still being processed for RECEIVED', async () => {
    (fetchDeletionStatus as any).mockResolvedValue({
      confirmationCode: 'abc123',
      status: 'RECEIVED',
      receivedAt: '2026-09-02T10:00:00.000Z',
      completedAt: null,
    });
    renderPage();
    expect(await screen.findByText(/being processed/i)).toBeInTheDocument();
  });

  it('says a FAILED request needs a human, and gives the contact address', async () => {
    (fetchDeletionStatus as any).mockResolvedValue({
      confirmationCode: 'abc123',
      status: 'FAILED',
      receivedAt: '2026-09-02T10:00:00.000Z',
      completedAt: null,
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /could not be completed/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /admin@jeetagrowth\.com/ })).toBeInTheDocument();
  });

  it('says "no record" for an unknown code instead of rendering a blank page', async () => {
    (fetchDeletionStatus as any).mockResolvedValue(null);
    renderPage('/data-deletion-status?code=nope');
    expect(await screen.findByRole('heading', { name: /no record/i })).toBeInTheDocument();
  });

  it('asks for a code when the URL carries none (and calls nothing)', async () => {
    renderPage('/data-deletion-status');
    expect(
      await screen.findByRole('heading', { name: /no confirmation code/i }),
    ).toBeInTheDocument();
    expect(fetchDeletionStatus).not.toHaveBeenCalled();
  });

  it('surfaces a lookup failure as a failure — not as "nothing found"', async () => {
    (fetchDeletionStatus as any).mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByRole('heading', { name: /could not be checked/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /no record/i })).not.toBeInTheDocument();
  });
});
