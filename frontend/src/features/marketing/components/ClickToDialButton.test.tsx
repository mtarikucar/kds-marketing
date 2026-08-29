import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ClickToDialButton from './ClickToDialButton';

const postMock = vi.fn();
vi.mock('../api/marketingApi', () => ({
  default: { post: (...args: unknown[]) => postMock(...args) },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

// `t` resolves against the REAL Turkish catalogue rather than echoing the
// inline default. That is the point: these tests then find the button by the
// word a Turkish rep actually sees ("Ara"), so a key that is missing,
// misspelled or never wired up fails HERE rather than degrading silently to
// English at runtime — which is exactly how these labels shipped hardcoded in
// the first place.
vi.mock('react-i18next', async () => {
  const tr = (await import('../../../i18n/locales/tr/marketing.json')).default as Record<string, unknown>;
  const lookup = (key: string) =>
    key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tr);
  return {
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string } | string) => {
        const hit = lookup(key);
        if (typeof hit === 'string') return hit;
        return (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key;
      },
      i18n: { language: 'tr' },
    }),
  };
});

// Finding H1: the singleton ClickToDialButton reaches to arm the ring-back
// window on the real, app-wide WebphoneHost instance. Mocked here so we can
// assert it's called (api-dial mode) or not (click-to-dial mode) without
// standing up a real SIP.js webphone.
const expectRingbackMock = vi.fn();
const setActiveCallIdMock = vi.fn();
vi.mock('../webphone/WebphoneHost', () => ({
  expectRingback: (...a: unknown[]) => expectRingbackMock(...a),
  setActiveCallId: (...a: unknown[]) => setActiveCallIdMock(...a),
}));

function renderButton(props: { leadId?: string; defaultPhone?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  return {
    invalidate,
    ...render(
      <QueryClientProvider client={qc}>
        <ClickToDialButton {...props} />
      </QueryClientProvider>,
    ),
  };
}

const call = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'call-1',
  marketingUserId: 'u-1',
  direction: 'OUTBOUND',
  toPhone: '+905551112233',
  providerId: 'netgsm-netsantral',
  status: 'IN_PROGRESS',
  startedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('ClickToDialButton — ring-back arming (Finding H1/M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    });
  });

  it('arms the ring-back window with the dialed number on api-dial mode success', async () => {
    postMock.mockResolvedValue({ data: { call: call(), dialUri: '', mode: 'api' } });
    renderButton({ defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // Phase 3 Task 5: also hands the SalesCall id to WebphoneHost's in-call
    // controls panel (works for bridge-mode calls too, which never touch the
    // SIP ring-back path at all).
    await waitFor(() => expect(expectRingbackMock).toHaveBeenCalledWith('+905551112233', 'call-1'));
    // Still the honest copy — the extension WILL ring, it is not ringing yet —
    // now read out of the Turkish catalogue rather than an English literal.
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/dahilin çalacak/i));
    // api-dial mode never hands back a dialUri to navigate to.
    expect(window.location.href).toBe('');
  });

  it('does NOT arm the ring-back window on click-to-dial mode (netgsm-lite hands off a tel: URI instead)', async () => {
    postMock.mockResolvedValue({ data: { call: call(), dialUri: 'tel:+905551112233', mode: 'click-to-dial' } });
    renderButton({ defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe('tel:+905551112233'));
    expect(expectRingbackMock).not.toHaveBeenCalled();
  });
});

describe('ClickToDialButton — clears the in-call controls panel once logged (Phase 3 Task 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls setActiveCallId(null) after the call outcome is logged', async () => {
    postMock.mockResolvedValueOnce({ data: { call: call(), dialUri: '', mode: 'api' } });
    postMock.mockResolvedValueOnce({ data: {} }); // the /log response
    renderButton({ defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Sonucu kaydet' }));

    await waitFor(() => expect(setActiveCallIdMock).toHaveBeenCalledWith(null));
  });
});

/**
 * This button was written for the calls page, where the only list that could
 * go stale was the call log. Dropped onto the lead header it acquires a second
 * consumer: SalesCallService.logCall mirrors the outcome onto the lead as a
 * CALL LeadActivity, and the lead detail page reads its activities off the
 * LEAD payload (ActivityTimelineTab takes them as a prop — it has no query of
 * its own). So without invalidating the lead, the rep logs a call, watches
 * Hareketler, and sees nothing until they reload the page by hand.
 */
describe('ClickToDialButton — a logged call refreshes the lead it was placed from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
  });

  it('invalidates the lead detail query (where Hareketler gets its activities) after logging', async () => {
    postMock.mockResolvedValueOnce({ data: { call: call(), dialUri: '', mode: 'api' } });
    postMock.mockResolvedValueOnce({ data: {} });
    const { invalidate } = renderButton({ leadId: 'lead-9', defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    // The dial itself carries the lead — that link is what makes the backend
    // write the mirrored activity at all.
    expect(postMock).toHaveBeenCalledWith('/calls/start', {
      toPhone: '+905551112233',
      leadId: 'lead-9',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Sonucu kaydet' }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'lead', 'lead-9'] }),
    );
  });

  it('does not invalidate any lead when dialled from the calls page (no leadId)', async () => {
    postMock.mockResolvedValueOnce({ data: { call: call(), dialUri: '', mode: 'api' } });
    postMock.mockResolvedValueOnce({ data: {} });
    const { invalidate } = renderButton({ defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: 'Ara' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Sonucu kaydet' }));

    // Positive anchor: the call-log invalidation DID happen, so the mutation
    // settled — only then is "no lead was invalidated" a real observation
    // rather than a snapshot of a mutation that had not run yet.
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['marketing', 'calls'] }),
    );
    expect(
      invalidate.mock.calls.filter((c) => (c[0]?.queryKey as unknown[])?.[1] === 'lead'),
    ).toEqual([]);
  });
});
