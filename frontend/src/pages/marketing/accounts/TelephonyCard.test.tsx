import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelephonyCard } from './TelephonyCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

const CFG = {
  status: 'ACTIVE',
  trunk: '8508407303',
  pbxnum: null,
  wssUrl: null,
  sipDomain: null,
  configuredSecrets: ['username', 'password'],
};

const OK_BALANCE = { ok: true, credsValid: true, code: null, credit: '10', packages: [], message: null };

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TelephonyCard />
    </QueryClientProvider>,
  );
}

/** Opens the manage dialog and clicks "Verify credentials", stubbing the
 *  /telephony/verify response to the given shape. */
async function openAndVerify(verifyResponse: unknown) {
  post.mockResolvedValue({ data: verifyResponse });
  renderCard();
  await userEvent.click(await screen.findByRole('button', { name: /manage|set up/i }));
  await userEvent.click(await screen.findByRole('button', { name: /verify credentials/i }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/telephony/verify', {}));
}

/**
 * Phase-0 deferral fix (NetGSM Phase 3 Task 6): `testFetch` (backend
 * CallCdrSyncService.testFetch -> NetgsmCdrClient.fetchRaw) returns
 * `{httpStatus, body}` even when NetGSM rejected the CDR call for an
 * auth/IP-allowlist reason — it responds HTTP 200 with an error envelope
 * `{code, error}` in the body. The note must show whenever the body carries a
 * NetGSM error `code`, or the httpStatus itself isn't 2xx — not only on an
 * outright transport failure ({error}/{skipped}).
 */
describe('TelephonyCard — CDR-prod-only note', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockImplementation((url: string) => {
      if (url === '/telephony/config') return Promise.resolve({ data: CFG });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });
  });

  it('shows the note when the CDR leg auth-failed off-prod: HTTP 200 + a NetGSM error `code` in the body (the exact bug this fixes)', async () => {
    await openAndVerify({
      configured: true,
      balance: OK_BALANCE,
      cdr: { httpStatus: 200, body: { code: '30', error: 'Yetkisiz erişim' } },
    });

    expect(await screen.findByText(/production server IP/i)).toBeInTheDocument();
  });

  it('hides the note when the CDR leg genuinely confirmed (2xx, no error code in the body)', async () => {
    await openAndVerify({
      configured: true,
      balance: OK_BALANCE,
      cdr: { httpStatus: 200, body: [{ uniqueid: 'u1' }] },
    });

    await screen.findByText(/verified with NetGSM/i);
    expect(screen.queryByText(/production server IP/i)).not.toBeInTheDocument();
  });

  it('still shows the note on an outright transport-level failure ({error}) — unchanged prior behavior', async () => {
    await openAndVerify({
      configured: true,
      balance: OK_BALANCE,
      cdr: { error: 'fetch failed' },
    });

    expect(await screen.findByText(/production server IP/i)).toBeInTheDocument();
  });

  it('shows the note on a non-2xx httpStatus even without an explicit error code', async () => {
    await openAndVerify({
      configured: true,
      balance: OK_BALANCE,
      cdr: { httpStatus: 500, body: null },
    });

    expect(await screen.findByText(/production server IP/i)).toBeInTheDocument();
  });
});
