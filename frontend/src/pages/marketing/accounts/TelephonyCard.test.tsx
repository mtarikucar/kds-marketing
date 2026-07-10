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
const put = vi.fn().mockResolvedValue({ data: {} });
const patch = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
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

/**
 * NetGSM Phase 4 Task 1 — call-recording toggle + retention field. The KVKK
 * legal note must always be visible next to the toggle (recording is OFF by
 * default; a caller announcement is a legal requirement, so admins must see
 * the note before they ever turn it on, not only after).
 */
describe('TelephonyCard — call recording (NetGSM Phase 4 Task 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue({ data: {} });
    get.mockImplementation((url: string) => {
      if (url === '/telephony/config') return Promise.resolve({ data: CFG });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });
  });

  async function openDialog() {
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /manage|set up/i }));
  }

  it('shows the KVKK announcement note regardless of the toggle state', async () => {
    await openDialog();
    expect(await screen.findByText(/anons yapılması yasal zorunluluktur|Recording requires a caller announcement/i)).toBeInTheDocument();
  });

  it('defaults the toggle off and an empty retention field when unset', async () => {
    await openDialog();
    const toggle = await screen.findByRole('switch', { name: /record calls/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('reflects a saved recordCalls:true + retention days from the config', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/telephony/config') return Promise.resolve({ data: { ...CFG, recordCalls: true, recordingRetentionDays: 30 } });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: null });
    });
    await openDialog();
    const toggle = await screen.findByRole('switch', { name: /record calls/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  it('saves recordCalls:true + the retention days typed in when the toggle is switched on', async () => {
    await openDialog();
    const toggle = await screen.findByRole('switch', { name: /record calls/i });
    await userEvent.click(toggle);
    const retentionInput = screen.getByPlaceholderText(/retention|saklama/i);
    await userEvent.type(retentionInput, '45');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/telephony/config',
      expect.objectContaining({ recordCalls: true, recordingRetentionDays: 45 }),
    ));
  });

  it('saves recordingRetentionDays:null ("keep forever") when the retention field is left blank', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/telephony/config',
      expect.objectContaining({ recordCalls: false, recordingRetentionDays: null }),
    ));
  });
});

/**
 * NetGSM Phase 6 Task 4 — Netasistan agent self-service (break/queue)
 * presence sync: a workspace app-key/user-key input (sealed, "leave blank to
 * keep" like the santral creds) + a per-rep opt-in toggle that only appears
 * once the workspace has Netasistan configured.
 */
describe('TelephonyCard — Netasistan (NetGSM Phase 6 Task 4)', () => {
  const REP = { id: 'rep-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', dahili: '104', netasistanOptIn: false };

  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue({ data: {} });
  });

  async function openDialog(cfgOverrides: Partial<typeof CFG & { netasistanConfigured: boolean }> = {}, reps: unknown[] = []) {
    get.mockImplementation((url: string) => {
      if (url === '/telephony/config') return Promise.resolve({ data: { ...CFG, ...cfgOverrides } });
      if (url === '/users') return Promise.resolve({ data: reps });
      return Promise.resolve({ data: null });
    });
    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: /manage|set up/i }));
  }

  it('sends the appKey/userKey under a `netasistan` field when either is filled in', async () => {
    await openDialog();
    await userEvent.type(screen.getByPlaceholderText(/netasistan app-key/i), 'my-app-key');
    await userEvent.type(screen.getByPlaceholderText(/netasistan user-key/i), 'my-user-key');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/telephony/config',
      expect.objectContaining({ netasistan: { appKey: 'my-app-key', userKey: 'my-user-key' } }),
    ));
  });

  it('omits the `netasistan` field entirely when both key inputs are left blank', async () => {
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][1];
    expect(body.netasistan).toBeUndefined();
  });

  it('shows a "saved — leave blank to keep" placeholder once the workspace has Netasistan configured', async () => {
    await openDialog({ netasistanConfigured: true });
    expect(screen.getByPlaceholderText(/netasistan app-key \(saved/i)).toBeInTheDocument();
  });

  it('hides the per-rep opt-in toggle when the workspace has no Netasistan keys configured', async () => {
    await openDialog({ netasistanConfigured: false }, [REP]);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /sync my presence to netasistan/i })).not.toBeInTheDocument();
  });

  it('shows the per-rep opt-in toggle once the workspace has Netasistan configured, defaulting to the saved value', async () => {
    await openDialog({ netasistanConfigured: true }, [REP]);
    const toggle = await screen.findByRole('switch', { name: /sync my presence to netasistan/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it("saves the rep's netasistanOptIn:true through the existing dahili PATCH endpoint", async () => {
    await openDialog({ netasistanConfigured: true }, [REP]);
    const toggle = await screen.findByRole('switch', { name: /sync my presence to netasistan/i });
    await userEvent.click(toggle);

    const repSaveButtons = screen.getAllByRole('button', { name: /^save$/i });
    // The last "Save" button belongs to the rep row (the dialog's own Save is first).
    await userEvent.click(repSaveButtons[repSaveButtons.length - 1]);

    await waitFor(() => expect(patch).toHaveBeenCalledWith(
      '/telephony/users/rep-1/dahili',
      expect.objectContaining({ netasistanOptIn: true }),
    ));
  });
});
