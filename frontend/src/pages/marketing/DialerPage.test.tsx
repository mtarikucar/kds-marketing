import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DialerPage from './DialerPage';

const postMock = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { post: (...args: unknown[]) => postMock(...args) },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) =>
      opts && typeof opts === 'object' && 'defaultValue' in (opts as Record<string, unknown>)
        ? (opts as { defaultValue: string }).defaultValue
        : key,
  }),
}));

// Finding H1: DialerPage's dial (api-dial mode) never touches the webphone
// store directly — it reaches the app-wide WebphoneHost singleton to arm the
// ring-back window. Mocked so we can assert the arming call without a real
// SIP.js webphone.
const expectRingbackMock = vi.fn();
const setActiveCallIdMock = vi.fn();
vi.mock('../../features/marketing/webphone/WebphoneHost', () => ({
  expectRingback: (...a: unknown[]) => expectRingbackMock(...a),
  setActiveCallId: (...a: unknown[]) => setActiveCallIdMock(...a),
}));

const session = {
  id: 'sess-1',
  status: 'ACTIVE',
  currentIndex: 0,
  total: 2,
  done: 0,
  current: {
    itemId: 'item-1',
    // A fresh queue item has no call linked yet — the backend only sets
    // DialSessionItem.callId once dial() completes (see dialer.service.ts).
    // Regression guard for the HIGH finding: the frontend must NOT read this
    // stale/null field for the in-call controls id — it must come from the
    // dial response instead (see the test below).
    callId: null as string | null,
    lead: {
      id: 'lead-1',
      businessName: 'Acme A.Ş.',
      contactPerson: 'Ayşe',
      phone: '+905551112233',
      status: 'NEW',
      city: 'İstanbul',
    },
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DialerPage />
    </QueryClientProvider>,
  );
}

async function startQueue() {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: /start dialing/i }));
  await screen.findByRole('button', { name: /^dial$/i });
}

describe('DialerPage — ring-back arming (Finding H1/M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    });
    postMock.mockImplementation((url: string) => {
      if (url === '/dialer/sessions') return Promise.resolve({ data: session });
      return Promise.resolve({ data: {} });
    });
  });

  it('arms the ring-back window with the FRESH SalesCall id from the dial response (not the stale pre-dial session state)', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/dialer/sessions') return Promise.resolve({ data: session });
      if (url === `/dialer/sessions/${session.id}/dial`)
        return Promise.resolve({ data: { dialUri: '', mode: 'api', call: { id: 'call-fresh' } } });
      return Promise.resolve({ data: {} });
    });
    await startQueue();

    await userEvent.click(screen.getByRole('button', { name: /^dial$/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(`/dialer/sessions/${session.id}/dial`));
    // Phase 3 Task 5 (HIGH finding fix): the id handed to WebphoneHost's
    // in-call controls panel must be `call-fresh` — the id THIS dial's
    // response just created — never `session.current.callId`, which is
    // null for a fresh queue item (works for bridge-mode calls too, which
    // never touch the SIP ring-back path at all).
    await waitFor(() => expect(expectRingbackMock).toHaveBeenCalledWith('+905551112233', 'call-fresh'));
    expect(window.location.href).toBe('');
  });

  it('does NOT arm the ring-back window on click-to-dial mode (netgsm-lite hands off a tel: URI instead)', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/dialer/sessions') return Promise.resolve({ data: session });
      if (url === `/dialer/sessions/${session.id}/dial`)
        return Promise.resolve({ data: { dialUri: 'tel:+905551112233', mode: 'click-to-dial' } });
      return Promise.resolve({ data: {} });
    });
    await startQueue();

    await userEvent.click(screen.getByRole('button', { name: /^dial$/i }));

    await waitFor(() => expect(window.location.href).toBe('tel:+905551112233'));
    expect(expectRingbackMock).not.toHaveBeenCalled();
  });
});
