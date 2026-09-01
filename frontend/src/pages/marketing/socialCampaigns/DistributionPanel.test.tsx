import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: unknown, opts?: Record<string, unknown>) => {
      const isStr = typeof def === 'string';
      const template = isStr
        ? (def as string)
        : ((def as { defaultValue?: string } | undefined)?.defaultValue ?? key);
      const vars = (isStr ? opts : (def as Record<string, unknown> | undefined)) ?? {};
      return String(template).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../../features/marketing/api/contentDistribution.service', () => ({
  getDistributionPlan: vi.fn(),
  planContentDistribution: vi.fn(),
  sendDistributionDraft: vi.fn(),
  dismissDistributionDraft: vi.fn(),
}));

import {
  getDistributionPlan,
  planContentDistribution,
  sendDistributionDraft,
  dismissDistributionDraft,
} from '../../../features/marketing/api/contentDistribution.service';
import { DistributionPanel } from './DistributionPanel';

const ITEM = { id: 'item-1', status: 'PUBLISHED', topic: 'Strandbeest' };

function draft(over: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    campaignItemId: 'item-1',
    leadId: 'lead-1',
    channelType: 'EMAIL',
    channelId: 'ch-1',
    toAddress: 'ayse@example.com',
    body: 'Bunun motoru yok.',
    status: 'DRAFT',
    sentAt: null,
    sentById: null,
    conversationId: null,
    error: null,
    ...over,
  };
}

function plan(over: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    campaignItemId: 'item-1',
    plan: {
      publishedNetworks: ['INSTAGRAM'],
      crossPosts: [
        {
          network: 'LINKEDIN',
          socialAccountId: 'a-li',
          accountName: 'Figurunica Ltd',
          runAt: '2026-09-02T10:00:00.000Z',
          note: 'Cross-post to LINKEDIN and point it back at the original INSTAGRAM post.',
        },
      ],
      tags: {
        accounts: [
          { socialAccountId: 'a-ig', network: 'INSTAGRAM', displayName: 'figurunica' },
        ],
        hashtags: ['#kinetik'],
      },
      outreachCount: 1,
      gaps: [],
    },
    drafts: [draft()],
    ...over,
  };
}

function renderPanel(items = [ITEM]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DistributionPanel campaignId="camp-1" items={items as never} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getDistributionPlan).mockReset();
  vi.mocked(planContentDistribution).mockReset();
  vi.mocked(sendDistributionDraft).mockReset();
  vi.mocked(dismissDistributionDraft).mockReset();
});

describe('DistributionPanel — nothing sends itself', () => {
  /**
   * THE assertion of this component. Rendering a plan full of prepared messages
   * must dispatch nothing: the panel is a review surface, and the send is one
   * person clicking one button for one message.
   */
  it('sends nothing on render, however many drafts are waiting', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(
      plan({ drafts: [draft(), draft({ id: 'draft-2', toAddress: 'b@example.com' })] }) as never,
    );
    renderPanel();
    await screen.findByText('ayse@example.com');
    expect(sendDistributionDraft).not.toHaveBeenCalled();
  });

  /** There is no bulk affordance, and its absence is asserted rather than
   *  assumed — "send all" is exactly the button this design refuses. */
  it('offers no send-all button', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(
      plan({ drafts: [draft(), draft({ id: 'draft-2', toAddress: 'mert@example.com' })] }) as never,
    );
    renderPanel();
    await screen.findByText('ayse@example.com');
    expect(screen.queryByRole('button', { name: /send all/i })).not.toBeInTheDocument();
    // Two rows, two individual Send buttons — the shape the absence above is
    // about. Without this, "no send-all" would also pass on a screen that had
    // no send affordance at all.
    expect(screen.getAllByRole('button', { name: /^Send$/ })).toHaveLength(2);
  });

  it('sends exactly one draft, the one whose button was clicked', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(
      plan({
        drafts: [draft(), draft({ id: 'draft-2', toAddress: 'mert@example.com' })],
      }) as never,
    );
    vi.mocked(sendDistributionDraft).mockResolvedValue({ draftId: 'draft-2' } as never);
    renderPanel();

    const row = (await screen.findByText('mert@example.com')).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(sendDistributionDraft).toHaveBeenCalledTimes(1));
    expect(sendDistributionDraft).toHaveBeenCalledWith('draft-2', 'Bunun motoru yok.');
  });

  it('sends the text as EDITED, so the record is of what went out', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(plan() as never);
    vi.mocked(sendDistributionDraft).mockResolvedValue({ draftId: 'draft-1' } as never);
    renderPanel();

    const box = await screen.findByLabelText(/message to ayse@example.com/i);
    await userEvent.clear(box);
    await userEvent.type(box, 'Kendi cümlelerim.');
    await userEvent.click(screen.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(sendDistributionDraft).toHaveBeenCalledTimes(1));
    expect(sendDistributionDraft).toHaveBeenCalledWith('draft-1', 'Kendi cümlelerim.');
  });

  it('dismisses without sending', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(plan() as never);
    vi.mocked(dismissDistributionDraft).mockResolvedValue(draft({ status: 'DISMISSED' }) as never);
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /Dismiss/ }));
    await waitFor(() => expect(dismissDistributionDraft).toHaveBeenCalledWith('draft-1'));
    expect(sendDistributionDraft).not.toHaveBeenCalled();
  });

  it('shows a sent draft as sent, with no way to send it again', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(
      plan({ drafts: [draft({ status: 'SENT', sentAt: '2026-09-01T12:00:00.000Z' })] }) as never,
    );
    renderPanel();
    await screen.findByText('ayse@example.com');
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Send$/ })).not.toBeInTheDocument();
  });
});

describe('DistributionPanel — error is never emptiness', () => {
  /**
   * The zero-connected-accounts case, which is the one the owner's cold start
   * actually walks into. The backend refuses with a message naming the fix; the
   * panel must SHOW that message, not fall back to a friendly empty state.
   */
  it('shows the backend’s refusal verbatim when planning is impossible', async () => {
    vi.mocked(getDistributionPlan).mockRejectedValue({ response: { status: 404 } });
    vi.mocked(planContentDistribution).mockRejectedValue({
      response: {
        status: 400,
        data: {
          message:
            'This workspace has no connected social account, so there is nowhere to cross-post this video and no account to tag. Connect one first (Settings → Connections).',
        },
      },
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /Produce the plan/i }));
    expect(await screen.findByText(/no connected social account/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect one first/)).toBeInTheDocument();
  });

  /** A 404 is "not planned yet", not "nothing to distribute" — a different
   *  sentence, and the offer of the action that fixes it. */
  it('says NOT PLANNED YET, not "nothing to distribute", before a plan exists', async () => {
    vi.mocked(getDistributionPlan).mockRejectedValue({ response: { status: 404 } });
    renderPanel();
    expect(await screen.findByText(/No distribution plan has been produced/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Produce the plan/i })).toBeInTheDocument();
  });

  /**
   * Gaps are the whole reason the plan document has a `gaps` array. A section
   * that could not be filled must show its REASON where the missing content
   * would have been.
   */
  it('renders each gap’s reason where the missing section would be', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(
      plan({
        plan: {
          ...plan().plan,
          crossPosts: [],
          outreachCount: 0,
          gaps: [
            {
              area: 'crossPost',
              reason: 'This video is already published on every network this workspace has connected.',
            },
            {
              area: 'outreach',
              reason: 'This workspace has no contactable people on file yet.',
            },
          ],
        },
        drafts: [],
      }) as never,
    );
    renderPanel();
    expect(
      await screen.findByText(/already published on every network/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no contactable people on file/i)).toBeInTheDocument();
  });

  /** An item nobody approved has nothing to distribute YET — say that, and do
   *  not offer a button whose click is a 400. */
  it('does not offer to plan an item that has not reached approval', async () => {
    vi.mocked(getDistributionPlan).mockRejectedValue({ response: { status: 404 } });
    renderPanel([{ id: 'item-1', status: 'GENERATING', topic: 'x' }]);
    expect(await screen.findByText(/has been approved yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Produce the plan/i })).not.toBeInTheDocument();
  });

  it('says so when the campaign has no distributable item at all', async () => {
    renderPanel([]);
    expect(
      await screen.findByText(/no approved or published post/i),
    ).toBeInTheDocument();
    expect(getDistributionPlan).not.toHaveBeenCalled();
  });
});

describe('DistributionPanel — the plan itself', () => {
  it('shows the cross-post schedule and what to tag', async () => {
    vi.mocked(getDistributionPlan).mockResolvedValue(plan() as never);
    renderPanel();
    expect(await screen.findByText('LINKEDIN')).toBeInTheDocument();
    expect(screen.getByText('Figurunica Ltd')).toBeInTheDocument();
    expect(screen.getByText('figurunica')).toBeInTheDocument();
    expect(screen.getByText('#kinetik')).toBeInTheDocument();
  });
});
