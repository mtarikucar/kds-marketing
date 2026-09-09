import type { ReactNode } from 'react';
import { render, renderHook, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgrammePanel, useTickingNow, NOW_TICK_MS, PROGRAMME_POLL_MS } from './ProgrammePanel';
import * as api from '../../../features/marketing/api/contentProgramme.service';
import * as social from '../../../features/marketing/api/socialPosts.service';
import type {
  ContentProgramme,
  Dashboard,
  SlotMetricsView,
  SlotView,
  TypeView,
} from '../../../features/marketing/api/contentProgramme.service';

// A factory rather than an automock: automocking empties arrays, and this
// module exports `PROGRAMME_GOALS` and the `['content-programme']` root key.
vi.mock('../../../features/marketing/api/contentProgramme.service', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    getProgramme: vi.fn(),
    createProgramme: vi.fn(),
    pauseProgramme: vi.fn(),
    resumeProgramme: vi.fn(),
    killProgramme: vi.fn(),
    updateSlot: vi.fn(),
    skipSlot: vi.fn(),
    regenerateSlot: vi.fn(),
    retrySlot: vi.fn(),
    slotMetrics: vi.fn(),
    updateType: vi.fn(),
    createType: vi.fn(),
  };
});
vi.mock('../../../features/marketing/api/socialPosts.service', () => ({
  listSocialAccounts: vi.fn(),
  socialQueryKeys: { accounts: ['marketing', 'social', 'accounts'] },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The panel gates on the role it already knows, exactly like AutopilotStatusBar.
const mockRole = vi.fn<() => string | undefined>(() => 'OWNER');
vi.mock('@/store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: mockRole() } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const getProgramme = vi.mocked(api.getProgramme);
const createProgramme = vi.mocked(api.createProgramme);
const pauseProgramme = vi.mocked(api.pauseProgramme);
const resumeProgramme = vi.mocked(api.resumeProgramme);
const killProgramme = vi.mocked(api.killProgramme);
const updateSlot = vi.mocked(api.updateSlot);
const skipSlot = vi.mocked(api.skipSlot);
const regenerateSlot = vi.mocked(api.regenerateSlot);
const retrySlot = vi.mocked(api.retrySlot);
const slotMetrics = vi.mocked(api.slotMetrics);
const listSocialAccounts = vi.mocked(social.listSocialAccounts);

const NOW = new Date('2026-09-08T10:00:00.000Z');
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

const programme = (over: Partial<ContentProgramme> = {}): ContentProgramme => ({
  id: 'p1',
  workspaceId: 'w1',
  name: 'Sonbahar programı',
  status: 'ACTIVE',
  socialCampaignId: 'sc1',
  goal: 'COMPOSITE',
  brief: 'Kinetik heykeller',
  personaId: null,
  perWeek: 5,
  weeklyCreditCap: 600,
  explorationRate: 0.15,
  maturityHours: 72,
  halfLifeDays: 30,
  editWindowHours: 2,
  lookaheadDays: 14,
  planLeadHours: 36,
  produceLeadHours: 12,
  seedWeeks: 2,
  phase: 'SEED',
  killSwitch: false,
  lastPlannedAt: hours(-1),
  lastMeasuredAt: null,
  lastReweightedAt: null,
  createdById: 'u1',
  createdAt: hours(-48),
  updatedAt: hours(-1),
  ...over,
});

const slot = (over: Partial<SlotView> = {}): SlotView => ({
  id: 's1',
  scheduledFor: hours(30),
  status: 'PLANNED',
  contentTypeKey: 'howto',
  contentTypeName: 'Nasıl yapılır',
  selectionReason: 'seed round-robin',
  trendTitle: null,
  idea: 'Rüzgar heykeli nasıl dengelenir',
  conceptId: null,
  campaignItemId: null,
  socialPostId: null,
  quotedCredits: null,
  spentCredits: 0,
  editableUntil: hours(28),
  editable: true,
  publishedAt: null,
  reward: null,
  error: null,
  concept: null,
  ...over,
});

const type = (over: Partial<TypeView> = {}): TypeView => ({
  id: 't1',
  key: 'howto',
  name: 'Nasıl yapılır',
  description: '',
  active: true,
  minShare: 0.05,
  maxShare: 0.4,
  defaultDurationSec: 15,
  networks: [],
  weight: 0,
  samples: 0,
  meanReward: null,
  plannedShare: 0.5,
  ...over,
});

const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  phase: 'SEED',
  status: 'ACTIVE',
  killSwitch: false,
  week: { weekStart: hours(-58), spent: 120, cap: 600 },
  slots: [
    slot(),
    slot({ id: 's2', scheduledFor: hours(54), editableUntil: hours(52), contentTypeKey: 'bts', contentTypeName: 'Kamera arkası', status: 'IDEATED' }),
    slot({ id: 's3', scheduledFor: hours(-20), editableUntil: hours(-22), editable: false, status: 'PUBLISHED', reward: 0.62, publishedAt: hours(-20), quotedCredits: 120, spentCredits: 40 }),
    // Beyond the strip's 14 days, inside the dashboard window.
    slot({ id: 's4', scheduledFor: hours(20 * 24), editableUntil: hours(20 * 24 - 2) }),
  ],
  types: [type(), type({ id: 't2', key: 'bts', name: 'Kamera arkası', plannedShare: 0.5 })],
  learning: { phase: 'SEED', lastReweightedAt: null, networks: [], rows: [], history: [] },
  trends: [
    { id: 'tr1', network: 'TIKTOK', kind: 'SOUND', title: 'Rüzgar sesi', ref: 'https://example.test/s', decayed: 0.8, relevance: 0.4, suggestion: 0.46, observedAt: hours(-3) },
  ],
  events: [{ id: 'e1', kind: 'slot.planned', message: 'Salı 18:00 için "Nasıl yapılır" planlandı.', data: null, createdAt: hours(-1) }],
  ...over,
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('OWNER');
  listSocialAccounts.mockResolvedValue([
    { id: 'a1', network: 'INSTAGRAM', externalId: 'x', displayName: '@heykel', accessToken: '••', tokenExpiresAt: null, enabled: true, createdAt: hours(-100) },
  ] as never);
  pauseProgramme.mockResolvedValue({ programme: programme({ status: 'PAUSED' }), dashboard: dashboard({ status: 'PAUSED' }) });
  resumeProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
  killProgramme.mockResolvedValue({ programme: null, dashboard: null });
  updateSlot.mockResolvedValue(slot());
  skipSlot.mockResolvedValue(slot({ status: 'SKIPPED' }));
  regenerateSlot.mockResolvedValue(slot({ status: 'PLANNED' }));
  retrySlot.mockResolvedValue(slot({ status: 'PLANNED' }));
});

/** An axios-shaped rejection, the way marketingApi hands a status to the panel. */
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } });

describe('ProgrammePanel — no programme', () => {
  it('offers to start one, and the dialog submits exactly what was typed', async () => {
    // Six typed fields: instant keystrokes and a wide budget, so the whole
    // suite running in parallel cannot turn this into a timeout.
    const user = userEvent.setup({ delay: null });
    getProgramme.mockResolvedValue({ programme: null, dashboard: null });
    createProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
    wrap(<ProgrammePanel now={NOW} />);

    await user.click(await screen.findByRole('button', { name: 'Programı başlat' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Ad'), 'Sonbahar');
    await user.type(within(dialog).getByLabelText('Konu / ürün / ton'), 'Kinetik heykeller, sakin ton');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'INSTAGRAM @heykel' }));
    const cap = within(dialog).getByLabelText('Haftalık kredi tavanı');
    await user.clear(cap);
    await user.type(cap, '400');
    const time = within(dialog).getByLabelText('Yayın saati (Türkiye saati, SS:DD)');
    await user.clear(time);
    await user.type(time, '09:30');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));

    await waitFor(() =>
      expect(createProgramme).toHaveBeenCalledWith({
        name: 'Sonbahar',
        brief: 'Kinetik heykeller, sakin ton',
        accountIds: ['a1'],
        perWeek: 5,
        goal: 'COMPOSITE',
        weeklyCreditCap: 400,
        timeOfDay: '09:30',
      }),
    );
  }, 20_000);

  it('refuses to submit without an account, naming the gap', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({ programme: null, dashboard: null });
    wrap(<ProgrammePanel now={NOW} />);

    await user.click(await screen.findByRole('button', { name: 'Programı başlat' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'X');
    await user.type(within(dialog).getByLabelText('Konu / ürün / ton'), 'Y');
    await user.click(within(dialog).getByRole('button', { name: 'Başlat' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('En az bir hesap seçin.');
    expect(createProgramme).not.toHaveBeenCalled();
  });
});

describe('ProgrammePanel — compact row', () => {
  beforeEach(() => {
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
  });

  it('shows status, phase, the week burn and one chip per slot in the next 14 days', async () => {
    wrap(<ProgrammePanel now={NOW} />);

    expect(await screen.findByTestId('programme-status')).toHaveTextContent('Çalışıyor');
    expect(screen.getByTestId('programme-phase')).toHaveTextContent('Tohum');
    expect(screen.getByTestId('programme-burn')).toHaveTextContent('120/600 kredi bu hafta');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20');

    // s1 and s2 are ahead within 14 days; s3 was yesterday and s4 is 20 days
    // out — both in the dashboard window, neither on the strip.
    const chips = screen.getAllByTestId('programme-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute('data-type', 'howto');
    expect(chips[1]).toHaveAttribute('data-status', 'IDEATED');
    // Nothing behind a tab until asked.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('reads a raised kill switch as stopped, whatever `status` says', async () => {
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard({ killSwitch: true }) });
    wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByTestId('programme-status')).toHaveTextContent('Durduruldu');
    expect(screen.getByTestId('programme-running')).toBeDisabled();
  });

  it('the running switch pauses an active programme and resumes a paused one', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    await user.click(await screen.findByTestId('programme-running'));
    await waitFor(() => expect(pauseProgramme).toHaveBeenCalledWith('p1'));
    expect(resumeProgramme).not.toHaveBeenCalled();
  });

  it('pausing shows PAUSED from the envelope before the refetch lands, and keeps the switch disabled until it does', async () => {
    const user = userEvent.setup();
    // The first read says ACTIVE; the refetch after the pause is SLOW — the
    // round-trip during which the old switch snapped back to "running".
    let releaseRefetch!: () => void;
    getProgramme
      .mockResolvedValueOnce({ programme: programme(), dashboard: dashboard() })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseRefetch = () => resolve({ programme: programme({ status: 'PAUSED' }), dashboard: dashboard({ status: 'PAUSED' }) });
          }),
      );
    let releasePause!: () => void;
    pauseProgramme.mockReturnValue(
      new Promise((resolve) => {
        releasePause = () => resolve({ programme: programme({ status: 'PAUSED' }), dashboard: dashboard({ status: 'PAUSED' }) });
      }),
    );
    wrap(<ProgrammePanel now={NOW} />);
    const sw = await screen.findByTestId('programme-running');
    await user.click(sw);
    await waitFor(() => expect(pauseProgramme).toHaveBeenCalledTimes(1));
    expect(sw).toBeDisabled();

    // The envelope lands: the row says PAUSED at once, from the cache …
    releasePause();
    expect(await screen.findByText('Duraklatıldı')).toBeInTheDocument();
    // … and the switch is STILL disabled, because the refetch has not returned.
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(pauseProgramme).toHaveBeenCalledTimes(1);
    expect(resumeProgramme).not.toHaveBeenCalled();

    releaseRefetch();
    await waitFor(() => expect(sw).toBeEnabled());
    expect(screen.getByTestId('programme-status')).toHaveTextContent('Duraklatıldı');
    expect(pauseProgramme).toHaveBeenCalledTimes(1);
  });

  it('resumes from PAUSED', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({ programme: programme({ status: 'PAUSED' }), dashboard: dashboard({ status: 'PAUSED' }) });
    wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByTestId('programme-status')).toHaveTextContent('Duraklatıldı');
    await user.click(screen.getByTestId('programme-running'));
    await waitFor(() => expect(resumeProgramme).toHaveBeenCalledWith('p1'));
  });

  it('kill needs a confirmation, and only then calls the API', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Durdur (kill)' }));
    expect(killProgramme).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Evet, durdur' }));
    await waitFor(() => expect(killProgramme).toHaveBeenCalledWith('p1'));
  });
});

describe('ProgrammePanel — slot editor', () => {
  beforeEach(() => {
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
  });

  it('a chip opens the editor prefilled, and Kaydet sends only what changed', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    const [chip] = await screen.findAllByTestId('programme-chip');
    await user.click(chip);

    const editor = await screen.findByTestId('programme-slot-editor');
    const idea = within(editor).getByLabelText('Fikir') as HTMLTextAreaElement;
    expect(idea.value).toBe('Rüzgar heykeli nasıl dengelenir');
    // `editableUntil` is 28 h out; the window prints what is left, rounded up.
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('28 saat kaldı');
    // Nothing to save until something changes.
    expect(within(editor).getByRole('button', { name: 'Kaydet' })).toBeDisabled();

    await user.clear(idea);
    await user.type(idea, 'Heykelin ağırlık merkezi');
    await user.click(within(editor).getByRole('button', { name: 'Kaydet' }));

    await waitFor(() => expect(updateSlot).toHaveBeenCalledWith('p1', 's1', { idea: 'Heykelin ağırlık merkezi' }));
  });

  it('Atla skips the slot and closes the editor', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    const [chip] = await screen.findAllByTestId('programme-chip');
    await user.click(chip);
    const editor = await screen.findByTestId('programme-slot-editor');
    await user.click(within(editor).getByRole('button', { name: 'Atla' }));
    await waitFor(() => expect(skipSlot).toHaveBeenCalledWith('p1', 's1'));
  });

  it('a frozen READY slot keeps its fields, disables the edit, and still offers skip and regenerate', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({
      programme: programme(),
      dashboard: dashboard({ slots: [slot({ editable: false, editableUntil: hours(-1), status: 'READY', campaignItemId: 'ci1' })] }),
    });
    wrap(<ProgrammePanel now={NOW} />);
    await user.click((await screen.findAllByTestId('programme-chip'))[0]);
    const editor = await screen.findByTestId('programme-slot-editor');
    // Still on its way out, so the "publishes as it stands" sentence is true here.
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('Düzenleme penceresi kapandı; slot olduğu gibi yayınlanır.');
    expect(within(editor).getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    expect(within(editor).getByLabelText('Fikir')).toBeDisabled();
    // The backend's own words for a frozen slot: "skip it if it must not go
    // out" — and regenerate accepts READY whatever the window says.
    expect(within(editor).getByRole('button', { name: 'Atla' })).toBeEnabled();
    expect(within(editor).getByRole('button', { name: 'Yeniden üret' })).toBeEnabled();
    expect(within(editor).queryByRole('button', { name: 'Tekrar dene' })).not.toBeInTheDocument();
  });

  it('the frozen sentence names what the slot IS: skipped, failed, or published with its reward', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({
      programme: programme(),
      dashboard: dashboard({
        slots: [
          slot({ id: 'sk', scheduledFor: hours(30), editable: false, status: 'SKIPPED' }),
          slot({ id: 'fa', scheduledFor: hours(31), editable: false, status: 'FAILED', error: 'produce: budget exhausted', quotedCredits: 120, spentCredits: 45 }),
          slot({ id: 'me', scheduledFor: hours(32), editable: false, status: 'MEASURED', reward: 0.62 }),
          slot({ id: 'pu', scheduledFor: hours(33), editable: false, status: 'PUBLISHED' }),
        ],
      }),
    });
    wrap(<ProgrammePanel now={NOW} />);
    const chips = await screen.findAllByTestId('programme-chip');

    await user.click(chips[0]);
    let editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('Atlandı; bir şey yayınlanmayacak.');
    expect(within(editor).getByTestId('programme-slot-window')).not.toHaveTextContent('olduğu gibi yayınlanır');

    await user.click(chips[1]);
    editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('Başarısız: produce: budget exhausted');
    // What it cost beside what it was quoted — kept on a FAILED slot.
    expect(within(editor).getByTestId('programme-slot-credits')).toHaveTextContent('Harcanan / teklif: 45 / 120');

    await user.click(chips[2]);
    editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('Yayınlandı · ödül 0.62');

    await user.click(chips[3]);
    editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByTestId('programme-slot-window')).toHaveTextContent('Yayınlandı.');
  });

  it('Yeniden üret follows the backend: off for PLANNED, on for FAILED with an item; Tekrar dene on every FAILED slot', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({
      programme: programme(),
      dashboard: dashboard({
        slots: [
          slot({ id: 'pl', scheduledFor: hours(30), status: 'PLANNED' }),
          slot({ id: 'fi', scheduledFor: hours(31), editable: false, status: 'FAILED', error: 'x', campaignItemId: 'ci1' }),
          slot({ id: 'fn', scheduledFor: hours(32), editable: false, status: 'FAILED', error: 'x', campaignItemId: null }),
        ],
      }),
    });
    wrap(<ProgrammePanel now={NOW} />);
    const chips = await screen.findAllByTestId('programme-chip');

    await user.click(chips[0]);
    let editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByRole('button', { name: 'Yeniden üret' })).toBeDisabled();
    expect(within(editor).getByRole('button', { name: 'Atla' })).toBeEnabled();
    expect(within(editor).queryByRole('button', { name: 'Tekrar dene' })).not.toBeInTheDocument();

    await user.click(chips[1]);
    editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByRole('button', { name: 'Yeniden üret' })).toBeEnabled();
    expect(within(editor).getByRole('button', { name: 'Atla' })).toBeEnabled();
    await user.click(within(editor).getByRole('button', { name: 'Tekrar dene' }));
    await waitFor(() => expect(retrySlot).toHaveBeenCalledWith('p1', 'fi'));
    expect(regenerateSlot).not.toHaveBeenCalled();

    await user.click(chips[2]);
    editor = await screen.findByTestId('programme-slot-editor');
    // Failed before it had an item: nothing to re-make, but the loop can retry.
    expect(within(editor).getByRole('button', { name: 'Yeniden üret' })).toBeDisabled();
    expect(within(editor).getByRole('button', { name: 'Tekrar dene' })).toBeEnabled();
  });

  it('a slot whose time carries seconds is not dirty, and an idea edit does not ship a time move', async () => {
    const user = userEvent.setup();
    getProgramme.mockResolvedValue({
      programme: programme(),
      dashboard: dashboard({ slots: [slot({ scheduledFor: '2026-09-09T15:30:15.000Z', editableUntil: hours(28) })] }),
    });
    wrap(<ProgrammePanel now={NOW} />);
    await user.click((await screen.findAllByTestId('programme-chip'))[0]);
    const editor = await screen.findByTestId('programme-slot-editor');
    expect(within(editor).getByRole('button', { name: 'Kaydet' })).toBeDisabled();

    const idea = within(editor).getByLabelText('Fikir');
    await user.clear(idea);
    await user.type(idea, 'Yeni fikir');
    await user.click(within(editor).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(updateSlot).toHaveBeenCalledWith('p1', 's1', { idea: 'Yeni fikir' }));
  });

  it('the editor and the tabs share one scroll box under the compact row, and only while something is open', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    await screen.findByTestId('programme-row');
    expect(screen.queryByTestId('programme-work')).not.toBeInTheDocument();

    await user.click(screen.getAllByTestId('programme-chip')[0]);
    const work = await screen.findByTestId('programme-work');
    expect(work.className).toMatch(/lg:max-h-\[48vh\]/);
    expect(work.className).toMatch(/lg:overflow-y-auto/);
    expect(work).toContainElement(screen.getByTestId('programme-slot-editor'));
    // The row with the kill switch and the strip is NOT inside the box.
    expect(work).not.toContainElement(screen.getByTestId('programme-row'));

    await user.click(screen.getByRole('button', { name: 'Ayrıntı' }));
    expect(work).toContainElement(screen.getByTestId('programme-detail'));
  });
});

describe('ProgrammePanel — detail', () => {
  beforeEach(() => {
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
    slotMetrics.mockResolvedValue({
      slot: { id: 's3' } as SlotMetricsView['slot'],
      concept: { id: 'c1', title: 'Rüzgarın işi', hook: 'Motoru yok.', angle: 'curiosity', contentTypeKey: 'howto', beats: 3, durationSec: 6 },
      item: { id: 'i1', status: 'PUBLISHED', scheduledFor: hours(-20), error: null },
      post: { id: 'po1', publishedAt: hours(-20), content: 'x' },
      targets: [
        {
          network: 'INSTAGRAM',
          status: 'PUBLISHED',
          latest: { impressions: 1200, reach: 900, engagements: 80, likes: 60, comments: 10, shares: 5, saves: 5, videoViews: 700, leads: 0, date: hours(-2) },
        },
      ],
      reward: 0.62,
      rewardBreakdown: { INSTAGRAM: { rate: 0.066, baseline: 0.05, r: 0.62 } },
    });
  });

  it('Ayrıntı expands five tabs and the slots table opens a row into its metrics', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    const toggle = await screen.findByRole('button', { name: 'Ayrıntı' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('tab')).toHaveLength(5);

    const rows = screen.getAllByTestId('programme-slot-row');
    expect(rows).toHaveLength(4);
    // The published one carries a reward bar; the planned ones do not.
    expect(screen.getAllByTestId('programme-reward')).toHaveLength(1);
    // The meter has a name that carries its value.
    expect(screen.getByRole('meter', { name: 'Ödül 0.62' })).toHaveAttribute('aria-valuenow', '0.62');
    // Spent beside quoted, and a dash where nothing was quoted yet.
    expect(within(rows[0]).getByTestId('programme-slot-credits-cell')).toHaveTextContent('40 / 120');
    expect(within(rows[1]).getByTestId('programme-slot-credits-cell')).toHaveTextContent('0 / —');
    expect(screen.getByRole('columnheader', { name: 'Harcanan / teklif' })).toBeInTheDocument();

    // The expand control is the button, not the row.
    expect(rows[0]).not.toHaveAttribute('aria-expanded');
    const metricsButton = within(rows[0]).getByRole('button', { name: 'Metrikler' });
    expect(metricsButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(metricsButton);
    expect(metricsButton).toHaveAttribute('aria-expanded', 'true');
    const metrics = await screen.findByTestId('programme-metrics');
    expect(slotMetrics).toHaveBeenCalledWith('p1', 's3');
    expect(within(metrics).getByText('Rüzgarın işi')).toBeInTheDocument();
    const target = within(metrics).getByTestId('programme-metrics-target');
    expect(target).toHaveTextContent('INSTAGRAM');
    expect(target).toHaveTextContent('1200');
    expect(target).toHaveTextContent('700');
    expect(within(metrics).getByTestId('programme-reward-part')).toHaveTextContent('r 0.62');
  });

  it('the Trendler and Günlük tabs render their rows', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Ayrıntı' }));

    await user.click(screen.getByRole('tab', { name: 'Trendler' }));
    const trend = await screen.findByTestId('programme-trend-row');
    expect(trend).toHaveTextContent('TIKTOK');
    expect(within(trend).getByRole('link', { name: /Rüzgar sesi/ })).toHaveAttribute('href', 'https://example.test/s');
    expect(trend).toHaveTextContent('skor 0.80');
    expect(trend).toHaveTextContent('uygunluk 0.40');

    await user.click(screen.getByRole('tab', { name: 'Günlük' }));
    const ev = await screen.findByTestId('programme-event-row');
    expect(ev).toHaveTextContent('slot.planned');
    expect(ev).toHaveTextContent('Salı 18:00 için');
  });

  it('the Türler tab lists every type with both shares', async () => {
    const user = userEvent.setup();
    wrap(<ProgrammePanel now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Ayrıntı' }));
    await user.click(screen.getByRole('tab', { name: 'Türler' }));
    expect(await screen.findAllByTestId('programme-type-row')).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'Nasıl yapılır aktif' })).toBeChecked();
  });
});

describe('ProgrammePanel — failure', () => {
  it('names a read failure and offers a retry rather than an empty row', async () => {
    getProgramme.mockRejectedValue(new Error('boom'));
    wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByText('İçerik programı okunamadı.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yeniden dene' })).toBeInTheDocument();
  });

  it('a 403 or 404 is one quiet sentence with no retry: the programme is not on this plan', async () => {
    getProgramme.mockRejectedValue(httpError(403));
    const { unmount } = wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByTestId('programme-unavailable')).toHaveTextContent('İçerik programı bu planda yok');
    expect(screen.queryByRole('button', { name: 'Yeniden dene' })).not.toBeInTheDocument();
    expect(screen.queryByText('İçerik programı okunamadı.')).not.toBeInTheDocument();
    unmount();

    getProgramme.mockRejectedValue(httpError(404));
    wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByTestId('programme-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yeniden dene' })).not.toBeInTheDocument();
  });
});

describe('ProgrammePanel — roles', () => {
  it('renders nothing for a REP, and never fires the MANAGER-only read', async () => {
    mockRole.mockReturnValue('REP');
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
    const { container } = wrap(<ProgrammePanel now={NOW} />);
    // Give a query that WOULD fire a tick to do so.
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(getProgramme).not.toHaveBeenCalled();
  });

  it('a MANAGER sees the row', async () => {
    mockRole.mockReturnValue('MANAGER');
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
    wrap(<ProgrammePanel now={NOW} />);
    expect(await screen.findByTestId('programme-row')).toBeInTheDocument();
  });
});

describe('ProgrammePanel — freshness', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('re-reads the dashboard every minute while ACTIVE, and not while PAUSED', async () => {
    getProgramme.mockResolvedValue({ programme: programme(), dashboard: dashboard() });
    const { unmount } = wrap(<ProgrammePanel now={NOW} />);
    await screen.findByTestId('programme-row');
    expect(getProgramme).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRAMME_POLL_MS + 50);
    });
    expect(getProgramme).toHaveBeenCalledTimes(2);
    unmount();

    getProgramme.mockClear();
    getProgramme.mockResolvedValue({ programme: programme({ status: 'PAUSED' }), dashboard: dashboard({ status: 'PAUSED' }) });
    wrap(<ProgrammePanel now={NOW} />);
    await screen.findByTestId('programme-row');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRAMME_POLL_MS * 2 + 50);
    });
    expect(getProgramme).toHaveBeenCalledTimes(1);
  });

  it('useTickingNow moves every 30 s, and stays put on the override tests pass', () => {
    vi.setSystemTime(NOW);
    const ticking = renderHook(() => useTickingNow());
    expect(ticking.result.current.getTime()).toBe(NOW.getTime());
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS + 5);
    });
    expect(ticking.result.current.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + NOW_TICK_MS);

    const fixed = renderHook(() => useTickingNow(NOW));
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS * 3);
    });
    expect(fixed.result.current).toBe(NOW);
  });
});
