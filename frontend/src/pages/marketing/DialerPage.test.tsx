import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DialerPage from './DialerPage';

const postMock = vi.fn();
const getMock = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    post: (...args: unknown[]) => postMock(...args),
    get: (...args: unknown[]) => getMock(...args),
  },
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

// Parallel mode is gated on the voiceCampaigns entitlement (backend route is
// @RequiresFeature('voiceCampaigns')); grant it so the section renders in tests.
const hasMock = vi.fn((_k: string) => true);
vi.mock('../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: hasMock }),
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
    getMock.mockResolvedValue({ data: null }); // no active parallel session by default
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

const parallelSession = {
  id: 'auto-1',
  status: 'ACTIVE',
  queueName: 'sales-queue',
  netgsmListId: 'job-1',
  total: 10,
  pending: 6,
  added: 3,
  skipped: 1,
  failed: 0,
};

describe('DialerPage — parallel mode (NetGSM Phase 5 Task 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockResolvedValue({ data: {} });
    getMock.mockResolvedValue({ data: null }); // no active session on load
  });

  it('shows the paid-add-on + queue-with-agents prerequisite note', async () => {
    renderPage();
    expect(await screen.findByText(/Otomatik Arama.*add-on/i)).toBeTruthy();
    expect(screen.getByText(/queue with logged-in agents/i)).toBeTruthy();
  });

  it('the toggle is disabled until a queue name is entered', async () => {
    renderPage();
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/dialer/parallel/active'));
    const toggle = screen.getByRole('switch', { name: /parallel mode/i });
    expect(toggle).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/sales-queue/i), 'sales-queue');
    expect(toggle).not.toBeDisabled();
  });

  it('turning the toggle ON starts a session with the entered queue name + message type', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/dialer/parallel/start') return Promise.resolve({ data: parallelSession });
      return Promise.resolve({ data: {} });
    });
    renderPage();
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/dialer/parallel/active'));

    await userEvent.type(screen.getByPlaceholderText(/sales-queue/i), 'sales-queue');
    await userEvent.click(screen.getByRole('switch', { name: /parallel mode/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/dialer/parallel/start', {
        status: undefined,
        search: undefined,
        queueName: 'sales-queue',
        iysMessageType: 'TICARI',
      }),
    );
  });

  it('shows progress once a session is active and turning the toggle OFF stops it', async () => {
    getMock.mockResolvedValue({ data: parallelSession });
    postMock.mockImplementation((url: string) => {
      if (url === '/dialer/parallel/stop') return Promise.resolve({ data: { id: parallelSession.id, status: 'STOPPED' } });
      return Promise.resolve({ data: {} });
    });
    renderPage();

    await screen.findByText('sales-queue');
    // The i18n mock returns the raw '{{n}} added'-style template unsubstituted
    // (it doesn't interpolate, unlike real i18next), so assert on the
    // computed, untranslated progress value instead: (added+skipped+failed)/total.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');

    const toggle = screen.getByRole('switch', { name: /parallel mode/i });
    expect(toggle).not.toBeDisabled();
    await userEvent.click(toggle);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/dialer/parallel/stop', { sessionId: 'auto-1' }));
  });
});
