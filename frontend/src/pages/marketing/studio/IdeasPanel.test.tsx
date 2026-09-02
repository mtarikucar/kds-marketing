import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IdeasPanel from './IdeasPanel';
import { IDEA_FAILURE_KEY } from './ideaFailure';
import * as strategyService from '../../../features/marketing/api/strategy.service';
import type {
  MarketingStrategy,
  StrategyAction,
} from '../../../features/marketing/api/strategy.service';

vi.mock('../../../features/marketing/api/strategy.service');

// The panel renders Turkish inline defaults, so the mock returns the
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

// Dismiss / refresh are MANAGER-only on the backend; the default fixture is an
// OWNER so the affordances are on screen. One test flips it.
let role = 'OWNER';
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: any) => sel({ user: { firstName: 'Tarık', role } }),
}));

const getStrategy = vi.mocked(strategyService.getStrategy);
const listStrategyActions = vi.mocked(strategyService.listStrategyActions);
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
  action({
    id: 'c1',
    kind: 'CONTENT',
    title: 'Atölye reels serisi',
    priority: 'HIGH',
    rationale: 'Süreç videoları bu üründe en çok kaydedilen içerik.',
  }),
  action({ id: 'q1', kind: 'COMMUNITY_ENGAGE', title: 'r/hobi paylaşımı', priority: 'HIGH' }),
  action({ id: 'l1', kind: 'LEAD_HUNT', title: 'Hediye dükkanları', priority: 'MEDIUM' }),
  action({ id: 'd1', kind: 'AD_CAMPAIGN', title: 'Trafik kampanyası', priority: 'MEDIUM' }),
  action({ id: 'k1', kind: 'CHANNEL_SETUP', title: 'TikTok hesabını bağla', priority: 'LOW' }),
];

function renderPanel(children: ReactNode = <IdeasPanel />, at = '/studio') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>{children}</MemoryRouter>
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
  it('keeps a failed approval on screen after the detail that reported it is gone', async () => {
    // The decision moved into IdeaDetail, a `?idea=` surface the operator
    // closes as soon as they have read it. When the failure lived in that
    // component's state, closing it erased the only durable account of what
    // went wrong — and the link cannot be reopened, because the row has left
    // PROPOSED. A toast is a fine confirmation and a terrible error report.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(IDEA_FAILURE_KEY, {
      id: 'q1', title: 'r/hobi paylaşımı', resultRef: 'error: subreddit kilitli',
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/studio']}><IdeasPanel /></MemoryRouter>
      </QueryClientProvider>,
    );
    const banner = await screen.findByTestId('ideas-failure');
    // The provider's own reason, not a generic sentence.
    expect(banner).toHaveTextContent('subreddit kilitli');
  });

  it('lists every proposed idea as one titled row carrying its kind and priority', async () => {
    renderPanel();

    expect(await screen.findByText('Atölye reels serisi')).toBeInTheDocument();

    // Every idea in the plan is on screen — the backlog is the point of the
    // list, and the card layout it replaced fit three.
    expect(screen.getAllByTestId(/^idea-[a-z0-9]+$/)).toHaveLength(PROPOSED.length);

    // Kind + priority, read inside their own row so a badge belonging to a
    // neighbouring row can never satisfy the assertion.
    expect(within(row('c1')).getByText('İçerik')).toBeInTheDocument();
    expect(within(row('c1')).getByText('Yüksek')).toBeInTheDocument();
    expect(within(row('l1')).getByText('Müşteri avı')).toBeInTheDocument();
    expect(within(row('l1')).getByText('Orta')).toBeInTheDocument();
    expect(within(row('k1')).getByText('Kanal kurulumu')).toBeInTheDocument();

    // Shared cache with the strategy console: the same PROPOSED status, asked
    // for by the same helper, so the two surfaces cannot disagree.
    expect(listStrategyActions).toHaveBeenCalledWith('PROPOSED');
  });

  /**
   * The rework, stated as an assertion. The rationale and the "Bu ne yapacak?"
   * promise are not deleted — they moved to IdeaDetail — and a row that starts
   * carrying them again is the panel sliding back into the card list that made
   * the whole backlog invisible.
   */
  it('keeps the rationale and the "what this will do" line OUT of the list', async () => {
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    expect(
      screen.queryByText('Süreç videoları bu üründe en çok kaydedilen içerik.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Bu ne yapacak\?/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('idea-what-c1')).not.toBeInTheDocument();
  });

  /**
   * The row's title is a link into `?idea=<id>` on the SAME screen, which is
   * what makes the detail bookmarkable and back-button-closable. `?tool=` also
   * lives on this URL, so a link that rebuilt the query string from scratch
   * would close whichever drawer was open on the way to an idea.
   */
  it('routes each row to ?idea=<id> without dropping the other search params', async () => {
    renderPanel(<IdeasPanel />, '/studio?tool=calendar');
    await screen.findByText('Atölye reels serisi');

    const link = within(row('c1')).getByRole('link');
    expect(link).toHaveAttribute('href', '/studio?tool=calendar&idea=c1');
    expect(within(row('k1')).getByRole('link')).toHaveAttribute(
      'href',
      '/studio?tool=calendar&idea=k1',
    );
  });

  /**
   * The backend returns HIGH→MEDIUM→LOW and then oldest first, and this panel
   * shares its cache with the strategy console. A second sort here with a
   * different tiebreak is how two surfaces reading one list would name
   * different ideas as "next".
   */
  it('renders the plan in the order the server sent it', async () => {
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    const ids = screen
      .getAllByTestId(/^idea-[a-z0-9]+$/)
      .map((li) => li.getAttribute('data-testid'));
    expect(ids).toEqual(PROPOSED.map((a) => `idea-${a.id}`));
  });

  it('dismisses exactly the clicked row, and leaves every other row actionable', async () => {
    const user = userEvent.setup();
    // Never resolves → the mutation stays pending, which is when the shared
    // `isPending` would bleed onto every row if it were not gated by id.
    dismissAction.mockImplementation(() => new Promise<StrategyAction>(() => undefined));
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Yoksay/ }));

    expect(dismissAction).toHaveBeenCalledTimes(1);
    expect(dismissAction).toHaveBeenCalledWith('c1');
    expect(screen.queryByRole('dialog')).toBeNull();

    await waitFor(() =>
      expect(within(row('c1')).getByRole('button', { name: /Yoksay/ })).toHaveAttribute(
        'aria-busy',
        'true',
      ),
    );
    const other = within(row('d1')).getByRole('button', { name: /Yoksay/ });
    expect(other).not.toHaveAttribute('aria-busy');
    expect(other).toBeEnabled();
  });

  /**
   * Approving publishes under the workspace's name or spends its money, and the
   * sentence that says which lives in IdeaDetail. A bare "Onayla" on a title row
   * is that click without that sentence.
   */
  it('offers no approve button in the list — that decision belongs beside its promise', async () => {
    renderPanel();
    await screen.findByText('Atölye reels serisi');
    expect(screen.queryByRole('button', { name: /Onayla/ })).toBeNull();
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

  it('lets a REP read the backlog but offers no decision buttons and no error wall', async () => {
    role = 'REP';
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    // The reads are reports.read, so the list is there — with its links, so a
    // rep can still open an idea and read what it would do.
    expect(screen.getAllByTestId(/^idea-[a-z0-9]+$/)).toHaveLength(PROPOSED.length);
    expect(within(row('c1')).getByRole('link')).toBeInTheDocument();
    // The writes are MANAGER-only, so they are withheld rather than 403'd.
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

  /**
   * Refresh runs Opus turns, so it can hit the AI credit wall, and it used to
   * toast `e.response.data.message` — the backend's English sentence — into this
   * Turkish panel.
   */
  it('replaces the backend English with role-aware copy when credits run out', async () => {
    const user = userEvent.setup();
    refreshStrategy.mockRejectedValue({
      response: {
        status: 403,
        data: {
          code: 'AI_CREDITS_EXHAUSTED',
          message: 'Monthly AI credit limit reached (100) and prepaid credits are insufficient',
        },
      },
    });
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(screen.getByRole('button', { name: /Fikirleri yenile/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Sil ve yeniden üret/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toMatch(/out of AI credits/i);
    expect(message).not.toMatch(/Monthly AI credit limit reached/);
    expect((opts as { action?: { label: string } })?.action?.label).toBe('Add credits');
  });

  it('keeps the panel’s own Turkish message for an ordinary dismiss failure', async () => {
    const user = userEvent.setup();
    dismissAction.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } });
    renderPanel();
    await screen.findByText('Atölye reels serisi');

    await user.click(within(row('c1')).getByRole('button', { name: /Yoksay/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fikir yoksayılamadı'));
  });
});
