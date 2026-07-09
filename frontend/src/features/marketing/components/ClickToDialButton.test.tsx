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
  return render(
    <QueryClientProvider client={qc}>
      <ClickToDialButton {...props} />
    </QueryClientProvider>,
  );
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

    await userEvent.click(screen.getByRole('button', { name: /call/i }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // Phase 3 Task 5: also hands the SalesCall id to WebphoneHost's in-call
    // controls panel (works for bridge-mode calls too, which never touch the
    // SIP ring-back path at all).
    await waitFor(() => expect(expectRingbackMock).toHaveBeenCalledWith('+905551112233', 'call-1'));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/extension will ring/i));
    // api-dial mode never hands back a dialUri to navigate to.
    expect(window.location.href).toBe('');
  });

  it('does NOT arm the ring-back window on click-to-dial mode (netgsm-lite hands off a tel: URI instead)', async () => {
    postMock.mockResolvedValue({ data: { call: call(), dialUri: 'tel:+905551112233', mode: 'click-to-dial' } });
    renderButton({ defaultPhone: '+905551112233' });

    await userEvent.click(screen.getByRole('button', { name: /call/i }));

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

    await userEvent.click(screen.getByRole('button', { name: /call/i }));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: /save outcome/i }));

    await waitFor(() => expect(setActiveCallIdMock).toHaveBeenCalledWith(null));
  });
});
