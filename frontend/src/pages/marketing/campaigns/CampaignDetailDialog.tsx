import { useState } from 'react';
import { useInfiniteQuery, useQuery, useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { provisionSocialFromCampaign } from '../../../features/marketing/api/social-link.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { Callout } from '@/components/ui/Callout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';

/** NetGSM per-jobid stats() rollup merged by campaign-sms-stats.service.ts —
 *  a JSON count-by-status map plus a `jobs` sub-object it's derived from
 *  (per-jobid latest snapshot; not itself a display value). */
interface CampaignSmsStats {
  jobs?: Record<string, Record<string, number>>;
  [status: string]: number | Record<string, Record<string, number>> | undefined;
}

interface CampaignFull {
  id: string;
  name: string;
  channel: string;
  status: string;
  /** Whether this campaign ships an HTML part — which is what decides whether
   *  opens can be measured at all (the pixel lives in the HTML). */
  bodyHtml?: string | null;
  // iysBlocked (RET/YOK/invalid-phone tally) and iysUnavailable (a TİCARİ
  // tick aborted closed — see campaign-sender.service.ts's iysPreflight/
  // abortTicariTick) are rendered as their own dedicated badges below,
  // never through the generic numeric-badge loop.
  stats?:
    | (Record<string, number> & {
        sms?: CampaignSmsStats;
        iysUnavailable?: boolean;
        /**
         * The batch runner gave up on this campaign after repeated errors and
         * paused it. `stalledError` is the raw provider/DB message and is FOR
         * OPS — it is never rendered (PLAN G8, and the numeric-badge loop below
         * already skips non-numbers). What the tenant gets is the sentence and
         * the Resume button.
         */
        stalledError?: string;
        stalledAt?: string;
      })
    | null;
}

/** Known NetGSM delivery buckets get their own labeled cell; everything else
 *  (repeated/refunded/waiting/…) rolls up into a single "other" count so no
 *  status is ever silently dropped from the total. */
const KNOWN_SMS_STATUSES = ['delivered', 'undelivered', 'blacklist', 'iysNotValid'] as const;

function summarizeSmsStats(sms: CampaignSmsStats): { delivered: number; undelivered: number; blacklist: number; iysNotValid: number; other: number } {
  let other = 0;
  for (const [key, value] of Object.entries(sms)) {
    if (key === 'jobs' || typeof value !== 'number') continue;
    if (!(KNOWN_SMS_STATUSES as readonly string[]).includes(key)) other += value;
  }
  return {
    delivered: typeof sms.delivered === 'number' ? sms.delivered : 0,
    undelivered: typeof sms.undelivered === 'number' ? sms.undelivered : 0,
    blacklist: typeof sms.blacklist === 'number' ? sms.blacklist : 0,
    iysNotValid: typeof sms.iysNotValid === 'number' ? sms.iysNotValid : 0,
    other,
  };
}

/** The person behind a recipient row — attached by the backend in one bounded
 *  query per page. Null when the lead has since been deleted. */
interface RecipientLead {
  id: string;
  contactPerson?: string | null;
  businessName?: string | null;
  email?: string | null;
  phone?: string | null;
}

interface RecipientRow {
  id: string;
  leadId: string;
  status: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  error: string | null;
  lead?: RecipientLead | null;
}

interface RecipientsPage {
  rows: RecipientRow[];
  total: number;
}

/** One screenful. The endpoint clamps anything larger. */
const RECIPIENTS_PAGE = 50;

/** The statuses the filter offers — `campaign-sender.service.ts`'s vocabulary. */
const RECIPIENT_STATUSES = ['SENT', 'FAILED', 'SKIPPED', 'UNSUBSCRIBED', 'PENDING'] as const;
const ALL_STATUSES = '__all__';

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  SENT: 'success',
  FAILED: 'danger',
  SKIPPED: 'warning',
  UNSUBSCRIBED: 'warning',
};

/** A timestamp, or the em dash that means "this never happened" — never a 0
 *  and never a blank cell, both of which read as a measurement. */
function when(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export interface CampaignDetailDialogProps {
  campaignId: string | null;
  onClose: () => void;
}

/**
 * How a campaign went, in language the person who sent it can act on.
 *
 * It used to print a raw `leadId`, a raw status enum and nothing else, capped
 * at 500 unpaged rows — so the owner of a 4,000-recipient blast could not
 * follow up on the people who clicked, could not fix the addresses that failed,
 * and could not tell a short list from a truncated one
 * (`campaign-results-unreadable`). Opens are the other half: a plain-text
 * campaign carries no pixel, so "0 opened" was a measurement nobody made — it
 * now reads "—".
 */
export function CampaignDetailDialog({ campaignId, onClose }: CampaignDetailDialogProps) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const open = !!campaignId;
  const [status, setStatus] = useState<string>(ALL_STATUSES);

  // While a send is in flight the counts + recipient rows change server-side;
  // poll so an open detail dialog tracks live progress instead of freezing on the
  // snapshot from when it opened (the list polls, but never invalidated these).
  const LIVE_STATUSES = ['SENDING', 'SCHEDULED'];
  const campaignQuery = useQuery<CampaignFull>({
    queryKey: ['marketing', 'campaigns', campaignId],
    queryFn: () => marketingApi.get(`/campaigns/${campaignId}`).then((r) => r.data),
    enabled: open,
    refetchInterval: (query) =>
      query.state.data && LIVE_STATUSES.includes(query.state.data.status) ? 5000 : false,
  });
  const recipientsQuery = useInfiniteQuery<RecipientsPage>({
    queryKey: ['marketing', 'campaigns', campaignId, 'recipients', status],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ take: String(RECIPIENTS_PAGE), skip: String(pageParam) });
      if (status !== ALL_STATUSES) params.set('status', status);
      return marketingApi.get(`/campaigns/${campaignId}/recipients?${params}`).then((r) => r.data);
    },
    initialPageParam: 0,
    // Optional-chained on purpose: this runs inside React Query's reducer, so a
    // throw here blanks the dialog rather than costing one button.
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((n, p) => n + (p?.rows?.length ?? 0), 0);
      const total = all[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
    enabled: open,
    refetchInterval: () =>
      campaignQuery.data && LIVE_STATUSES.includes(campaignQuery.data.status) ? 5000 : false,
  });

  // Provision a Social Campaign from this blast via the dedicated prefill
  // endpoint (POST /campaigns/:id/social) — same path as the per-row
  // CampaignSocialLinkButton — so the new campaign inherits the blast's
  // audience/leads/brief and a duplicate is refused for an already-linked blast.
  const provision = useMutation({
    mutationFn: () => provisionSocialFromCampaign(campaignId!),
    onSuccess: (r) => {
      toast.success(t('campaigns.socialCreated', 'Social content campaign created'));
      navigate(`/social-campaigns/${r.socialCampaignId}`);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('campaigns.socialCreateFailed', 'Could not create social content')),
  });

  const c = campaignQuery.data;
  const recipients = (recipientsQuery.data?.pages ?? []).flatMap((p) => p?.rows ?? []);
  const total = recipientsQuery.data?.pages?.[0]?.total ?? recipients.length;
  // No HTML part means no open pixel: every open on this campaign is a number
  // nobody measured, and printing 0 would read as "nobody opened it".
  const opensUntracked = !!c && c.channel === 'EMAIL' && !c.bodyHtml;
  const untrackedHint = t('campaigns.plainText', 'Plain text only');

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{c?.name ?? t('campaigns.detail', 'Campaign')}</DialogTitle>
          <DialogDescription>
            {t('campaigns.detailSubtitle', 'Recipients and delivery stats')}
          </DialogDescription>
        </DialogHeader>

        {!c ? (
          <Spinner />
        ) : (
          <div className="space-y-4 overflow-y-auto">
            <div className="flex flex-wrap gap-2 text-sm">
              {Object.entries(c.stats ?? {}).map(([k, v]) =>
                // `sms` is a nested rollup object rendered separately below —
                // never a plain badge value (would crash: objects aren't valid JSX children).
                // `iysBlocked`/`iysUnavailable` get their own translated badges
                // below instead of the raw "iysBlocked: 3" key/value pair.
                k === 'sms' || k === 'iysBlocked' || k === 'iysUnavailable' || typeof v !== 'number' ? null : (
                  <Badge key={k} tone="neutral" title={k === 'opened' && opensUntracked ? untrackedHint : undefined}>
                    {k}: {k === 'opened' && opensUntracked ? '—' : v}
                  </Badge>
                ),
              )}
            </div>
            {c.stats?.stalledAt && (
              <Callout tone="warning">
                <p className="font-medium">{t('campaigns.stalled', 'Sending stopped.')}</p>
                <p className="text-caption">
                  {t(
                    'campaigns.stalledHint',
                    'This campaign stopped part-way because of an error. Fix the problem, then press Resume.',
                  )}
                </p>
              </Callout>
            )}
            {(!!c.stats?.iysBlocked || c.stats?.iysUnavailable) && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {!!c.stats?.iysBlocked && (
                  <Badge tone="warning">
                    {t('campaigns.iysBlockedLabel', 'İYS engelli')}: {c.stats.iysBlocked}
                  </Badge>
                )}
                {c.stats?.iysUnavailable && (
                  <Badge tone="danger">{t('campaigns.iysUnavailableLabel', 'İYS erişilemedi')}</Badge>
                )}
              </div>
            )}
            {c.stats?.sms && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{t('campaigns.smsDelivery', 'Delivery (NetGSM)')}:</span>
                {(() => {
                  const s = summarizeSmsStats(c.stats.sms);
                  return (
                    <>
                      <Badge tone="success">{t('campaigns.smsDelivered', 'delivered')}: {s.delivered}</Badge>
                      <Badge tone="danger">{t('campaigns.smsUndelivered', 'undelivered')}: {s.undelivered}</Badge>
                      <Badge tone="warning">{t('campaigns.smsBlacklist', 'blacklist')}: {s.blacklist}</Badge>
                      <Badge tone="warning">{t('campaigns.smsIysNotValid', 'no İYS consent')}: {s.iysNotValid}</Badge>
                      <Badge tone="neutral">{t('campaigns.smsOther', 'other')}: {s.other}</Badge>
                    </>
                  );
                })()}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-caption text-muted-foreground">
                {t('campaigns.results.total', {
                  defaultValue: '{{shown}} of {{total}} recipients',
                  shown: recipients.length,
                  total,
                })}
              </p>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44" aria-label={t('campaigns.results.status', 'Status')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STATUSES}>{t('campaigns.results.filterAll', 'All')}</SelectItem>
                  {RECIPIENT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`campaigns.recipientStatus.${s}`, s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>{t('campaigns.results.recipient', 'Recipient')}</TH>
                    <TH>{t('campaigns.results.status', 'Status')}</TH>
                    <TH>{t('campaigns.results.sentAt', 'Sent')}</TH>
                    <TH>{t('campaigns.results.opened', 'Opened')}</TH>
                    <TH>{t('campaigns.results.clicked', 'Clicked')}</TH>
                    <TH>{t('campaigns.results.failureReason', 'Why it was not sent')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {recipients.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        {/* The id stays reachable as the title, for a support
                            thread — it is just no longer the whole answer. */}
                        <Link
                          to={`/leads/${r.lead?.id ?? r.leadId}`}
                          title={r.leadId}
                          onClick={onClose}
                          className="text-primary hover:underline"
                        >
                          {r.lead?.contactPerson?.trim() ||
                            r.lead?.businessName?.trim() ||
                            t('campaigns.results.unnamed', 'Unnamed contact')}
                        </Link>
                        <div className="text-caption text-muted-foreground">
                          {r.lead?.email || t('campaigns.results.noEmail', 'no email address')}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone={STATUS_TONE[r.status] ?? 'neutral'} size="sm">
                          {t(`campaigns.recipientStatus.${r.status}`, r.status)}
                        </Badge>
                      </TD>
                      <TD>{when(r.sentAt)}</TD>
                      <TD title={opensUntracked ? untrackedHint : undefined}>
                        {opensUntracked ? '—' : when(r.openedAt)}
                      </TD>
                      <TD>{when(r.clickedAt)}</TD>
                      <TD className="max-w-[16rem] truncate" title={r.error ?? undefined}>
                        {r.error ?? '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>

            {recipients.length === 0 && !recipientsQuery.isLoading && (
              <p className="text-caption text-muted-foreground">
                {t('campaigns.results.empty', 'No recipients match this filter.')}
              </p>
            )}
            {recipientsQuery.isError && (
              <p role="alert" className="text-caption text-danger">
                {t('campaigns.results.loadFailed', 'Could not load the recipients')}
              </p>
            )}
            {recipientsQuery.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={recipientsQuery.isFetchingNextPage}
                disabled={recipientsQuery.isFetchingNextPage}
                onClick={() => recipientsQuery.fetchNextPage()}
              >
                {t('campaigns.results.loadMore', 'Load more')}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            loading={provision.isPending}
            disabled={!c}
            onClick={() => provision.mutate()}
          >
            <Sparkles className="h-4 w-4" /> {t('socialCampaign.crossLink', 'Create social content')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
