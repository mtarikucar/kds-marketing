import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NetgsmOnboardingCard } from './NetgsmOnboardingCard';

// Interpolation-aware t mock: string 2nd arg = fallback; object 2nd arg =
// {defaultValue, ...vars} (the progress/missingCount/repsCount calls).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg?: unknown) => {
      if (typeof arg === 'string') return arg;
      if (arg && typeof arg === 'object') {
        const o = arg as Record<string, unknown>;
        let s = String(o.defaultValue ?? key);
        for (const [k, v] of Object.entries(o)) {
          if (k !== 'defaultValue') s = s.replace(`{{${k}}}`, String(v));
        }
        return s;
      }
      return key;
    },
  }),
}));

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a) },
}));

type Item = { key: string; state: 'ok' | 'missing' | 'unknown'; detail?: string; url?: string };

/** Mid-setup fixture: SMS foundation done, İYS is the first incomplete group
 *  (brandCode + webhook missing), santral done, IVR env missing. Checkable
 *  (ok|missing) rows: 10 → 7 ok / 3 missing. */
const ITEMS: Item[] = [
  { key: 'smsChannel', state: 'ok' },
  { key: 'smsCredsLive', state: 'ok', detail: 'viaSantralCreds' },
  { key: 'senderHeaders', state: 'ok', detail: '3' },
  { key: 'moUrl', state: 'ok', url: 'https://app.example.com/api/public/channels/netgsm/ch1/tok/mo' },
  { key: 'otpPackage', state: 'unknown', detail: 'otpPackageHint' },
  { key: 'iysBrandCode', state: 'missing' },
  { key: 'iysWebhook', state: 'missing', url: 'https://app.example.com/api/public/netgsm/ws/tok/iys' },
  { key: 'iysFirstSync', state: 'unknown' },
  { key: 'telephonyConfig', state: 'ok' },
  { key: 'santralCredsLive', state: 'ok', detail: 'viaSantralCreds' },
  { key: 'repsWithDahili', state: 'ok', detail: '2' },
  { key: 'eventsWebhookUrl', state: 'unknown', url: 'https://app.example.com/api/public/netgsm/ws/tok/events' },
  { key: 'eventsWebhookReceiving', state: 'unknown', detail: 'eventsWebhookReceivingHint' },
  { key: 'recordingStorage', state: 'unknown', detail: 'recordingStorageKvkkHint' },
  { key: 'recordingsReceiving', state: 'unknown', detail: 'recordingsReceivingHint' },
  { key: 'voicePackage', state: 'unknown', detail: 'voicePackageHint' },
  { key: 'ivrWebhook', state: 'missing', detail: 'ivrTokenMissing' },
  { key: 'voiceReportWebhook', state: 'unknown', url: 'https://app.example.com/api/public/netgsm/ws/tok/voice-report' },
  { key: 'autocallQueue', state: 'unknown', detail: 'autocallQueueHint' },
  { key: 'faxNumber', state: 'unknown', detail: 'faxNumberHint' },
  { key: 'whatsappOtpPackage', state: 'unknown', detail: 'whatsappOtpPackageHint' },
  { key: 'netasistanKeys', state: 'unknown', detail: 'netasistanKeysHint' },
];

function renderCard(items: Item[] = ITEMS) {
  get.mockResolvedValue({ data: { items } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NetgsmOnboardingCard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('NetgsmOnboardingCard — guided setup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows overall progress over CURRENTLY-checkable (ok|missing) steps only — always-unknown rows stay out of the denominator', async () => {
    renderCard();
    expect(await screen.findByText('7/10 verifiable steps done')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });

  it('auto-expands the FIRST group carrying a missing step (İYS) and keeps complete/later groups collapsed', async () => {
    renderCard();
    // İYS group open: its missing step + fail-closed callout are visible.
    expect(await screen.findByText('İYS marka kodu (brand code) configured')).toBeInTheDocument();
    expect(screen.getByText(/Commercial \(TİCARİ\) SMS and voice sends are blocked/)).toBeInTheDocument();
    // SMS group (complete) collapsed: its steps are not in the DOM.
    expect(screen.queryByText('SMS channel connected')).not.toBeInTheDocument();
    // Voice group (also has a missing step, but is NOT first) collapsed.
    expect(screen.queryByText('Dynamic IVR webhook URL')).not.toBeInTheDocument();
  });

  it("renders a fix CTA on a missing step, deep-linking to the surface that fixes it (İYS brandCode → channel settings)", async () => {
    renderCard();
    const cta = await screen.findAllByRole('link', { name: /open channel settings/i });
    expect(cta.length).toBeGreaterThan(0);
    expect(cta[0]).toHaveAttribute('href', '/inbox?tab=channels');
  });

  it('shows the missing-count badge on the incomplete group header', async () => {
    renderCard();
    expect(await screen.findByText('2 to fix')).toBeInTheDocument(); // iysBrandCode + iysWebhook
  });

  it('toggling a collapsed group open reveals its steps — ivrWebhook surfaces the platform env-gap hint (no copy field while missing)', async () => {
    renderCard();
    await screen.findByText('İYS marka kodu (brand code) configured');
    await userEvent.click(screen.getByRole('button', { name: /voice campaigns & ivr/i }));
    expect(screen.getByText('Dynamic IVR webhook URL')).toBeInTheDocument();
    expect(screen.getByText(/NETGSM_IVR_TOKEN is unset/)).toBeInTheDocument();
    // Paid add-on badge on voicePackage.
    expect(screen.getAllByText('Paid NetGSM add-on').length).toBeGreaterThan(0);
  });

  it('collapsing the auto-expanded group hides its steps again (user toggle overrides the computed default)', async () => {
    renderCard();
    await screen.findByText('İYS marka kodu (brand code) configured');
    await userEvent.click(screen.getByRole('button', { name: /İYS compliance/i }));
    expect(screen.queryByText('İYS marka kodu (brand code) configured')).not.toBeInTheDocument();
  });

  it('reaches 100% (success tone) when every checkable step is ok and shows no fail-closed callout', async () => {
    const allOk: Item[] = ITEMS.map((i) =>
      i.state === 'missing' ? { ...i, state: 'ok' as const, detail: undefined } : i,
    );
    renderCard(allOk);
    expect(await screen.findByText('10/10 verifiable steps done')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.queryByText(/Commercial \(TİCARİ\) SMS and voice sends are blocked/)).not.toBeInTheDocument();
  });

  it('never silently drops an unrecognized backend row — it lands in the trailing catch-all group', async () => {
    renderCard([...ITEMS, { key: 'brandNewCheck', state: 'missing' }]);
    await screen.findByText('İYS marka kodu (brand code) configured');
    await userEvent.click(screen.getByRole('button', { name: /other/i }));
    expect(screen.getByText('brandNewCheck')).toBeInTheDocument();
  });
});
