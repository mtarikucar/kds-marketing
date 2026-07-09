import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WebphoneHost from './WebphoneHost';
import type { WebphoneState } from './webphone.store';

// ── Mocks ────────────────────────────────────────────────────────────────

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

const toastInfo = vi.fn();
vi.mock('sonner', () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, vars?: Record<string, unknown>) => {
      if (!fallback) return _key;
      if (!vars) return fallback;
      return Object.entries(vars).reduce(
        (s, [k, v]) => s.replace(new RegExp(`{{${k}}}`, 'g'), String(v)),
        fallback,
      );
    },
  }),
}));

vi.mock('../hooks/useEntitlements', () => ({ useEntitlements: () => ({ has: () => true }) }));
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ accessToken: 'test-token' }),
}));

vi.mock('../api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({
      data: {
        wssUrl: 'wss://sip5.netsantral.com:8089/ws',
        sipDomain: 'sip5.netsantral.com',
        dahili: '101',
        sipPassword: 'pw',
      },
    }),
  },
}));

// Controllable fake webphone store — subscribe() captures the callback so
// tests can drive `status`/`incoming` transitions exactly like the real
// SIP.js delegate would (see webphone.store.test.ts for the SIP-layer half).
let subscriber: ((s: WebphoneState) => void) | null = null;
const answerIncoming = vi.fn().mockResolvedValue(undefined);
const rejectIncoming = vi.fn().mockResolvedValue(undefined);
const hangup = vi.fn().mockResolvedValue(undefined);
const start = vi.fn().mockResolvedValue(undefined);
const stop = vi.fn().mockResolvedValue(undefined);
let fakeState: WebphoneState = { status: 'registered' };

vi.mock('./webphone.store', () => ({
  createWebphone: () => ({
    getState: () => fakeState,
    subscribe: (cb: (s: WebphoneState) => void) => {
      subscriber = cb;
      return () => { subscriber = null; };
    },
    start,
    stop,
    hangup,
    answerIncoming,
    rejectIncoming,
    call: vi.fn(),
  }),
}));

vi.mock('./CopilotPanel', () => ({ default: () => null }));

const emit = (s: WebphoneState) => {
  fakeState = s;
  act(() => subscriber?.(s));
};

function renderHost() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WebphoneHost />
    </QueryClientProvider>,
  );
}

describe('WebphoneHost — screen-pop ringing dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeState = { status: 'registered' };
    subscriber = null;
    // Keep the SSE effect inert for these tests (same idiom InboxPage's own
    // test suite uses for its fetch-based stream) — the ringing dialog/accept/
    // reject/navigate wiring is driven directly through the mocked store above.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  });

  it('renders nothing extra while registered (no ringing dialog)', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(screen.queryByText(/incoming call/i)).not.toBeInTheDocument();
  });

  it('shows the ringing dialog with just the number when the SIP INVITE has no matched lead', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    emit({ status: 'ringing', incoming: { number: '5551234567' } });

    expect(await screen.findByText(/incoming call/i)).toBeInTheDocument();
    expect(screen.getByText('5551234567')).toBeInTheDocument();
    expect(screen.getByText(/unknown caller/i)).toBeInTheDocument();
  });

  it('Accept answers the call and navigates to the matched lead', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    emit({ status: 'ringing', incoming: { number: '5551234567' } });
    await screen.findByText(/incoming call/i);

    await userEvent.click(screen.getByRole('button', { name: /accept/i }));

    expect(answerIncoming).toHaveBeenCalledTimes(1);
    // No screen-pop arrived in this test — nothing to navigate to.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('Reject declines the call and does not navigate', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    emit({ status: 'ringing', incoming: { number: '5551234567' } });
    await screen.findByText(/incoming call/i);

    await userEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(rejectIncoming).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the dialog once the call is no longer ringing (e.g. caller hung up)', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    emit({ status: 'ringing', incoming: { number: '5551234567' } });
    await screen.findByText(/incoming call/i);

    emit({ status: 'registered' });

    await waitFor(() => expect(screen.queryByText(/incoming call/i)).not.toBeInTheDocument());
  });
});

// ── Screen-pop SSE frame handling ──────────────────────────────────────────

/** A `fetch` mock whose body streams the given raw SSE frames once, then
 *  "hangs" (never resolves further reads) — enough for the component's
 *  fetch()+getReader() hand-rolled parser (mirrors InboxPage's) without
 *  pulling in a real ReadableStream/ReadableStreamDefaultReader. */
function sseFetchMock(frames: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return vi.fn().mockResolvedValue({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < frames.length) {
            const chunk = encoder.encode(frames[i]);
            i += 1;
            return { value: chunk, done: false };
          }
          return new Promise(() => {}); // stream stays open — no reconnect churn
        },
      }),
    },
  });
}

const screenPopFrame = (payload: Record<string, unknown>) =>
  `data: ${JSON.stringify({ kind: 'screen_pop', payload })}\n\n`;

describe('WebphoneHost — screen-pop SSE correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeState = { status: 'registered' };
    subscriber = null;
  });

  it('shows an informational toast (not a dialog) when a screen-pop arrives with no SIP leg ringing', async () => {
    vi.stubGlobal(
      'fetch',
      sseFetchMock([
        screenPopFrame({
          customerNum: '5559998877',
          lead: { id: 'lead-1', businessName: 'Acme A.Ş.' },
          salesCallId: 'sc-1',
          internalNum: '101',
        }),
      ]),
    );
    renderHost();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Incoming call: Acme A.Ş.'));
    // No SIP INVITE arrived — this webphone has nothing to answer for it.
    expect(screen.queryByText(/incoming call/i)).not.toBeInTheDocument();
    expect(answerIncoming).not.toHaveBeenCalled();
  });

  it('merges a screen-pop into an already-ringing SIP call (full lead card, Accept navigates)', async () => {
    vi.stubGlobal(
      'fetch',
      sseFetchMock([
        screenPopFrame({
          customerNum: '5559998877',
          lead: { id: 'lead-1', businessName: 'Acme A.Ş.' },
          salesCallId: 'sc-1',
          internalNum: '101',
        }),
      ]),
    );
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    emit({ status: 'ringing', incoming: { number: '5559998877' } });

    // Whichever channel wins the race (SIP INVITE vs. the screen-pop SSE —
    // order isn't guaranteed, see the `pendingScreenPopRef` merge fallback in
    // WebphoneHost), the ringing dialog ends up enriched with the lead card.
    expect(await screen.findByText('Acme A.Ş.')).toBeInTheDocument();
    expect(screen.getByText('5559998877')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(answerIncoming).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/leads/lead-1');
  });
});
