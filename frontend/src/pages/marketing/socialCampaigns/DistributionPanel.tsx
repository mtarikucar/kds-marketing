import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Send, Share2, Tag, AlertTriangle, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Textarea } from '@/components/ui/Textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import {
  getDistributionPlan,
  planContentDistribution,
  sendDistributionDraft,
  dismissDistributionDraft,
  type DistributionDraft,
  type DistributionPlan,
  type DistributionGap,
} from '../../../features/marketing/api/contentDistribution.service';
import type { SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

/**
 * İçerik üretim hattı, aşama 4 — the human's side of the distribution plan.
 *
 * ## What this screen is FOR
 *
 * A published video needs someone told about it. The backend works out who
 * (from the CRM's own people), what to tag (this workspace's own connected
 * accounts — it invents no handles), and when to cross-post to the networks the
 * video is not already on. Then it stops, and stores the messages unsent.
 *
 * This panel is where they stop. **Every send is one person, one message, one
 * click** — there is deliberately no "send all", and `DistributionPanel.test.tsx`
 * asserts its absence rather than trusting that nobody adds one. The reason is
 * the owner's own: automated outreach to accounts that never asked to hear from
 * us is what platform spam detection is built to catch, and the cost is a
 * restricted account rather than a bad number.
 *
 * ## Error is never emptiness, on every branch
 *
 * Four different "there is nothing here" states, and none of them is a shrug:
 *
 *  - no distributable item yet → says the campaign has nothing APPROVED or
 *    PUBLISHED, which is a stage of the pipeline, not a verdict;
 *  - no plan yet → says "not produced yet" and offers the button that produces
 *    one (a 404 from the read is this state, not a failure);
 *  - the plan could not be produced → shows the SERVER'S message verbatim,
 *    which for the workspace that has connected nothing is "connect one first";
 *  - a section of the plan came back empty → renders the `gap` reason in the
 *    place the missing content would have been.
 *
 * The last one is why the plan document carries `gaps` at all. An empty
 * cross-post list rendered as an empty list reads as "no cross-posting needed"
 * about a video the workspace just paid to make.
 *
 * i18n keys live under `contentDistribution.*`, NOT `distribution.*` — that
 * namespace already belongs to the round-robin rules that assign incoming LEADS
 * to reps. Same collision the backend route name avoids, and for the same
 * reason: two things called "distribution" is how somebody eventually edits the
 * wrong one.
 */

const QK = (itemId: string) => ['marketing', 'content-distribution', itemId] as const;

/** The statuses a plan can be produced for — the same list
 *  `DISTRIBUTABLE_ITEM_STATUSES` enforces on the server. Mirrored so the panel
 *  never offers a button whose click is a 400. */
const DISTRIBUTABLE = ['APPROVED', 'SCHEDULED', 'PUBLISHED'];

function serverMessage(e: unknown): string | null {
  const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.join(' ');
  return null;
}

function statusOf(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

export function DistributionPanel({
  campaignId,
  items,
}: {
  campaignId: string;
  items: SocialCampaignItem[];
}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  /**
   * The item this panel is about: the most recent one far enough along to have
   * something to distribute. One item rather than a picker because a campaign's
   * distribution question is always about the post that just went out — and a
   * picker over a hundred slots would bury it.
   */
  const item = useMemo(() => {
    const eligible = items.filter((i) => DISTRIBUTABLE.includes(i.status));
    const published = eligible.filter((i) => i.status === 'PUBLISHED');
    const pool = published.length ? published : eligible;
    return [...pool].sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : -1))[0] ?? null;
  }, [items]);

  const notYet = !item && items.length > 0;

  const planQuery = useQuery<DistributionPlan>({
    queryKey: QK(item?.id ?? 'none'),
    queryFn: () => getDistributionPlan(item!.id),
    enabled: !!item,
    // A 404 means "not planned yet", which is a STATE this panel renders, not a
    // failure to retry into.
    retry: false,
  });

  const produce = useMutation({
    mutationFn: () => planContentDistribution(item!.id),
    onSuccess: (fresh) => {
      qc.setQueryData(QK(item!.id), fresh);
      toast.success(t('contentDistribution.planned', 'Distribution plan produced.'));
    },
    // No toast on failure: the reason goes ON the panel, where the person can
    // read it and act on it. A toast that says "connect an account first" and
    // then disappears is the same as saying nothing.
  });

  const send = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => sendDistributionDraft(id, text),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK(item!.id) });
      qc.invalidateQueries({ queryKey: ['marketing', 'social-campaigns', campaignId] });
      toast.success(t('contentDistribution.sent', 'Message sent.'));
    },
    onError: (e) =>
      toast.error(serverMessage(e) ?? t('contentDistribution.sendFailed', 'The message was not sent.')),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissDistributionDraft(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(item!.id) }),
    onError: (e) =>
      toast.error(serverMessage(e) ?? t('contentDistribution.dismissFailed', 'Could not dismiss it.')),
  });

  if (!item) {
    return (
      <Callout tone="info">
        {notYet
          ? t(
              'contentDistribution.itemNotApproved',
              'Nothing in this campaign has been approved yet, so there is no published post to distribute. This is a stage of the pipeline, not a decision that the video needs no promotion.',
            )
          : t(
              'contentDistribution.noItems',
              'This campaign has no approved or published post yet, so there is nothing to distribute.',
            )}
      </Callout>
    );
  }

  const notPlanned = planQuery.isError && statusOf(planQuery.error) === 404;
  const readFailed = planQuery.isError && !notPlanned;
  const plan = planQuery.data;

  return (
    <div className="space-y-4">
      {planQuery.isLoading && <Spinner />}

      {readFailed && (
        <Callout tone="danger">
          {serverMessage(planQuery.error) ??
            t(
              'contentDistribution.loadFailed',
              'The distribution plan could not be loaded. This is a load failure — it does not mean there is nothing to distribute.',
            )}
        </Callout>
      )}

      {notPlanned && (
        <Card>
          <CardHeader>
            <CardTitle>{t('contentDistribution.title', 'Distribution')}</CardTitle>
            <CardDescription>
              {t(
                'contentDistribution.notPlanned',
                'No distribution plan has been produced for this post yet — who to contact, what to tag, and where to cross-post. Nothing is sent when you produce one: the messages are prepared and wait for you.',
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => produce.mutate()} loading={produce.isPending}>
              {t('contentDistribution.produce', 'Produce the plan')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/*
        The refusal, ON the panel and verbatim. For the workspace that has
        connected nothing this is the sentence that tells them what to do, and a
        generic "could not produce a plan" would hide the only useful part of it.
      */}
      {produce.isError && (
        <Callout tone="danger">
          {serverMessage(produce.error) ??
            t(
              'contentDistribution.produceFailed',
              'The distribution plan could not be produced. This is a failure to produce it, not a finding that no distribution is needed.',
            )}
        </Callout>
      )}

      {plan && (
        <>
          <CrossPostCard plan={plan} t={t} />
          <TagCard plan={plan} t={t} />
          <OutreachCard
            plan={plan}
            t={t}
            onSend={(id, text) => send.mutate({ id, text })}
            onDismiss={(id) => dismiss.mutate(id)}
            busyId={send.isPending ? send.variables?.id : dismiss.isPending ? dismiss.variables : null}
          />
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => produce.mutate()} loading={produce.isPending}>
              {t('contentDistribution.replan', 'Refresh the plan')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

type T = TFunction<'marketing'>;

/** The reasons for a section that came back empty. Rendered WHERE the content
 *  would have been — a gap shown somewhere else is a gap nobody connects to the
 *  blank it explains. */
function Gaps({ gaps, area }: { gaps: DistributionGap[]; area: DistributionGap['area'] }) {
  const mine = gaps.filter((g) => g.area === area);
  if (!mine.length) return null;
  return (
    <div className="space-y-2">
      {mine.map((g, i) => (
        <Callout key={`${area}-${i}`} tone="info">
          {g.reason}
        </Callout>
      ))}
    </div>
  );
}

function CrossPostCard({ plan, t }: { plan: DistributionPlan; t: T }) {
  const { crossPosts, publishedNetworks, gaps } = plan.plan;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="h-4 w-4" aria-hidden="true" />
          {t('contentDistribution.crossPost.title', 'Cross-post schedule')}
        </CardTitle>
        <CardDescription>
          {publishedNetworks.length
            ? t(
                'contentDistribution.crossPost.desc',
                'Already live on {{networks}}. These are the other timelines to redirect from, spaced out rather than posted at once.',
                { networks: publishedNetworks.join(', ') },
              )
            : t(
                'contentDistribution.crossPost.descUnpublished',
                'Where to post this, spaced out rather than all at once.',
              )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {crossPosts.length > 0 && (
          <ul className="space-y-2">
            {crossPosts.map((c) => (
              <li
                key={c.socialAccountId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
              >
                <Badge tone="primary">{c.network}</Badge>
                <span className="text-sm font-medium">{c.accountName}</span>
                <span className="text-caption text-muted-foreground">
                  {new Date(c.runAt).toLocaleString()}
                </span>
                <p className="w-full text-caption text-muted-foreground">{c.note}</p>
              </li>
            ))}
          </ul>
        )}
        <Gaps gaps={gaps} area="crossPost" />
      </CardContent>
    </Card>
  );
}

function TagCard({ plan, t }: { plan: DistributionPlan; t: T }) {
  const { tags, gaps } = plan.plan;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="h-4 w-4" aria-hidden="true" />
          {t('contentDistribution.tags.title', 'What to tag')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {tags.accounts.map((a) => (
            <Badge key={a.socialAccountId} tone="neutral">
              {a.displayName}
            </Badge>
          ))}
          {tags.hashtags.map((h) => (
            <Badge key={h} tone="info">
              {h}
            </Badge>
          ))}
        </div>
        <Gaps gaps={gaps} area="tags" />
      </CardContent>
    </Card>
  );
}

function OutreachCard({
  plan,
  t,
  onSend,
  onDismiss,
  busyId,
}: {
  plan: DistributionPlan;
  t: T;
  onSend: (id: string, text: string) => void;
  onDismiss: (id: string) => void;
  busyId?: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-4 w-4" aria-hidden="true" />
          {t('contentDistribution.outreach.title', 'People to tell')}
        </CardTitle>
        <CardDescription>
          {t(
            'contentDistribution.outreach.desc',
            'Prepared, not sent. Edit each message if you want to, then send them one at a time — there is no bulk send, on purpose.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plan.drafts.length > 0 && (
          <ul className="space-y-3">
            {plan.drafts.map((d) => (
              <DraftRow
                key={d.id}
                draft={d}
                t={t}
                busy={busyId === d.id}
                onSend={onSend}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        )}
        <Gaps gaps={plan.plan.gaps} area="outreach" />
      </CardContent>
    </Card>
  );
}

function DraftRow({
  draft,
  t,
  busy,
  onSend,
  onDismiss,
}: {
  draft: DistributionDraft;
  t: T;
  busy: boolean;
  onSend: (id: string, text: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [text, setText] = useState(draft.body);
  const pending = draft.status === 'DRAFT' || draft.status === 'FAILED';

  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{draft.channelType}</Badge>
        <span className="text-sm font-medium">{draft.toAddress}</span>
        {draft.status === 'SENT' && (
          <Badge tone="success">{t('contentDistribution.status.sent', 'Sent')}</Badge>
        )}
        {draft.status === 'DISMISSED' && (
          <Badge tone="neutral">{t('contentDistribution.status.dismissed', 'Dismissed')}</Badge>
        )}
        {draft.status === 'FAILED' && (
          <Badge tone="danger">{t('contentDistribution.status.failed', 'Failed')}</Badge>
        )}
      </div>

      {/*
        The reason a failed send failed, on the row. A draft that could not be
        delivered must never look like one nobody chose to send.
      */}
      {draft.status === 'FAILED' && draft.error && (
        <p className="flex items-start gap-1.5 text-caption text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {draft.error}
        </p>
      )}

      {pending ? (
        <>
          <Textarea
            aria-label={t('contentDistribution.messageTo', 'Message to {{to}}', { to: draft.toAddress })}
            value={text}
            rows={3}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onDismiss(draft.id)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {t('contentDistribution.dismiss', 'Dismiss')}
            </Button>
            {/*
              One button, one message. There is no bulk equivalent anywhere on
              this screen and the spec asserts there is not.
            */}
            <Button
              size="sm"
              loading={busy}
              disabled={busy || !text.trim()}
              onClick={() => onSend(draft.id, text.trim())}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {t('contentDistribution.send', 'Send')}
            </Button>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-caption text-muted-foreground">{draft.body}</p>
      )}
    </li>
  );
}

export default DistributionPanel;
