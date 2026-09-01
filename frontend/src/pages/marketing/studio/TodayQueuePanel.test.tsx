import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import TodayQueuePanel from './TodayQueuePanel';
import * as postsService from '../../../features/marketing/api/socialPosts.service';
import * as calendarService from '../../../features/marketing/api/contentCalendar.service';
import * as budgetService from '../../../features/marketing/api/growthBudget.service';
import type { SocialPost } from '../social/types';

/**
 * The rail's tests are written against BEHAVIOUR, not markup, because every
 * requirement in this lane is a claim about what the operator is told:
 *
 *   • that a campaign slot with no post behind it is still on the list,
 *   • that a "PUBLISHED" post with a dead target is not reported as fine,
 *   • that clicking publish on one row does not put the whole list in a spinner,
 *   • that editing a scheduled post cannot leave it silently unscheduled — and
 *     that when it does happen anyway, the operator is told THAT, not something
 *     comfortable,
 *   • and that an action is only offered where the backend would accept it.
 *
 * Class names and layout are free to change; those sentences are not.
 */

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: string | Record<string, unknown>) => {
      const def = typeof o === 'string' ? o : ((o?.defaultValue as string) ?? k);
      // The panel interpolates {{time}} / {{count}} into a few defaults; the
      // real i18next does this, so the mock has to as well or the assertions
      // would be reading a raw template.
      if (typeof o === 'object' && o) {
        return def.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(o[key] ?? ''));
      }
      return def;
    },
    i18n: { language: 'tr' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// Only the network calls are stubbed. `hasFailedTarget`, `postThumbnail` and
// `socialQueryKeys` are pure derivations the rail's correctness rests on — a
// test that mocked those would be asserting against its own fiction.
vi.mock('../../../features/marketing/api/socialPosts.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../features/marketing/api/socialPosts.service')>()),
  listSocialPosts: vi.fn(),
  listSocialAccounts: vi.fn(),
  createSocialPost: vi.fn(),
  updateSocialPost: vi.fn(),
  scheduleSocialPost: vi.fn(),
  unscheduleSocialPost: vi.fn(),
  publishSocialPostNow: vi.fn(),
  deleteSocialPost: vi.fn(),
}));

vi.mock('../../../features/marketing/api/contentCalendar.service', () => ({
  listContentCalendar: vi.fn(),
}));

vi.mock('../../../features/marketing/api/growthBudget.service', () => ({
  listPendingApprovals: vi.fn(),
}));

// Stubbed so this suite tests the rail's GATE on the approvals box, not the
// queue's own three-lane approve/apply logic (which has its own tests).
vi.mock('../../../features/marketing/components/ApprovalQueue', () => ({
  ApprovalQueue: () => <div data-testid="approval-queue" />,
}));

vi.mock('../../../features/marketing/hooks/useWorkspaceProfile', () => ({
  useWorkspaceProfile: () => ({ workspace: { id: 'w1', timezone: 'Europe/Istanbul' } }),
}));

let role = 'MANAGER';
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: { user: { id: string; role: string } }) => unknown) =>
    sel({ user: { id: 'u1', role } }),
}));

/**
 * The composer is fully controlled and portal-rendered, and its own internals
 * (react-hook-form + zod + the media/AI sheet) are tested where they live.
 * Here it only has to do one thing: hand the panel a submit payload, so the
 * unschedule → update → schedule sequence can be observed.
 */
let composerPayload: Record<string, unknown> = {};
vi.mock('../social/PostComposerDialog', () => ({
  PostComposerDialog: ({
    open,
    post,
    onSubmit,
  }: {
    open: boolean;
    post?: SocialPost | null;
    onSubmit: (v: unknown) => void;
  }) =>
    open ? (
      <div data-testid="composer">
        <span data-testid="composer-target">{post?.id ?? 'new'}</span>
        <button type="button" onClick={() => onSubmit(composerPayload)}>
          composer-save
        </button>
      </div>
    ) : null,
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

const listSocialPosts = vi.mocked(postsService.listSocialPosts);
const listSocialAccounts = vi.mocked(postsService.listSocialAccounts);
const updateSocialPost = vi.mocked(postsService.updateSocialPost);
const scheduleSocialPost = vi.mocked(postsService.scheduleSocialPost);
const unscheduleSocialPost = vi.mocked(postsService.unscheduleSocialPost);
const publishSocialPostNow = vi.mocked(postsService.publishSocialPostNow);
const listContentCalendar = vi.mocked(calendarService.listContentCalendar);
const listPendingApprovals = vi.mocked(budgetService.listPendingApprovals);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);
const toastWarning = vi.mocked(toast.warning);

/** An instant `mins` minutes from now — keeps "today" true wherever this runs. */
const at = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

const target = (over: Partial<postsService.SocialPost['targets'][number]> = {}) => ({
  id: 'tg-1',
  postId: 'p-1',
  socialAccountId: 'acc-1',
  network: 'INSTAGRAM' as const,
  status: 'PENDING' as const,
  externalPostId: null,
  error: null,
  ...over,
});

const post = (over: Partial<SocialPost> = {}): SocialPost => ({
  id: 'p-1',
  content: 'Sabah gönderisi',
  mediaUrls: [],
  options: null,
  status: 'SCHEDULED',
  scheduledAt: at(60),
  publishedAt: null,
  createdAt: at(-600),
  updatedAt: at(-600),
  targets: [target()],
  ...over,
});

const calPost = (id: string, scheduledAt: string, status = 'SCHEDULED') => ({
  type: 'SOCIAL_POST' as const,
  id,
  title: 'takvim başlığı',
  scheduledAt,
  status,
});

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (ui: ReactNode) =>
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  return wrap(<TodayQueuePanel />);
}

const rowIds = () =>
  screen
    .getAllByTestId(/^tq-row-/)
    .map((el) => el.getAttribute('data-testid')?.replace('tq-row-', ''));

beforeEach(() => {
  vi.clearAllMocks();
  role = 'MANAGER';
  composerPayload = {
    content: 'düzenlenmiş metin',
    media: [],
    formats: {},
    targetAccountIds: ['acc-1'],
  };
  listSocialPosts.mockResolvedValue([]);
  listContentCalendar.mockResolvedValue([]);
  listSocialAccounts.mockResolvedValue([
    {
      id: 'acc-1',
      network: 'INSTAGRAM',
      externalId: 'ig-1',
      displayName: 'jeeta.growth',
      accessToken: '••••abcd',
      tokenExpiresAt: null,
      enabled: true,
      createdAt: at(-10_000),
    },
  ]);
  listPendingApprovals.mockResolvedValue([]);
});

describe('TodayQueuePanel — what goes out today', () => {
  /**
   * The join is the whole point of reading two endpoints. A campaign slot the
   * planner has not materialised into a post yet exists ONLY as a CAMPAIGN_ITEM
   * — read the posts alone and a fully planned afternoon draws as an empty one.
   */
  it('lists the day in time order and keeps a campaign slot that has no post yet', async () => {
    const early = at(-120);
    const mid = at(60);
    const late = at(180);

    listContentCalendar.mockResolvedValue([
      calPost('p-late', late),
      { type: 'CAMPAIGN_ITEM', id: 'item-9', title: 'Kahve içeriği', scheduledAt: mid, status: 'PLANNED' },
      calPost('p-early', early, 'PUBLISHED'),
    ]);
    listSocialPosts.mockResolvedValue([
      post({ id: 'p-late', content: 'Akşam gönderisi', scheduledAt: late }),
      post({
        id: 'p-early',
        content: 'Sabah gönderisi',
        scheduledAt: early,
        status: 'PUBLISHED',
        publishedAt: early,
        targets: [target({ id: 'tg-e', postId: 'p-early', status: 'PUBLISHED' })],
      }),
    ]);

    renderPanel();

    await screen.findByTestId('tq-row-p-early');
    expect(rowIds()).toEqual(['p-early', 'item-9', 'p-late']);

    // The slot renders from the calendar row alone — no post, no invented
    // mutations, but a route to the campaign that planned it.
    const slot = screen.getByTestId('tq-row-item-9');
    expect(slot).toHaveAttribute('data-kind', 'CAMPAIGN_ITEM');
    expect(within(slot).getByText('Kahve içeriği')).toBeInTheDocument();
    expect(screen.getByTestId('tq-campaign-link-item-9')).toBeInTheDocument();
    expect(screen.queryByTestId('tq-actions-item-9')).not.toBeInTheDocument();

    // An hour that has already gone is dimmed rather than dropped: the morning
    // is evidence, and hiding it makes a busy day look idle.
    expect(screen.getByTestId('tq-row-p-early')).toHaveAttribute('data-weight', 'recessive');
    expect(screen.getByTestId('tq-row-p-late')).toHaveAttribute('data-weight', 'normal');
  });

  /**
   * THE correctness requirement of this lane. `publishDuePost` flips a post to
   * PUBLISHED as soon as ONE target succeeds, so a two-network post with a dead
   * Instagram still reads `status: 'PUBLISHED'` with a publishedAt. Badging that
   * row from `post.status` tells the operator the post is out when it is half
   * out — and the half that failed is the half they have to go and fix.
   */
  it('surfaces a PUBLISHED post that has a FAILED target as broken, not as done', async () => {
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-30), 'PUBLISHED')]);
    listSocialPosts.mockResolvedValue([
      post({
        status: 'PUBLISHED',
        publishedAt: at(-30),
        scheduledAt: at(-30),
        targets: [
          target({ id: 'tg-fb', network: 'FACEBOOK', socialAccountId: 'acc-2', status: 'PUBLISHED' }),
          target({ id: 'tg-ig', status: 'FAILED', error: 'Media ID is not available' }),
        ],
      }),
    ]);

    renderPanel();

    const row = await screen.findByTestId('tq-row-p-1');
    // Not PUBLISHED. The row's own verdict says something broke.
    expect(row).toHaveAttribute('data-signal', 'PARTIAL');
    expect(within(row).getByTestId('tq-signal')).toHaveTextContent(/başarısız/i);

    // And it says WHICH network, because "retry Instagram" and "reconnect
    // Facebook" are different mornings.
    expect(screen.getByTestId('tq-target-tg-ig')).toHaveAttribute('data-status', 'FAILED');
    expect(screen.getByTestId('tq-target-tg-fb')).toHaveAttribute('data-status', 'PUBLISHED');

    // The header count exists so a failure below the fold still speaks.
    expect(screen.getByTestId('tq-broken-count')).toHaveTextContent('1');
  });

  /**
   * SCHEDULED is an intent, not a queue position: the job can have been
   * cancelled or have exhausted its retries with the row still reading
   * SCHEDULED. The badge is allowed to say the post was planned for a time; it
   * is not allowed to promise the time will be kept.
   */
  it('calls a scheduled post planned, never promises it will publish', async () => {
    listContentCalendar.mockResolvedValue([calPost('p-1', at(90))]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: at(90) })]);

    renderPanel();

    const badge = within(await screen.findByTestId('tq-row-p-1')).getByTestId('tq-signal');
    expect(badge).toHaveTextContent(/planlandı/i);
    expect(badge.textContent ?? '').not.toMatch(/yayınlanacak/i);
  });

  /**
   * A shared mutation's `isPending` is true for every row that reads it, which
   * is how a list ends up with eight spinners for one click. The per-row gate
   * (`variables === row.id`) is what this asserts, and the publish call itself
   * must land exactly once, on the row that was clicked.
   */
  it('publishes only the row that was clicked, and only that row shows as busy', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(30)), calPost('p-2', at(90))]);
    listSocialPosts.mockResolvedValue([
      post({ id: 'p-1', scheduledAt: at(30) }),
      post({ id: 'p-2', content: 'Diğer gönderi', scheduledAt: at(90), targets: [target({ id: 'tg-2', postId: 'p-2' })] }),
    ]);
    // Publish-now is synchronous on the backend and can take minutes; a promise
    // that never settles is exactly that from the panel's point of view.
    publishSocialPostNow.mockImplementation(() => new Promise<SocialPost>(() => undefined));

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-publish-p-1'));

    await waitFor(() => expect(publishSocialPostNow).toHaveBeenCalledTimes(1));
    expect(publishSocialPostNow).toHaveBeenCalledWith('p-1');

    await waitFor(() =>
      expect(screen.getByTestId('tq-row-p-1')).toHaveAttribute('data-busy', 'true'),
    );
    expect(screen.getByTestId('tq-row-p-2')).toHaveAttribute('data-busy', 'false');
    // And the operator is told why the button is not coming back.
    expect(screen.getByText(/bir dakika sürebilir/i)).toBeInTheDocument();
  });

  /**
   * PATCH refuses anything but a DRAFT, so editing a scheduled post is three
   * calls in a fixed order. Run in any other order — or with the schedule
   * restored by a separate mutation — the post spends the gap unscheduled.
   */
  it('edits a scheduled post as unschedule → update → schedule, in that order', async () => {
    const user = userEvent.setup();
    const original = at(120);
    const moved = at(240);
    const calls: string[] = [];

    listContentCalendar.mockResolvedValue([calPost('p-1', original)]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: original })]);
    unscheduleSocialPost.mockImplementation(async () => {
      calls.push('unschedule');
      return post({ status: 'DRAFT', scheduledAt: null });
    });
    updateSocialPost.mockImplementation(async () => {
      calls.push('update');
      return post({ status: 'DRAFT', scheduledAt: null });
    });
    scheduleSocialPost.mockImplementation(async () => {
      calls.push('schedule');
      return post();
    });
    composerPayload = { ...composerPayload, scheduledAt: moved };

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-edit-p-1'));
    expect(await screen.findByTestId('composer-target')).toHaveTextContent('p-1');
    await user.click(screen.getByText('composer-save'));

    await waitFor(() => expect(calls).toEqual(['unschedule', 'update', 'schedule']));
    expect(scheduleSocialPost).toHaveBeenCalledWith('p-1', expect.objectContaining({ scheduledAt: moved }));
  });

  /**
   * The failure this flow exists to not create. A rejected PATCH after a
   * successful unschedule leaves the post in drafts — it simply stops going
   * out, tonight and every night, with nothing on screen saying so. So the
   * original instant is restored before the error is rethrown.
   */
  it('puts a scheduled post back on its ORIGINAL time when the update rejects', async () => {
    const user = userEvent.setup();
    const original = at(120);

    listContentCalendar.mockResolvedValue([calPost('p-1', original)]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: original })]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    updateSocialPost.mockRejectedValue(new Error('boom'));
    scheduleSocialPost.mockResolvedValue(post({ scheduledAt: original }));
    // The operator moved it; the rollback must ignore that and restore what was
    // actually on the clock, not what the failed edit wanted to put there.
    composerPayload = { ...composerPayload, scheduledAt: at(300) };

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-edit-p-1'));
    await user.click(await screen.findByText('composer-save'));

    await waitFor(() => expect(scheduleSocialPost).toHaveBeenCalledTimes(1));
    expect(scheduleSocialPost).toHaveBeenCalledWith('p-1', {
      scheduledAt: original,
      targetAccountIds: ['acc-1'],
      formats: undefined,
    });
  });

  /**
   * There is no separate reschedule endpoint and none is needed: the publish
   * job is deduped on `social-post-<id>`, so scheduling an already-SCHEDULED
   * post moves the pending job rather than queueing a second one. What this
   * asserts is that the rail sends the post's OWN targets and formats back —
   * `/schedule` overwrites both, so omitting them would quietly strip a
   * three-network post down to nothing while "only" changing its time.
   */
  it('moves a post to a new time without dropping its targets', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(120))]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: at(120) })]);
    scheduleSocialPost.mockResolvedValue(post());

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-when-p-1'));

    const field = await screen.findByLabelText('Yeni zaman');
    fireEvent.change(field, { target: { value: '2026-09-01T14:30' } });
    await user.click(screen.getByRole('button', { name: 'Zamanı kaydet' }));

    await waitFor(() => expect(scheduleSocialPost).toHaveBeenCalledTimes(1));
    expect(scheduleSocialPost).toHaveBeenCalledWith('p-1', {
      scheduledAt: new Date('2026-09-01T14:30').toISOString(),
      targetAccountIds: ['acc-1'],
      formats: undefined,
    });
  });

  /**
   * A FAILED post cannot be re-fired from here — `publish-now` is
   * DRAFT/SCHEDULED-only on the backend, so a "retry" button could only 400.
   * The route back is DRAFT, which the backend lane widened `unschedule` to
   * accept for exactly this. Offering the publish action instead would be an
   * affordance that is guaranteed to fail.
   */
  it('offers a failed post the draft route rather than a retry it cannot perform', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-45), 'FAILED')]);
    listSocialPosts.mockResolvedValue([
      post({
        status: 'FAILED',
        scheduledAt: at(-45),
        targets: [target({ status: 'FAILED', error: 'token expired' })],
      }),
    ]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    expect(await screen.findByTestId('tq-unschedule-p-1')).toBeInTheDocument();
    expect(screen.queryByTestId('tq-publish-p-1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('tq-unschedule-p-1'));
    await waitFor(() => expect(unscheduleSocialPost).toHaveBeenCalledWith('p-1'));
  });

  /**
   * The fallback nothing asserted. Every other fixture in this file hands the
   * composer a `scheduledAt`, so `values.scheduledAt ?? originalAt` could be cut
   * down to `values.scheduledAt` with the suite still green — and the post would
   * silently lose its schedule on any edit that did not carry a time.
   */
  it('re-schedules on the ORIGINAL instant when the composer sends no time', async () => {
    const user = userEvent.setup();
    const original = at(120);

    listContentCalendar.mockResolvedValue([calPost('p-1', original)]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: original })]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    updateSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    scheduleSocialPost.mockResolvedValue(post({ scheduledAt: original }));
    // No `scheduledAt` key at all — a caption fix, not a reschedule.
    composerPayload = {
      content: 'düzenlenmiş metin',
      media: [],
      formats: {},
      targetAccountIds: ['acc-1'],
    };

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-edit-p-1'));
    await user.click(await screen.findByText('composer-save'));

    await waitFor(() => expect(scheduleSocialPost).toHaveBeenCalledTimes(1));
    expect(scheduleSocialPost).toHaveBeenCalledWith('p-1', {
      scheduledAt: original,
      targetAccountIds: ['acc-1'],
      formats: {},
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  /**
   * The other half of the edit's failure surface, and the one the flow used to
   * create rather than survive. The post is a DRAFT by the time the LAST call
   * runs, so a rejected `/schedule` — a blip, or the 400s this endpoint really
   * throws — leaves it there with `scheduledAt: null`. It stops going out, and
   * the panel used to answer that with "planlanan zamanı korundu", which is the
   * precise opposite of what just happened.
   */
  it('tells the operator the post is now an unscheduled draft when the final schedule rejects', async () => {
    const user = userEvent.setup();
    const original = at(120);

    listContentCalendar.mockResolvedValue([calPost('p-1', original)]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: original })]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    updateSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    // The account was disconnected between writing the post and saving the edit.
    scheduleSocialPost.mockRejectedValue(
      new Error('None of the selected accounts are connected'),
    );
    composerPayload = { ...composerPayload, scheduledAt: at(240) };

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    const readsBefore = listSocialPosts.mock.calls.length;
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-edit-p-1'));
    await user.click(await screen.findByText('composer-save'));

    // The rescue is attempted first, on the instant the post actually had.
    await waitFor(() => expect(scheduleSocialPost).toHaveBeenCalledTimes(2));
    expect(scheduleSocialPost).toHaveBeenNthCalledWith(2, 'p-1', {
      scheduledAt: original,
      targetAccountIds: ['acc-1'],
      formats: undefined,
    });

    // It failed too, so the post really is in drafts — say so, and do not say
    // the comfortable thing.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/taslağa düştü ve planı silindi/i),
      ),
    );
    expect(toastError).not.toHaveBeenCalledWith(
      expect.stringMatching(/planlanan zamanı korundu/i),
    );
    expect(toastSuccess).not.toHaveBeenCalled();

    // And the rail refetches, so the row cannot keep drawing a SCHEDULED badge
    // over a post that is no longer scheduled.
    await waitFor(() =>
      expect(listSocialPosts.mock.calls.length).toBeGreaterThan(readsBefore),
    );
  });

  /**
   * The distinction the error shape exists for: the same rejected `/schedule`,
   * but the rescue lands. The post is not in drafts, so it must not be reported
   * as if it were — and the edit DID save, so "güncellenemedi" is not true
   * either. Three outcomes, three sentences.
   */
  it('separates a rebuilt old plan from a lost one', async () => {
    const user = userEvent.setup();
    const original = at(120);

    listContentCalendar.mockResolvedValue([calPost('p-1', original)]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: original })]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    updateSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));
    scheduleSocialPost
      .mockRejectedValueOnce(new Error('Post has no targets'))
      .mockResolvedValueOnce(post({ scheduledAt: original }));
    composerPayload = { ...composerPayload, scheduledAt: at(240) };

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-edit-p-1'));
    await user.click(await screen.findByText('composer-save'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/eski planına geri alındı/i),
      ),
    );
    expect(toastError).not.toHaveBeenCalledWith(
      expect.stringMatching(/taslağa düştü/i),
    );
  });

  /**
   * `publishNow` catches per target: a network that throws is written FAILED and
   * the loop continues, so the request resolves 200 with the post no matter what
   * happened to it. A three-network publish that reached nobody therefore used
   * to raise a green "Gönderi yayınlandı" — directly contradicting the row
   * beside it, which reads the targets and gets it right.
   */
  it('does not call a publish that reached nobody a success', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(30))]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: at(30) })]);
    publishSocialPostNow.mockResolvedValue(
      post({
        status: 'FAILED',
        targets: [target({ status: 'FAILED', error: 'token expired' })],
      }),
    );

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-publish-p-1'));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringMatching(/hiçbir hesapta yayınlanamadı/i),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  /**
   * The half-published case, which is the one `post.status` actively lies about:
   * the post is marked PUBLISHED as soon as ONE target lands, so a 200 here can
   * carry a post that failed on every network but one.
   */
  it('names a publish that lost a network as a partial failure', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(30))]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: at(30) })]);
    publishSocialPostNow.mockResolvedValue(
      post({
        status: 'PUBLISHED',
        publishedAt: at(0),
        targets: [
          target({ id: 'tg-fb', network: 'FACEBOOK', socialAccountId: 'acc-2', status: 'PUBLISHED' }),
          target({ id: 'tg-ig', status: 'FAILED', error: 'Media ID is not available' }),
        ],
      }),
    );

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-publish-p-1'));

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        expect.stringMatching(/bazı hesaplarda yayınlanamadı/i),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  /**
   * Edit's FIRST call is `unschedule`, which the backend refuses for anything it
   * will not pull back to draft — and its second is a `PATCH` that only takes a
   * DRAFT. On a PUBLISHED row the menu item could therefore only ever 400, which
   * is the same rule every other action on this row already follows.
   */
  it('does not offer an edit whose first call the backend would refuse', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-30), 'PUBLISHED')]);
    listSocialPosts.mockResolvedValue([
      post({
        status: 'PUBLISHED',
        publishedAt: at(-30),
        scheduledAt: at(-30),
        targets: [target({ status: 'PUBLISHED' })],
      }),
    ]);

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));

    // The menu opened and still carries the action that IS legal here …
    expect(await screen.findByTestId('tq-delete-p-1')).toBeInTheDocument();
    // … and none of the three that are not.
    expect(screen.queryByTestId('tq-edit-p-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tq-unschedule-p-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tq-publish-p-1')).not.toBeInTheDocument();
  });

  /**
   * A run that died mid-publish leaves the post in PUBLISHING for good, and
   * PUBLISHING is a status nothing else on this screen will touch. `unschedule`
   * was widened on the backend for exactly this, after thirty idle minutes —
   * without the row offering it, the operator's only exit is deleting a post
   * that may already be live on one of its networks.
   */
  it('offers a stuck PUBLISHING post the reset the backend widened unschedule for', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-90), 'PUBLISHING')]);
    listSocialPosts.mockResolvedValue([
      post({ status: 'PUBLISHING', scheduledAt: at(-90), updatedAt: at(-45) }),
    ]);
    unscheduleSocialPost.mockResolvedValue(post({ status: 'DRAFT', scheduledAt: null }));

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));

    const reset = await screen.findByTestId('tq-unschedule-p-1');
    // Called what it is. "Taslağa al" reads as a change of plan; this is a repair.
    expect(reset).toHaveTextContent(/sıfırla/i);

    await user.click(reset);
    await waitFor(() => expect(unscheduleSocialPost).toHaveBeenCalledWith('p-1'));
  });

  /**
   * The other side of the same line, and the reason it is a line rather than a
   * blanket allowance: a multi-network video really can hold the publish request
   * open for minutes, and resetting a live run re-attaches targets underneath a
   * job that is still writing to them.
   */
  it('leaves a PUBLISHING run that is merely slow alone', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-10), 'PUBLISHING')]);
    listSocialPosts.mockResolvedValue([
      post({ status: 'PUBLISHING', scheduledAt: at(-10), updatedAt: at(-5) }),
    ]);

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));

    expect(await screen.findByTestId('tq-delete-p-1')).toBeInTheDocument();
    expect(screen.queryByTestId('tq-unschedule-p-1')).not.toBeInTheDocument();
  });

  /**
   * The join's second loop, which nothing pinned. The calendar deliberately
   * suppresses rows (a materialised campaign item, today), and it is one small
   * change away from suppressing something else — but a post the planner
   * returned with a time on it IS going out today, and dropping it because the
   * other read did not mention it would be the rail failing at its only job.
   */
  it('draws a scheduled post the calendar did not report', async () => {
    listContentCalendar.mockResolvedValue([]);
    listSocialPosts.mockResolvedValue([post({ scheduledAt: at(60) })]);

    renderPanel();

    const row = await screen.findByTestId('tq-row-p-1');
    expect(within(row).getByText('Sabah gönderisi')).toBeInTheDocument();
    expect(row).toHaveAttribute('data-signal', 'PLANNED');
    expect(screen.queryByTestId('tq-empty')).not.toBeInTheDocument();
  });

  /**
   * HONEST PARTIAL DATA, from the other direction: the manager-only post list
   * failed and the calendar did not. The rows still exist — they are what the
   * rail is for — but everything the posts carried (targets, actions) is gone,
   * and that is said once, in the header, rather than left to be inferred from
   * rows that quietly lost their menus.
   */
  it('keeps drawing the calendar rows when the post list cannot be read', async () => {
    listSocialPosts.mockRejectedValue(new Error('boom'));
    listContentCalendar.mockResolvedValue([calPost('p-1', at(60)), calPost('p-2', at(120))]);

    renderPanel();

    expect(await screen.findByTestId('tq-posts-unread')).toBeInTheDocument();
    expect(await screen.findByTestId('tq-row-p-1')).toBeInTheDocument();
    expect(screen.getByTestId('tq-row-p-2')).toBeInTheDocument();
    // No post in hand means no targets to act on, so the row offers nothing it
    // cannot carry out.
    expect(screen.queryByTestId('tq-actions-p-1')).not.toBeInTheDocument();
  });

  /** Hard delete, targets cascade, no undo — so it goes behind a confirmation. */
  it('does not delete on the menu click alone', async () => {
    const user = userEvent.setup();
    listContentCalendar.mockResolvedValue([calPost('p-1', at(60))]);
    listSocialPosts.mockResolvedValue([post()]);
    vi.mocked(postsService.deleteSocialPost).mockResolvedValue(undefined as never);

    renderPanel();

    await screen.findByTestId('tq-row-p-1');
    await user.click(screen.getByTestId('tq-actions-p-1'));
    await user.click(await screen.findByTestId('tq-delete-p-1'));

    expect(postsService.deleteSocialPost).not.toHaveBeenCalled();
    expect(await screen.findByText(/Geri alınamaz/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sil' }));
    await waitFor(() => expect(postsService.deleteSocialPost).toHaveBeenCalledWith('p-1'));
  });

  it('says the day is empty rather than drawing a blank column', async () => {
    renderPanel();
    expect(await screen.findByTestId('tq-empty')).toHaveTextContent(
      /Bugün planlanmış bir paylaşım yok/i,
    );
    // The empty state is only useful if it also offers the way out of it.
    expect(within(screen.getByTestId('tq-empty')).getByRole('button')).toHaveTextContent(
      /Yeni gönderi/i,
    );
  });

  /**
   * A permanently-present "Onay bekleyenler" box is how people learn to skip
   * the one box that must never be skipped. It exists only when something is
   * actually waiting.
   */
  it('draws no approvals box when nothing is waiting', async () => {
    renderPanel();
    await screen.findByTestId('tq-empty');
    expect(screen.queryByTestId('tq-approvals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-queue')).not.toBeInTheDocument();
  });

  it('draws the approvals box the moment something is', async () => {
    listPendingApprovals.mockResolvedValue([{ id: 'ar-1', kind: 'PUBLISH_POST' }] as never);
    renderPanel();
    expect(await screen.findByTestId('tq-approvals')).toBeInTheDocument();
    expect(screen.getByTestId('approval-queue')).toBeInTheDocument();
  });
});

/**
 * The whole SocialPlannerController is `@MarketingRoles('MANAGER')`, so a REP
 * on this screen gets a 403 for the posts and the accounts and a clean 200 for
 * the calendar. Firing those calls anyway would greet them with a stack of
 * error toasts every morning; the rail gates them on the role instead and says,
 * once and quietly, what they are missing.
 */
describe('TodayQueuePanel — a rep on a manager-only endpoint', () => {
  beforeEach(() => {
    role = 'REP';
  });

  it('renders the calendar half read-only and never calls the manager-only endpoints', async () => {
    listContentCalendar.mockResolvedValue([calPost('p-1', at(60))]);

    renderPanel();

    const row = await screen.findByTestId('tq-row-p-1');
    expect(within(row).getByText('takvim başlığı')).toBeInTheDocument();
    expect(screen.queryByTestId('tq-actions-p-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('tq-readonly')).toBeInTheDocument();
    expect(listSocialPosts).not.toHaveBeenCalled();
    expect(listSocialAccounts).not.toHaveBeenCalled();
  });

  /**
   * Without targets, "PUBLISHED" is a claim we were handed and cannot check —
   * the exact claim the manager view is forbidden from trusting. It is rendered
   * as reported, not as verified.
   */
  it('does not vouch for a PUBLISHED status it has no targets to check', async () => {
    listContentCalendar.mockResolvedValue([calPost('p-1', at(-60), 'PUBLISHED')]);

    renderPanel();

    expect(await screen.findByTestId('tq-row-p-1')).toHaveAttribute(
      'data-signal',
      'PUBLISHED_UNVERIFIED',
    );
  });
});
