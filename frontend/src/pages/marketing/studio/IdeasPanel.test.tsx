import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IdeasPanel from './IdeasPanel';
import { resultRefLabel } from './actionKinds';
import * as strategyService from '../../../features/marketing/api/strategy.service';
import type {
  MarketingStrategy,
  StrategyAction,
} from '../../../features/marketing/api/strategy.service';

vi.mock('../../../features/marketing/api/strategy.service');

// The console renders Turkish inline defaults, so the mock returns the
// defaultValue and interpolates `{{name}}` the way i18next would — otherwise
// every assertion here would be checking a key instead of the copy that ships.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const raw =
        typeof def === 'string' ? def : ((def as { defaultValue?: string })?.defaultValue ?? key);
      const vars = (typeof def === 'object' && def !== null ? def : opts) as
        | Record<string, unknown>
        | undefined;
      return raw.replace(/{{(\w+)}}/g, (_m, name: string) => String(vars?.[name] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    warning: vi.fn(),
  },
}));

// Approve / dismiss / refresh are MANAGER-only on the backend; the default
// fixture is an OWNER so the affordances are on screen. One test flips it.
let role = 'OWNER';
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: any) => sel({ user: { firstName: 'Tarık', role } }),
}));

const getStrategy = vi.mocked(strategyService.getStrategy);
const listStrategyActions = vi.mocked(strategyService.listStrategyActions);
const approveAction = vi.mocked(strategyService.approveAction);
const dismissAction = vi.mocked(strategyService.dismissAction);
const refreshStrategy = vi.mocked(strategyService.refreshStrategy);

const STRATEGY: MarketingStrategy = {
  id: 's1',
  archetype: 'CHALLENGER',
  autonomyLevel: 'ASSISTED',
  status: 'ACTIVE',
  version: 3,
  brief: {
    identity: { product: 'Boyama seti', voice: 'samimi', positioning: 'DIY', usp: 'kutuda her şey' },
    audience: '18-34 hobi meraklıları',
    // A FRACTION, not a percentage — the panel must render 90%, not 0.9%.
    channels: [{ key: 'instagram', fitScore: 0.9, rationale: 'görsel ürün' }],
    contentPillars: [{ title: 'Atölye anları', angle: 'süreç', formats: ['reels'], tone: 'sıcak' }],
    goals: { objective: 'Eylülde 200 yeni sipariş', kpis: ['siparis'] },
    budget: '10.000 TL/ay',
    competitors: [],
  },
};

const action = (over: Partial<StrategyAction> & { id: string }): StrategyAction => ({
  kind: 'CONTENT',
  title: 'Bir fikir',
  rationale: 'Çünkü.',
  payload: {},
  priority: 'MEDIUM',
  status: 'PROPOSED',
  resultRef: null,
  createdAt: '2026-08-30T09:00:00Z',
  updatedAt: '2026-08-30T09:00:00Z',
  ...over,
});

// One of every kind, in the order the backend already sorted them (HIGH→LOW,
// then oldest first). The panel must not re-sort, so the fixture is the order.
const PROPOSED: StrategyAction[] = [
  action({ id: 'c1', kind: 'CONTENT', title: 'Atölye reels serisi', priority: 'HIGH' }),
  action({ id: 'q1', kind: 'COMMUNITY_ENGAGE', title: 'r/hobi paylaşımı', priority: 'HIGH' }),
  action({ id: 'l1', kind: 'LEAD_HUNT', title: 'Hediye dükkanları', priority: 'MEDIUM' }),
  action({ id: 'd1', kind: 'AD_CAMPAIGN', title: 'Trafik kampanyası', priority: 'MEDIUM' }),
  action({ id: 'k1', kind: 'CHANNEL_SETUP', title: 'TikTok hesabını bağla', priority: 'LOW' }),
];

function renderPanel(children: ReactNode = <IdeasPanel />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (id: string) => screen.getByTestId(`idea-${id}`);

beforeEach(() => {
  vi.resetAllMocks();
  role = 'OWNER';
  getStrategy.mockResolvedValue(STRATEGY);
  listStrategyActions.mockImplementation((status) =>
    Promise.resolve(status === 'PROPOSED' ? PROPOSED : []),
  );
});

describe('IdeasPanel', () => {
  it('renders each proposed idea with its kind, priority and a TRUE "what this will do" line', async () => {
    renderPanel();

    expect(await screen.findByText('Atölye reels serisi')).toBeInTheDocument();

    // Kind + priority badges, read inside their own row so a badge belonging to
    // a neighbouring card can never satisfy the assertion.
    expect(within(row('c1')).getByText('İçerik')).toBeInTheDocument();
    expect(within(row('c1')).getByText('Yüksek')).toBeInTheDocument();
    expect(within(row('l1')).getByText('Müşteri avı')).toBeInTheDocument();
    expect(within(row('l1')).getByText('Orta')).toBeInTheDocument();

    // The promises, one per executor. These strings are the consent the
    // operator gives, so each is asserted against the behaviour that was read
    // out of the executor itself.
    expect(screen.getByTestId('idea-what-c1')).toHaveTextContent(/TASLAK/);
    expect(screen.getByTestId('idea-what-c1')).toHaveTextContent(/yayınlanmaz/);
    expect(screen.getByTestId('idea-what-q1')).toHaveTextContent(/CANLI/);
    expect(screen.getByTestId('idea-what-l1')).toHaveTextContent(/HEMEN/);
    expect(screen.getByTestId('idea-what-d1')).toHaveTextContent(/DURAKLATILMIŞ/);
    // AD_CAMPAIGN provisions a shell with no budget — saying otherwise would
    // make people think the panel can spend their ad money.
    expect(screen.getByTestId('idea-what-d1')).toHaveTextContent(/bütçe yok/);
    expect(screen.getByTestId('idea-what-k1')).toHaveTextContent(/işleyici yok/);

    // The strategy header: archetype, objective, pillars, and channel fit as a
    // PERCENTAGE (fitScore is a 0–1 fraction; 0.9 is a strong fit, not 1%).
    expect(screen.getByText('CHALLENGER')).toBeInTheDocument();
    expect(screen.getByText('Eylülde 200 yeni sipariş')).toBeInTheDocument();
    expect(within(screen.getByTestId('ideas-pillars')).getByText('Atölye anları')).toBeInTheDocument();
    expect(screen.getByTestId('ideas-channel-fit')).toHaveTextContent('instagram · 90%');

    // Shared cache with the strategy console: the same PROPOSED status, asked
    // for by the same helper, so the two surfaces cannot disagree.
    expect(listStrategyActions).toHaveBeenCalledWith('PROPOSED');
  });

  it('gives CHANNEL_SETUP no approve button and routes it to /accounts instead', async () => {
    renderPanel();
    await screen.findByText('TikTok hesabını bağla');

    // There is no executor registered for CHANNEL_SETUP: approving would park
    // the row at APPROVED forever while reading as a success.
    expect(within(row('k1')).queryByRole('button', { name: /Onayla/ })).toBeNull();

    const link = within(row('k1')).getByRole('link', { name: /Kanalları bağla/ });
    expect(link).toHaveAttribute('href', '/accounts');

    // Every other kind still has its approve button — the absence above is
    // specific to this kind, not the whole panel failing to render buttons.
    expect(within(row('c1')).getByRole('button', { name: /Onayla/ })).toBeInTheDocument();
  });

  it('approves exactly the clicked row, and leaves every other row actionable', async () => {
    const user = userEvent.setup();
    // Never resolves → the mutation stays pending, which is when the shared
    // `isPending` would bleed onto every row if it were not gated by id.
    approveAction.mockImplementation(() => new Promise<StrategyAction>(() => undefined));
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Onayla/ }));

    expect(approveAction).toHaveBeenCalledTimes(1);
    expect(approveAction).toHaveBeenCalledWith('c1');

    await waitFor(() =>
      expect(within(row('c1')).getByRole('button', { name: /Onayla/ })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    );
    // The other plain-approve row: not spinning, not disabled.
    const other = within(row('d1')).getByRole('button', { name: /Onayla/ });
    expect(other).not.toHaveAttribute('aria-busy');
    expect(other).toBeEnabled();
    expect(within(row('d1')).getByRole('button', { name: /Yoksay/ })).toBeEnabled();
  });

  it('puts LEAD_HUNT approval behind a confirm that names the money it spends', async () => {
    const user = userEvent.setup();
    approveAction.mockResolvedValue(action({ id: 'l1', status: 'APPROVED' }));
    renderPanel();
    await screen.findByText('Hediye dükkanları');

    await user.click(within(row('l1')).getByRole('button', { name: /Onayla/ }));

    // Nothing may run until the operator has read the cost.
    expect(approveAction).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/kotandan düşer/);
    expect(dialog).toHaveTextContent(/tarama/);

    await user.click(within(dialog).getByRole('button', { name: /Onayla/ }));
    await waitFor(() => expect(approveAction).toHaveBeenCalledWith('l1'));
  });

  it('puts COMMUNITY_ENGAGE approval behind a confirm that says it publishes live', async () => {
    const user = userEvent.setup();
    approveAction.mockResolvedValue(action({ id: 'q1', status: 'APPROVED' }));
    renderPanel();
    await screen.findByText('r/hobi paylaşımı');

    await user.click(within(row('q1')).getByRole('button', { name: /Onayla/ }));

    expect(approveAction).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/CANLI/);
    expect(dialog).toHaveTextContent(/geri alınamaz/);
  });

  it('approves CONTENT without a confirm — nothing is published and no money moves', async () => {
    const user = userEvent.setup();
    approveAction.mockResolvedValue(action({ id: 'c1', status: 'APPROVED' }));
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Onayla/ }));

    await waitFor(() => expect(approveAction).toHaveBeenCalledWith('c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never believes the approve response: a run that FAILED is reported as failed', async () => {
    const user = userEvent.setup();
    // The real endpoint returns a PRE-EXECUTION snapshot — always APPROVED with
    // a null resultRef, even for an action that has already blown up.
    approveAction.mockResolvedValue(action({ id: 'c1', status: 'APPROVED', resultRef: null }));
    listStrategyActions.mockImplementation((status) => {
      if (status === 'PROPOSED') return Promise.resolve(PROPOSED);
      if (status === 'FAILED')
        return Promise.resolve([
          action({
            id: 'c1',
            title: 'Atölye reels serisi',
            status: 'FAILED',
            // No error column exists on the row; the reason rides in resultRef.
            resultRef: 'error:AI provider is not configured',
          }),
        ]);
      return Promise.resolve([]);
    });
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Onayla/ }));

    const failure = await screen.findByTestId('ideas-failure');
    expect(failure).toHaveTextContent(/çalıştırılamadı/);
    // The backend's own message, verbatim — and without the `error:` prefix,
    // which is transport, not explanation.
    expect(failure).toHaveTextContent('AI provider is not configured');
    expect(failure).not.toHaveTextContent('error:');
  });

  it('shows an onboarding CTA when the workspace has no strategy at all', async () => {
    // GET /strategy answers 200 with a NULL body here, not a 404.
    getStrategy.mockResolvedValue(null);
    renderPanel();

    const empty = await screen.findByTestId('ideas-no-strategy');
    expect(within(empty).getByRole('link', { name: /Stratejimi kur/ })).toHaveAttribute(
      'href',
      '/onboarding/strategy',
    );
    // Nothing to list without a strategy, so the actions query stays disabled.
    expect(listStrategyActions).not.toHaveBeenCalled();
  });

  it('shows a calmer, refresh-pointing empty when the strategy has no proposed ideas', async () => {
    listStrategyActions.mockResolvedValue([]);
    renderPanel();

    const empty = await screen.findByTestId('ideas-none');
    expect(empty).toHaveTextContent(/Fikirleri yenile/);
    // NOT the onboarding branch — the strategy exists, the plan just ran out.
    expect(screen.queryByTestId('ideas-no-strategy')).toBeNull();
  });

  it('puts "Fikirleri yenile" behind a confirm that names the deletion and the credit spend', async () => {
    const user = userEvent.setup();
    refreshStrategy.mockResolvedValue({ actionCount: 6 });
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(screen.getByRole('button', { name: /Fikirleri yenile/ }));

    // A bare button here would silently delete DONE actions and their links to
    // what they produced, and spend AI credits doing it.
    expect(refreshStrategy).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/siler/);
    expect(dialog).toHaveTextContent(/AI kredisi/);

    await user.click(within(dialog).getByRole('button', { name: /Sil ve yeniden üret/ }));
    await waitFor(() => expect(refreshStrategy).toHaveBeenCalledTimes(1));
  });

  /**
   * A brief is an LLM-written JSON blob stored in a JSON column, so a field's
   * presence is a hope rather than a guarantee — a brief written by an older
   * synthesis, or by the onboarding MCP tools, can carry a channel with no
   * `fitScore` at all.
   *
   * `?? 0` turned that into "reddit · 0%", and 0% is not an absent rating: it is
   * the strategist saying the channel is worthless. That is a recommendation the
   * data never made, printed in the one place on this screen where a person
   * decides where to spend their week.
   */
  it('omits the fit percentage rather than rating an unscored channel at zero', async () => {
    getStrategy.mockResolvedValue({
      ...STRATEGY,
      brief: {
        ...STRATEGY.brief!,
        channels: [{ key: 'reddit', rationale: 'niş orada' } as never],
      },
    });
    renderPanel();

    const fit = await screen.findByTestId('ideas-channel-fit');
    expect(fit).toHaveTextContent('reddit');
    expect(fit).not.toHaveTextContent('%');
  });

  /**
   * `refreshStrategy`'s client type declares `actionCount` OPTIONAL, and `?? 0`
   * read "the server did not say" as the flat claim that the most expensive,
   * most destructive thing this product does produced nothing — announced over
   * a list that is refetching at that very moment and about to fill with ideas.
   */
  it('does not report a plan of zero ideas when the server sent no count', async () => {
    const user = userEvent.setup();
    refreshStrategy.mockResolvedValue({} as never);
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(screen.getByRole('button', { name: /Fikirleri yenile/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Sil ve yeniden üret/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Yeni plan hazır'));
  });

  it('still reports the count when the server does send one', async () => {
    const user = userEvent.setup();
    refreshStrategy.mockResolvedValue({ actionCount: 6 });
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(screen.getByRole('button', { name: /Fikirleri yenile/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Sil ve yeniden üret/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Yeni plan hazır: 6 fikir'));
  });

  it('dismisses a single idea without any confirm', async () => {
    const user = userEvent.setup();
    dismissAction.mockResolvedValue(action({ id: 'c1', status: 'DISMISSED' }));
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Yoksay/ }));

    await waitFor(() => expect(dismissAction).toHaveBeenCalledWith('c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets a REP read the ideas but offers no decision buttons and no error wall', async () => {
    role = 'REP';
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    // The reads are reports.read, so the list is there.
    expect(screen.getAllByTestId(/^idea-[a-z0-9]+$/)).toHaveLength(PROPOSED.length);
    // The writes are MANAGER-only, so they are withheld rather than 403'd.
    expect(screen.queryByRole('button', { name: /Onayla/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Yoksay/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Fikirleri yenile/ })).toBeNull();
    expect(screen.getByTestId('ideas-readonly')).toBeInTheDocument();
  });

  it('links to the full strategy console rather than duplicating it', async () => {
    renderPanel();
    await screen.findByText('Atölye reels serisi');
    expect(screen.getByRole('link', { name: /Strateji konsolunu aç/ })).toHaveAttribute(
      'href',
      '/studio/strategy',
    );
  });
});

describe('resultRefLabel', () => {
  // The single field carries both "here is what I made" and "here is why I
  // died", so the prefix check is the difference between an outcome and a lie.
  it('special-cases the error: prefix instead of reading it as a pointer', () => {
    expect(resultRefLabel('error:Meta rejected the campaign')).toEqual({
      failed: true,
      message: 'Meta rejected the campaign',
    });
  });

  it('names what a successful ref points at', () => {
    expect(resultRefLabel('post:abc')).toMatchObject({ failed: false, id: 'abc' });
    expect(resultRefLabel('research:r1')).toMatchObject({ failed: false, id: 'r1' });
  });

  it('treats an absent ref as "produced nothing", not as a failure', () => {
    expect(resultRefLabel(null)).toBeNull();
    expect(resultRefLabel('')).toBeNull();
  });

  it('keeps an unknown prefix visible rather than inventing a name for it', () => {
    expect(resultRefLabel('newthing:9')).toMatchObject({ failed: false, id: 'newthing:9' });
  });
});
