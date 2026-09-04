import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IdeaDetail from './IdeaDetail';
import { resultRefLabel } from './actionKinds';
import * as strategyService from '../../../features/marketing/api/strategy.service';
import type {
  MarketingStrategy,
  StrategyAction,
} from '../../../features/marketing/api/strategy.service';

vi.mock('../../../features/marketing/api/strategy.service');

// The surface renders Turkish inline defaults, so the mock returns the
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

// Approve/dismiss are MANAGER-only on the backend; the default fixture is an
// OWNER so the affordances are on screen. One test flips it.
let role = 'OWNER';
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: any) => sel({ user: { firstName: 'Tarık', role } }),
}));

const getStrategy = vi.mocked(strategyService.getStrategy);
const listStrategyActions = vi.mocked(strategyService.listStrategyActions);
const approveAction = vi.mocked(strategyService.approveAction);
const dismissAction = vi.mocked(strategyService.dismissAction);

const STRATEGY: MarketingStrategy = {
  id: 's1',
  archetype: 'CHALLENGER',
  autonomyLevel: 'ASSISTED',
  status: 'ACTIVE',
  version: 3,
  brief: {
    identity: { product: 'Boyama seti', voice: 'samimi', positioning: 'DIY', usp: 'kutuda her şey' },
    audience: '18-34 hobi meraklıları',
    // A FRACTION, not a percentage — the page must render 90%, not 0.9%.
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

const onClose = vi.fn();

function renderDetail(ideaId = 'c1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IdeaDetail ideaId={ideaId} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  role = 'OWNER';
  onClose.mockReset();
  getStrategy.mockResolvedValue(STRATEGY);
  listStrategyActions.mockImplementation((status) =>
    Promise.resolve(status === 'PROPOSED' ? PROPOSED : []),
  );
});

describe('IdeaDetail', () => {
  it('shows the whole idea: title, why, what it will do, priority, status', async () => {
    renderDetail('c1');

    expect(await screen.findByRole('heading', { name: 'Atölye reels serisi' })).toBeInTheDocument();
    expect(
      screen.getByText('Süreç videoları bu üründe en çok kaydedilen içerik.'),
    ).toBeInTheDocument();
    expect(screen.getByText('İçerik')).toBeInTheDocument();
    expect(screen.getByText('Yüksek')).toBeInTheDocument();
    expect(screen.getByTestId('idea-detail-status')).toHaveTextContent('Öneri');

    // The promise, verified against the executor it describes: CONTENT drafts
    // into the Social Planner and publishes nothing.
    expect(screen.getByTestId('idea-detail-what')).toHaveTextContent(/TASLAK/);
    expect(screen.getByTestId('idea-detail-what')).toHaveTextContent(/yayınlanmaz/);

    // Reads the SAME PROPOSED list the panel loads — there is no single-action
    // endpoint, and a second one would let the two surfaces disagree.
    expect(listStrategyActions).toHaveBeenCalledWith('PROPOSED');
  });

  /**
   * The strategy the idea hangs off. It used to be a permanent three-row header
   * over the list, where it cost the backlog most of its height while answering
   * the same question for every row; it is read while judging ONE proposal.
   */
  it('carries the strategy context — objective, pillars, channel fit as a percentage', async () => {
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    expect(screen.getByText('Eylülde 200 yeni sipariş')).toBeInTheDocument();
    expect(within(screen.getByTestId('ideas-pillars')).getByText('Atölye anları')).toBeInTheDocument();
    // `fitScore` is a 0–1 fraction; 0.9 is a strong fit, not 1%.
    expect(screen.getByTestId('ideas-channel-fit')).toHaveTextContent('instagram · 90%');
  });

  /**
   * A brief is an LLM-written JSON blob in a JSON column, so a field's presence
   * is a hope. `?? 0` printed "reddit · 0%", and 0% is not an absent rating — it
   * is the strategist calling the channel worthless, a recommendation the data
   * never made.
   */
  it('omits the fit percentage rather than rating an unscored channel at zero', async () => {
    getStrategy.mockResolvedValue({
      ...STRATEGY,
      brief: {
        ...STRATEGY.brief!,
        channels: [{ key: 'reddit', rationale: 'niş orada' } as never],
      },
    });
    renderDetail('c1');

    const fit = await screen.findByTestId('ideas-channel-fit');
    expect(fit).toHaveTextContent('reddit');
    expect(fit).not.toHaveTextContent('%');
  });

  it('gives CHANNEL_SETUP no approve button, and states the reason without a hover', async () => {
    renderDetail('k1');
    await screen.findByRole('heading', { name: 'TikTok hesabını bağla' });

    // There is no executor registered for CHANNEL_SETUP: approving would park
    // the row at APPROVED forever while reading as a success.
    expect(screen.queryByRole('button', { name: /Onayla/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Yoksay/ })).toBeNull();

    const manual = screen.getByTestId('idea-detail-manual');
    expect(manual).toHaveTextContent(/izin akışı/);
    expect(within(manual).getByRole('link', { name: /Kanalları bağla/ })).toHaveAttribute(
      'href',
      '/accounts',
    );
  });

  it('approves CONTENT without a confirm — nothing is published and no money moves', async () => {
    const user = userEvent.setup();
    approveAction.mockResolvedValue(action({ id: 'c1', status: 'APPROVED' }));
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

    await waitFor(() => expect(approveAction).toHaveBeenCalledWith('c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The idea has left the queue, so the page that was showing it closes
    // rather than turning into "this idea is no longer in the list".
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('puts LEAD_HUNT approval behind a confirm that names the money it spends', async () => {
    const user = userEvent.setup();
    approveAction.mockResolvedValue(action({ id: 'l1', status: 'APPROVED' }));
    renderDetail('l1');
    await screen.findByRole('heading', { name: 'Hediye dükkanları' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

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
    renderDetail('q1');
    await screen.findByRole('heading', { name: 'r/hobi paylaşımı' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

    expect(approveAction).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/CANLI/);
    expect(dialog).toHaveTextContent(/geri alınamaz/);
  });

  /**
   * The approve response is a PRE-EXECUTION snapshot — always APPROVED with a
   * null resultRef, even for a run that has already blown up. And because a
   * failed run leaves the PROPOSED list, the page has to keep the row it probed
   * or it would replace the failure with "that idea is gone".
   */
  it('never believes the approve response: a run that FAILED is reported as failed', async () => {
    const user = userEvent.setup();
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
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

    const failure = await screen.findByTestId('idea-detail-failure');
    expect(failure).toHaveTextContent(/çalıştırılamadı/);
    // The backend's own message, verbatim — and without the `error:` prefix,
    // which is transport, not explanation.
    expect(failure).toHaveTextContent('AI provider is not configured');
    expect(failure).not.toHaveTextContent('error:');
    // The page stays open on the failure it is reporting, and now tells the
    // truth about the row's state.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('idea-detail-notfound')).toBeNull();
    expect(screen.getByTestId('idea-detail-status')).toHaveTextContent('Başarısız');
  });

  /**
   * `resultRef` carries BOTH outcomes in one column. A successful ref names what
   * was made; only the `error:` prefix means a failure, and reading the field
   * without that check renders a stack-trace fragment as a link to a post.
   */
  it('names what a successful run produced instead of dressing it as a failure', async () => {
    listStrategyActions.mockImplementation((status) =>
      Promise.resolve(
        status === 'PROPOSED'
          ? [action({ id: 'c1', title: 'Atölye reels serisi', resultRef: 'post:abc' })]
          : [],
      ),
    );
    renderDetail('c1');

    const result = await screen.findByTestId('idea-detail-result');
    expect(result).toHaveTextContent('taslak gönderi');
    expect(result).toHaveTextContent('abc');
    expect(screen.queryByTestId('idea-detail-failure')).toBeNull();
  });

  it('dismisses the idea and closes the page it was opened from', async () => {
    const user = userEvent.setup();
    dismissAction.mockResolvedValue(action({ id: 'c1', status: 'DISMISSED' }));
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    await user.click(screen.getByRole('button', { name: /Yoksay/ }));

    await waitFor(() => expect(dismissAction).toHaveBeenCalledWith('c1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  /**
   * There is no single-action endpoint, so an id outside the PROPOSED list
   * cannot be rendered at all — a stale link, an idea somebody else decided, or
   * a plan that was refreshed out from under it. A blank panel would read as a
   * broken page and the operator could not tell the two apart.
   */
  it('says so honestly when the id is not in the list, instead of drawing nothing', async () => {
    const user = userEvent.setup();
    renderDetail('gone');

    const notFound = await screen.findByTestId('idea-detail-notfound');
    expect(notFound).toHaveTextContent(/artık listede yok/);
    expect(screen.queryByTestId('idea-detail-what')).toBeNull();

    await user.click(within(notFound).getByRole('button', { name: /Fikirlere dön/ }));
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * The not-found branch must not be reachable while the list is still in
   * flight: showing "this idea is gone" for the first second of every open is a
   * lie the operator has no way to check.
   */
  it('does not claim the idea is gone while the list is still loading', async () => {
    listStrategyActions.mockImplementation(() => new Promise<StrategyAction[]>(() => undefined));
    renderDetail('c1');

    await waitFor(() => expect(listStrategyActions).toHaveBeenCalled());
    expect(screen.queryByTestId('idea-detail-notfound')).toBeNull();
  });

  /**
   * A read that FAILED is not an idea that was decided.
   *
   * The list this page selects from is gated on the strategy read, so a 500 on
   * GET /strategy leaves the actions query disabled — never loading, never
   * erroring — and the id resolves to nothing. Reporting that as "this idea is
   * no longer in the list" tells the operator their proposal was dismissed or
   * deleted, when all that happened is that we could not ask.
   */
  it('says the read failed rather than reporting the idea as gone', async () => {
    getStrategy.mockRejectedValue(new Error('500'));
    renderDetail('c1');

    expect(await screen.findByText('Fikir yüklenemedi.')).toBeInTheDocument();
    expect(screen.queryByTestId('idea-detail-notfound')).toBeNull();
  });

  it('lets a REP read the idea but offers no decision buttons and no error wall', async () => {
    role = 'REP';
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    // The reads are reports.read, so the whole idea — including what approving
    // it would do — is there.
    expect(screen.getByTestId('idea-detail-what')).toBeInTheDocument();
    // The writes are MANAGER-only, so they are withheld rather than 403'd.
    expect(screen.queryByRole('button', { name: /Onayla/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Yoksay/ })).toBeNull();
    expect(screen.getByTestId('idea-detail-readonly')).toBeInTheDocument();
  });

  /**
   * Approve runs Opus turns, so it can hit the AI credit wall, and it used to
   * toast `e.response.data.message` — the backend's English sentence — into this
   * Turkish surface.
   */
  it('replaces the backend English with role-aware copy when credits run out', async () => {
    const user = userEvent.setup();
    approveAction.mockRejectedValue({
      response: {
        status: 403,
        data: {
          code: 'AI_CREDITS_EXHAUSTED',
          message: 'Monthly AI credit limit reached (100) and prepaid credits are insufficient',
        },
      },
    });
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toMatch(/out of AI credits/i);
    expect(message).not.toMatch(/Monthly AI credit limit reached/);
    expect((opts as { action?: { label: string } })?.action?.label).toBe('Add credits');
  });

  it('keeps its own Turkish message for an ordinary approve failure', async () => {
    const user = userEvent.setup();
    approveAction.mockRejectedValue({ response: { status: 500, data: { message: 'boom' } } });
    renderDetail('c1');
    await screen.findByRole('heading', { name: 'Atölye reels serisi' });

    await user.click(screen.getByRole('button', { name: /Onayla/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fikir onaylanamadı'));
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
