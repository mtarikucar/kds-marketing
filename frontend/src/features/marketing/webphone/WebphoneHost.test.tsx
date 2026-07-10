import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WebphoneHost, { expectRingback, setActiveCallId } from './WebphoneHost';
import type { WebphoneState } from './webphone.store';

// ── Mocks ────────────────────────────────────────────────────────────────

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    info: (...a: unknown[]) => toastInfo(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

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

const apiPost = vi.fn().mockResolvedValue({ data: { ok: true } });
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
    post: (...a: unknown[]) => apiPost(...a),
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
const expectRingbackFn = vi.fn();
const hold = vi.fn().mockResolvedValue(undefined);
const unhold = vi.fn().mockResolvedValue(undefined);
const muteFn = vi.fn();
const unmuteFn = vi.fn();
const sendDtmf = vi.fn().mockResolvedValue(undefined);
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
    expectRingback: expectRingbackFn,
    hold,
    unhold,
    mute: muteFn,
    unmute: unmuteFn,
    sendDtmf,
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

  // ── Module-level `activeWebphone` singleton (Finding H1) ──────────────────
  it('sets the activeWebphone singleton on mount (forwarding expectRingback) and clears it on unmount', async () => {
    const { unmount } = renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    expectRingback('5551234567');
    expect(expectRingbackFn).toHaveBeenCalledWith('5551234567');

    unmount();
    expectRingbackFn.mockClear();
    expectRingback('5551234567'); // no WebphoneHost mounted now — must no-op, not throw
    expect(expectRingbackFn).not.toHaveBeenCalled();
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

const callStatusFrame = (payload: Record<string, unknown>) =>
  `data: ${JSON.stringify({ kind: 'call_status', payload })}\n\n`;

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

  // ── Number-matched merge + single-use ref (Finding M3) ────────────────────

  it('does NOT merge a stale/foreign screen-pop into an unrelated ringing call (number mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      sseFetchMock([
        screenPopFrame({
          customerNum: '5559998877', // a pop meant for a DIFFERENT call (e.g. broadcast to another rep)
          lead: { id: 'lead-1', businessName: 'Acme A.Ş.' },
          salesCallId: 'sc-1',
          internalNum: '101',
        }),
      ]),
    );
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    // This rep's own, unrelated genuine call rings for a DIFFERENT number.
    emit({ status: 'ringing', incoming: { number: '5551112233' } });

    expect(await screen.findByText(/incoming call/i)).toBeInTheDocument();
    expect(screen.getByText('5551112233')).toBeInTheDocument();
    expect(screen.queryByText('Acme A.Ş.')).not.toBeInTheDocument(); // foreign lead card never attaches
    expect(screen.getByText(/unknown caller/i)).toBeInTheDocument();
    expect(answerIncoming).not.toHaveBeenCalled();
  });

  it('clears pendingScreenPopRef once merged, so it cannot silently re-attach to a later ringing call', async () => {
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

    emit({ status: 'ringing', incoming: { number: '5559998877' } }); // matches — merges + consumes
    expect(await screen.findByText('Acme A.Ş.')).toBeInTheDocument();

    emit({ status: 'registered' }); // first call ends
    emit({ status: 'ringing', incoming: { number: '5559998877' } }); // a SECOND, unrelated call — coincidentally same number

    // The already-consumed screen-pop must not reattach to this new, later call.
    expect(await screen.findByText(/incoming call/i)).toBeInTheDocument();
    expect(screen.queryByText('Acme A.Ş.')).not.toBeInTheDocument();
  });
});

// ── In-call controls panel (Phase 3 Task 5) ────────────────────────────────

describe('WebphoneHost — in-call controls panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeState = { status: 'registered' };
    subscriber = null;
    apiPost.mockResolvedValue({ data: { ok: true } });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  });

  it('shows hold/mute/keypad once a SIP leg is incall, and reflects held/muted state', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => emit({ status: 'incall' }));

    expect(screen.getByRole('button', { name: /^hold$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^mute$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keypad/i })).toBeInTheDocument();
    // No known active call id yet — the transfer/server-hangup affordances don't apply.
    expect(screen.queryByRole('button', { name: /transfer/i })).not.toBeInTheDocument();

    act(() => emit({ status: 'incall', held: true, muted: true }));
    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^unmute$/i })).toBeInTheDocument();
  });

  it('clicking Hold/Mute delegates to the webphone store', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    act(() => emit({ status: 'incall' }));

    await userEvent.click(screen.getByRole('button', { name: /^hold$/i }));
    expect(hold).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /^mute$/i }));
    expect(muteFn).toHaveBeenCalledTimes(1);
  });

  it('the DTMF keypad sends a tone through the store', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    act(() => emit({ status: 'incall' }));

    await userEvent.click(screen.getByRole('button', { name: /keypad/i }));
    await userEvent.click(screen.getByRole('button', { name: '5' }));

    expect(sendDtmf).toHaveBeenCalledWith('5');
  });

  it('setActiveCallId shows transfer + server hangup even with no SIP leg (bridge-mode call)', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => setActiveCallId('call-99'));

    expect(screen.getByRole('button', { name: /transfer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /end call/i })).toBeInTheDocument();
    // No SIP leg exists for a bridge call — hold/mute/keypad don't apply.
    expect(screen.queryByRole('button', { name: /^hold$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^mute$/i })).not.toBeInTheDocument();
  });

  it('expectRingback(number, salesCallId) also arms the active-call panel', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => expectRingback('5551234567', 'call-42'));

    expect(expectRingbackFn).toHaveBeenCalledWith('5551234567');
    expect(screen.getByRole('button', { name: /transfer/i })).toBeInTheDocument();
  });

  it('clicking the bridge-mode "End call" button posts to the server hangup endpoint and clears the panel', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    act(() => setActiveCallId('call-5'));

    await userEvent.click(screen.getByRole('button', { name: /end call/i }));

    expect(apiPost).toHaveBeenCalledWith('/telephony/calls/call-5/hangup');
    await waitFor(() => expect(screen.queryByRole('button', { name: /end call/i })).not.toBeInTheDocument());
  });

  it('a call armed alongside a SIP ring-back auto-clears once that SIP call hangs up', async () => {
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => expectRingback('5551234567', 'call-7')); // REST dial accepted — id known immediately
    act(() => emit({ status: 'incall' })); // ring-back auto-answered
    expect(screen.getByRole('button', { name: /transfer/i })).toBeInTheDocument();

    act(() => emit({ status: 'registered' })); // hangup
    expect(screen.queryByRole('button', { name: /transfer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^hold$/i })).not.toBeInTheDocument();
  });
});

// ── Live status pill driven by call_status SSE (Phase 3 Task 6) ───────────

describe('WebphoneHost — live status pill (call_status SSE)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeState = { status: 'registered' };
    subscriber = null;
  });

  it('shows a "Calling…" pill once the active call id is known but no call_status has arrived yet — the exact bridge-mode gap this fixes (no SIP leg ever moves the OLD pill)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => setActiveCallId('call-1'));

    expect(await screen.findByText(/calling/i)).toBeInTheDocument();
  });

  it('shows "Connected" once a call_status CONNECTED frame arrives for the active call', async () => {
    vi.stubGlobal('fetch', sseFetchMock([callStatusFrame({ salesCallId: 'call-1', status: 'CONNECTED' })]));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => setActiveCallId('call-1'));

    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('shows the terminal label once a call_status NO_ANSWER frame arrives', async () => {
    vi.stubGlobal('fetch', sseFetchMock([callStatusFrame({ salesCallId: 'call-1', status: 'NO_ANSWER' })]));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => setActiveCallId('call-1'));

    expect(await screen.findByText(/no answer/i)).toBeInTheDocument();
  });

  it('ignores a call_status for a DIFFERENT salesCallId — the pill still shows "Calling…" for the actually-active call', async () => {
    vi.stubGlobal('fetch', sseFetchMock([callStatusFrame({ salesCallId: 'call-OTHER', status: 'CONNECTED' })]));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    act(() => setActiveCallId('call-1'));

    expect(await screen.findByText(/calling/i)).toBeInTheDocument();
    expect(screen.queryByText(/^connected$/i)).not.toBeInTheDocument();
  });

  it('clears the pill once the active call ends (activeCallId -> null)', async () => {
    vi.stubGlobal('fetch', sseFetchMock([callStatusFrame({ salesCallId: 'call-1', status: 'CONNECTED' })]));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());
    act(() => setActiveCallId('call-1'));
    expect(await screen.findByText(/connected/i)).toBeInTheDocument();

    act(() => setActiveCallId(null));

    await waitFor(() => expect(screen.queryByText(/connected/i)).not.toBeInTheDocument());
  });

  it('renders no pill at all when there is no active call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
    renderHost();
    await waitFor(() => expect(start).toHaveBeenCalled());

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
