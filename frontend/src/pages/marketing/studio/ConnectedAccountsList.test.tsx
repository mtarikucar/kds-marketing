import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectedAccountsList } from './ConnectedAccountsList';
import { dayRange } from '@/components/charts';
import { trailingUtcDays } from './todayBounds';
import * as insightsService from '../../../features/marketing/api/socialInsights.service';
import type { SocialInsightsResponse } from '../../../features/marketing/api/socialInsights.service';
import * as postsService from '../../../features/marketing/api/socialPosts.service';
import type { SocialPost } from '../../../features/marketing/api/socialPosts.service';
import * as connectionHooks from '../accounts/hooks';

vi.mock('../../../features/marketing/api/socialInsights.service', async (orig) => ({
  ...(await orig<typeof insightsService>()),
  getSocialInsights: vi.fn(),
}));
vi.mock('../../../features/marketing/api/socialPosts.service', async (orig) => ({
  ...(await orig<typeof postsService>()),
  listSocialPosts: vi.fn(),
}));
vi.mock('../accounts/hooks', async (orig) => ({
  ...(await orig<typeof connectionHooks>()),
  useConnections: vi.fn(),
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

const mockRole = vi.fn(() => 'OWNER' as string | undefined);
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: mockRole() } }),
}));

const getSocialInsights = vi.mocked(insightsService.getSocialInsights);
const listSocialPosts = vi.mocked(postsService.listSocialPosts);
const useConnections = vi.mocked(connectionHooks.useConnections);

const { from, to } = trailingUtcDays(30);

const emptyBucket = {
  impressions: 0,
  reach: 0,
  engagements: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  clicks: 0,
  videoViews: 0,
  posts: 0,
};

const insights = (over: Partial<SocialInsightsResponse> = {}): SocialInsightsResponse => ({
  totals: { ...emptyBucket },
  byDay: [],
  byNetwork: {},
  byAccount: [],
  followersByDay: [],
  coverage: {
    accounts: 0,
    accountsWithData: 0,
    accountsWithErrors: 0,
    lastPulledAt: null,
    unsupportedNetworks: [],
  },
  ...over,
});

const accountRow = (over: Partial<SocialInsightsResponse['byAccount'][number]> = {}) => ({
  socialAccountId: 'sa-1',
  network: 'INSTAGRAM',
  displayName: '@jeeta',
  followers: 0,
  impressions: 0,
  reach: 0,
  engagements: 0,
  posts: 0,
  insightsError: null,
  ...over,
});

const post = (over: Partial<SocialPost> = {}): SocialPost =>
  ({
    id: 'p1',
    content: 'Yeni koleksiyon çıktı',
    mediaUrls: [],
    options: null,
    status: 'PUBLISHED',
    scheduledAt: '2026-08-30T09:00:00Z',
    publishedAt: '2026-08-30T09:00:00Z',
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-30T09:00:00Z',
    targets: [
      {
        id: 't1',
        postId: 'p1',
        socialAccountId: 'sa-1',
        network: 'INSTAGRAM',
        status: 'PUBLISHED',
        externalPostId: 'x',
        error: null,
      },
    ],
    ...over,
  }) as SocialPost;

/** One connected identity, with the SocialAccount rows behind it. */
const identity = (over: Partial<Record<string, unknown>> = {}) => ({
  identityKey: 'META:1',
  externalId: '1',
  displayName: '@jeeta',
  connectedVia: 'OAUTH',
  capabilities: ['PUBLISH'],
  health: 'HEALTHY',
  sources: [{ capability: 'PUBLISH', model: 'SocialAccount', id: 'sa-1', status: 'ACTIVE' }],
  ...over,
});

function connections(list: ReturnType<typeof identity>[] = [identity()], isLoading = false) {
  return {
    data: list.length
      ? {
          secretBoxConfigured: true,
          features: { conversationAi: true },
          networkStatus: {},
          providers: [
            {
              provider: 'META',
              displayName: 'Meta',
              connectMethod: 'OAUTH',
              configured: true,
              connections: list,
            },
          ],
        }
      : { secretBoxConfigured: true, features: { conversationAi: true }, networkStatus: {}, providers: [] },
    isLoading,
  } as unknown as ReturnType<typeof connectionHooks.useConnections>;
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    );
  return wrap(<ConnectedAccountsList from={from} to={to} />);
}

/** Opens an account's popover the way a keyboard or a touch user would. */
async function openAccount(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('OWNER');
  getSocialInsights.mockResolvedValue(insights());
  listSocialPosts.mockResolvedValue([]);
  useConnections.mockReturnValue(connections());
});

describe('ConnectedAccountsList', () => {
  it('offers a way back to the Account Center from a HEALTHY account too', async () => {
    // The chips used to be links there. Turning them into popover triggers took
    // that route away from a working account — the one you open to check a
    // token or disconnect something, not only when it is already broken.
    const user = userEvent.setup();
    renderList();
    const panel = await openAccount(user, 'jeeta');
    const link = within(panel).getByTestId('account-manage-META:1');
    expect(link).toHaveAttribute('href', '/accounts');
  });

  it('lists every connected identity beside the console', async () => {
    useConnections.mockReturnValue(
      connections([
        identity(),
        identity({ identityKey: 'META:2', displayName: 'Jeeta Page', sources: [] }),
      ]),
    );
    renderList();

    const list = await screen.findByRole('list', { name: 'Bağlı hesaplar' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('@jeeta')).toBeInTheDocument();
    expect(within(list).getByText('Jeeta Page')).toBeInTheDocument();
  });

  it('keeps the connect CTA for a workspace with nothing connected', async () => {
    useConnections.mockReturnValue(connections([]));
    renderList();

    expect(await screen.findByText('Henüz bağlı hesap yok')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hesap bağla' })).toHaveAttribute('href', '/accounts');
  });

  it('shows nothing at all to a rep, and asks the manager-only endpoints for nothing', async () => {
    mockRole.mockReturnValue('REP');
    renderList();

    await waitFor(() => expect(useConnections).toHaveBeenCalledWith({ enabled: false }));
    expect(getSocialInsights).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connected-accounts')).not.toBeInTheDocument();
  });

  /**
   * The reason this list is worth having: a workspace whose Instagram token
   * expired last Tuesday sees zeros everywhere and no explanation. The badge is
   * that explanation and it is on the chip itself, not behind the hover.
   */
  it('badges a broken connection without being asked', async () => {
    useConnections.mockReturnValue(connections([identity({ health: 'REAUTH_REQUIRED' })]));
    renderList();

    expect(await screen.findByText('Yeniden bağla')).toBeInTheDocument();
  });

  /**
   * Hover is what the owner asked for; a hover-only affordance is unreachable
   * for anyone on a touchscreen or a keyboard. So the trigger is a real button
   * and activation opens the same popover.
   */
  it('opens the popover from the keyboard, not only from the pointer', async () => {
    const user = userEvent.setup();
    renderList();

    await user.tab();
    expect(await screen.findByRole('button', { name: /@jeeta/ })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  /**
   * Hover opens a PREVIEW, and a preview must not take the focus: the pointer
   * is somewhere else entirely, and yanking the caret across the screen turns a
   * glance into an interruption.
   */
  it('opens it on hover, without stealing the focus', async () => {
    const user = userEvent.setup();
    renderList();

    await user.hover(await screen.findByRole('button', { name: /@jeeta/ }));
    const pop = await screen.findByRole('dialog');
    expect(pop).toBeInTheDocument();
    expect(pop.contains(document.activeElement)).toBe(false);
  });

  /**
   * A preview follows the pointer away; a popover somebody ASKED for does not.
   *
   * Both halves matter. Without the first, every account you glanced at stays
   * open until you click somewhere. Without the second, a popover you opened
   * deliberately — to read a provider error, or to reach the reconnect link —
   * evaporates the moment the mouse drifts off the chip, which is exactly when
   * you are moving it towards the link.
   */
  it('closes a hover preview when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = await screen.findByRole('button', { name: /@jeeta/ });

    await user.hover(trigger);
    await screen.findByRole('dialog');
    await user.unhover(trigger);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps a popover the reader opened, even when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = await screen.findByRole('button', { name: /@jeeta/ });

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.unhover(trigger);

    // Long enough for the preview's close delay to have fired twice over.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /**
   * Escape closes what is on screen, whether it was previewed or pinned.
   *
   * Radix dismisses by calling `onOpenChange(false)` — the very call the
   * trigger's own click makes — so the guard that turns that click into a PIN
   * swallowed the Escape as well: the popover stayed, and because the guard had
   * just marked it pinned, moving the pointer away no longer closed it either.
   * A glance at an account chip became a panel you could not get rid of without
   * clicking somewhere else.
   */
  it('closes a hover preview on Escape rather than pinning it open', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = await screen.findByRole('button', { name: /@jeeta/ });

    await user.hover(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  /**
   * `pointerType === 'mouse'` on the hover handlers is not a nicety.
   *
   * A tap fires pointerenter and then click. Without the guard the first opens
   * the popover and the second — the trigger's own toggle — closes it again, so
   * the one gesture a touch user has would leave the popover shut.
   */
  it('survives a tap, which fires pointerenter before its click', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = await screen.findByRole('button', { name: /@jeeta/ });

    await user.pointer([
      { keys: '[TouchA>]', target: trigger },
      { keys: '[/TouchA]', target: trigger },
    ]);

    const pop = await screen.findByRole('dialog');
    expect(pop).toBeInTheDocument();
    // …and a tap is a DELIBERATE open, not a preview, so it takes the focus —
    // which is what puts the reconnect link inside within reach of the screen
    // reader that just activated the chip.
    expect(pop.contains(document.activeElement)).toBe(true);
  });

  /**
   * The recent-posts read is the only new request this component makes, and it
   * must not be one that every /studio visit pays for.
   */
  it('does not read the recent posts until a popover is opened', async () => {
    const user = userEvent.setup();
    renderList();

    await screen.findByRole('button', { name: /@jeeta/ });
    await waitFor(() => expect(getSocialInsights).toHaveBeenCalled());
    expect(listSocialPosts).not.toHaveBeenCalled();

    await openAccount(user, '@jeeta');
    await waitFor(() => expect(listSocialPosts).toHaveBeenCalledTimes(1));
  });

  it('shows a loading state for the recent posts rather than an empty one', async () => {
    const user = userEvent.setup();
    let release: (v: SocialPost[]) => void = () => {};
    listSocialPosts.mockReturnValue(
      new Promise<SocialPost[]>((res) => {
        release = res;
      }),
    );
    renderList();

    const pop = await openAccount(user, '@jeeta');
    // "nothing here" and "not asked yet" are different facts, and only one of
    // them is about the account.
    expect(within(pop).getByTestId('account-posts-loading')).toBeInTheDocument();
    expect(within(pop).queryByText(/bu hesaba çıkan yok/)).not.toBeInTheDocument();

    release([post()]);
    expect(await within(pop).findByText('Yeni koleksiyon çıktı')).toBeInTheDocument();
  });

  it('lists only the posts that went to THIS account', async () => {
    const user = userEvent.setup();
    listSocialPosts.mockResolvedValue([
      post(),
      post({
        id: 'p2',
        content: 'Başka hesabın gönderisi',
        targets: [
          {
            id: 't2',
            postId: 'p2',
            socialAccountId: 'sa-other',
            network: 'FACEBOOK',
            status: 'PUBLISHED',
            externalPostId: 'y',
            error: null,
          },
        ],
      }),
    ]);
    renderList();

    const pop = await openAccount(user, '@jeeta');
    expect(await within(pop).findByText('Yeni koleksiyon çıktı')).toBeInTheDocument();
    expect(within(pop).queryByText('Başka hesabın gönderisi')).not.toBeInTheDocument();
  });

  /**
   * `publishDuePost` marks a post PUBLISHED as soon as ANY target succeeded, so
   * reading `post.status` here would report a green publish on the very account
   * whose target failed — which is the failure people most need to see.
   */
  it("reports the TARGET's status, not the post's", async () => {
    const user = userEvent.setup();
    listSocialPosts.mockResolvedValue([
      post({
        status: 'PUBLISHED',
        targets: [
          {
            id: 't1',
            postId: 'p1',
            socialAccountId: 'sa-1',
            network: 'INSTAGRAM',
            status: 'FAILED',
            externalPostId: null,
            error: 'nope',
          },
          {
            id: 't2',
            postId: 'p1',
            socialAccountId: 'sa-other',
            network: 'FACEBOOK',
            status: 'PUBLISHED',
            externalPostId: 'y',
            error: null,
          },
        ],
      }),
    ]);
    renderList();

    const pop = await openAccount(user, '@jeeta');
    expect(await within(pop).findByText('Başarısız')).toBeInTheDocument();
    expect(within(pop).queryByText('Yayınlandı')).not.toBeInTheDocument();
  });

  /**
   * Newest first, and ordered on the value the row PRINTS.
   *
   * The unfiltered list is documented as newest-first by creation, but what a
   * reader sees is when the post went out — and a scheduled row has only a
   * `scheduledAt`. Sorting on anything else makes the list and its own
   * timestamps tell two different stories.
   */
  it('lists the newest posts first, by when they went out', async () => {
    const user = userEvent.setup();
    listSocialPosts.mockResolvedValue([
      post({ id: 'old', content: 'Eski gönderi', publishedAt: '2026-08-01T09:00:00Z' }),
      post({ id: 'new', content: 'Yeni gönderi', publishedAt: '2026-08-28T09:00:00Z' }),
    ]);
    renderList();

    const pop = await openAccount(user, '@jeeta');
    await within(pop).findByText('Yeni gönderi');
    const items = within(pop).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Yeni gönderi');
    expect(items[1]).toHaveTextContent('Eski gönderi');
  });

  it('says it looked at a horizon rather than claiming the account never published', async () => {
    const user = userEvent.setup();
    listSocialPosts.mockResolvedValue([]);
    renderList();

    const pop = await openAccount(user, '@jeeta');
    expect(await within(pop).findByText(/Son 50 gönderi arasında bu hesaba çıkan yok/)).toBeInTheDocument();
  });

  it('quotes the provider verbatim and offers the way to fix it', async () => {
    const user = userEvent.setup();
    useConnections.mockReturnValue(connections([identity({ health: 'REAUTH_REQUIRED' })]));
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({ insightsError: '(#10) Requires instagram_manage_insights permission' }),
        ],
      }),
    );
    renderList();

    const pop = await openAccount(user, '@jeeta');
    expect(await within(pop).findByText(/instagram_manage_insights/)).toBeInTheDocument();
    expect(within(pop).getByRole('link', { name: /Hesap merkezinde düzelt/ })).toHaveAttribute(
      'href',
      '/accounts',
    );
  });

  it('reports the follower level and how far it moved across the window', async () => {
    const user = userEvent.setup();
    const days = [from.slice(0, 10), to.slice(0, 10)];
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [accountRow({ followers: 1100 })],
        followersByDay: [
          { date: days[0], byAccount: { 'sa-1': 1000 } },
          { date: days[1], byAccount: { 'sa-1': 1100 } },
        ],
      }),
    );
    renderList();

    const pop = await openAccount(user, '@jeeta');
    // The level now…
    expect(await within(pop).findByText(/1,1\s?B/)).toBeInTheDocument();
    // …and how far it moved, which for a stock is last-minus-first and never a sum.
    expect(within(pop).getByText(/↑\s*100/)).toBeInTheDocument();
  });

  /**
   * A follower count is a STOCK, and an unsampled day is a GAP, not a zero.
   *
   * Zero-filling it draws the audience collapsing to nothing on every day the
   * sweep was skipped or rate limited and then leaping back — a sawtooth that
   * is entirely an artefact of our own sampling and reads as catastrophe. The
   * accessible table is where the distinction is checkable: an em dash for a
   * day we did not measure, never a 0.
   */
  it('leaves the days before the first follower reading empty rather than at zero', async () => {
    const user = userEvent.setup();
    const days = dayRange(from, to);
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [accountRow({ followers: 900 })],
        // One reading, three weeks into the window.
        followersByDay: [{ date: days[20], byAccount: { 'sa-1': 900 } }],
      }),
    );
    renderList();

    const pop = await openAccount(user, '@jeeta');
    const table = await within(pop).findByRole('table', {
      name: '@jeeta hesabının günlük takipçi sayısı',
    });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('—');
    expect(rows[1]).not.toHaveTextContent('0');
    // …and the day we did read carries the level.
    expect(rows[21]).toHaveTextContent('900');
  });

  it("shows this account's own numbers for the window", async () => {
    const user = userEvent.setup();
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [accountRow({ reach: 4200, engagements: 310, posts: 7 })],
      }),
    );
    renderList();

    const pop = await openAccount(user, '@jeeta');
    const reach = (await within(pop).findByText('Erişim')).closest('div')!;
    expect(reach).toHaveTextContent(/4,2\s?B/);
    expect(within(pop).getByText('Etkileşim').closest('div')).toHaveTextContent('310');
    expect(within(pop).getByText('Yayın').closest('div')).toHaveTextContent('7');
  });

  it('does not present zeros as a measurement for a connection with no organic row', async () => {
    const user = userEvent.setup();
    // A messaging channel, an ad account, a network with no organic API — the
    // three zeros above would otherwise read as a measured nothing.
    useConnections.mockReturnValue(connections([identity({ sources: [] })]));
    renderList();

    const pop = await openAccount(user, '@jeeta');
    expect(
      await within(pop).findByText('Bu bağlantı için organik istatistik okunmuyor.'),
    ).toBeInTheDocument();
  });
});
