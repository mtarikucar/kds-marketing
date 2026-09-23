import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { emailPaused } from '../../../common/util/email-paused';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob } from '../scheduling/scheduled-job-runner.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { MessageQuotaService } from '../channels/message-quota.service';
import { OutboundMailService } from '../channels/outbound/outbound-mail.service';
import { MailReason, MailReceipt } from '../channels/outbound/outbound-mail.types';
import { ResolvedChannelConfig } from '../channels/channel-adapter.interface';
import { SmsV2Client, SmsV2SendResult } from '../../netgsm/sms/sms-v2.client';
import { IysClient, IysSearchResult } from '../../netgsm/iys/iys.client';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { VoicesmsSendClient, VoicesmsSendResult } from '../../netgsm/voice/voicesms-send.client';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';
import { ConversationSpendService } from '../budget/conversation-spend.service';
import { notifyCommerce } from '../invoicing/commerce-notify';
import { toIysMsisdn } from '../utils/lead-normalize';
import { CAMPAIGN_BATCH_KIND, CAMPAIGN_AB_DECIDE_KIND, CAMPAIGN_LAUNCH_KIND, AB_TEST_WINDOW_MS } from './campaigns.service';

const BATCH_SIZE = 50;
const BATCH_INTERVAL_SEC = 60; // ~50 sends/min throttle

/**
 * How long one tick may spend in the per-recipient send loop.
 *
 * A tick runs inside the shared job runner's single global advisory lock
 * (`scheduled-job-runner.service.ts`), which dispatches claimed jobs
 * sequentially — so fifty SMTP round-trips in a row are fifty round-trips every
 * other tenant's AI reply, workflow resume and booking reminder waits for
 * (`batches-stall-runner`). The loop is already built for resumption (rows are
 * claimed one at a time and the tail reschedules whatever is left), so stopping
 * halfway costs the campaign nothing but the next sixty seconds — while the
 * runner's own budget, which this stays under, keeps the queue moving.
 */
export const BATCH_BUDGET_MS = 30_000;

/** İYS's documented per-account rate limit — shared across the WHOLE İYS
 *  surface (this preflight's `/iys/search` calls contend for the same
 *  AccountRateBudgeter bucket, `'iys'`, as iys-sync.service.ts's `/iys/add`
 *  worker; that's intentional, mirroring NetGSM's own aggregate per-account
 *  cap rather than a per-endpoint one). */
const IYS_SEARCH_BUDGET_LIMIT = 10;
const IYS_SEARCH_BUDGET_WINDOW_MS = 60_000;

/**
 * How many consecutive ticks may send NOTHING and put recipients back in the
 * queue before the campaign pauses itself.
 *
 * `CampaignRecipient` carries no attempt counter, so "revert to PENDING and
 * retry" is otherwise an unbounded 60-second loop against a condition that will
 * not clear on its own (an exhausted monthly quota stays exhausted for the rest
 * of the month) — hammering the shared relay and the tenant's own mailbox.
 * The streak lives in the existing `Campaign.stats` jsonb, whose writers all
 * merge spread-first, so it needs no column (`campaign-failures-terminal`).
 */
const FAIL_STREAK_LIMIT = 3;

/** The bell a stalled campaign rings. Its own type, so the notification list
 *  can tell "your send stopped" apart from the commerce moments that share
 *  this writer. */
const CAMPAIGN_STALLED_NOTIFICATION = 'CAMPAIGN_STALLED';

/** An A/B call needs a cohort worth calling: this many sends on at least two
 *  variants, and this many events on the leader. Below that the numbers are
 *  noise and the decision is made on the authored weight instead
 *  (`ab-raw-counts`). */
const AB_MIN_SAMPLE = 30;
const AB_MIN_EVENTS = 5;

/**
 * Refusals that are about THIS recipient. They end the recipient (SKIPPED,
 * exactly like the opt-out re-check above them) and say nothing about the next
 * one. Every other refusal — an exhausted quota, a suspended workspace, a
 * paused sender, a missing transport — is about the WORKSPACE: burning the
 * audience into FAILED rows for it destroys a campaign that a re-activation
 * would otherwise resume, because FAILED rows are never re-sent.
 */
const RECIPIENT_REFUSALS: ReadonlySet<MailReason> = new Set<MailReason>([
  'SUPPRESSED_OPT_OUT',
  'SUPPRESSED_BOUNCE',
  'SUPPRESSED_INVALID',
  'SUPPRESSED_COMPLAINT',
  'SUPPRESSED_ERASED',
  'IYS_RET',
  'CONSENT_REQUIRED',
  'NO_RECIPIENT',
  'BAD_RECIPIENT',
]);

/** The roots a campaign merge tag may read. A token on any other root is left
 *  exactly as the author typed it — a campaign body is not a template
 *  language, and silently eating `{{order.total}}` is its own defect. */
const MERGE_ROOTS: ReadonlySet<string> = new Set(['lead', 'workspace']);

/** When a name token resolves to nothing, the other name we hold beats
 *  "Merhaba ,". Author-written `{{lead.x|default}}` still wins over both. */
const NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'lead.contactPerson': ['lead.businessName'],
  'lead.businessName': ['lead.contactPerson'],
};

/** What one recipient's send means for its row. */
interface RecipientOutcome {
  /** SENT/SKIPPED/FAILED are terminal; RETRY puts the row back in the queue. */
  disposition: 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED';
  messageId?: string | null;
  error?: string;
  reason?: string;
  /** The cause is the workspace's, not this recipient's: the other 49 in this
   *  tick would hit it too, so stop asking. */
  stopTick?: boolean;
  /**
   * "Come back later", not "this failed". A send-window clamp or a daily cap
   * refuses with a time attached; the tick waits for it instead of counting
   * against the auto-pause streak, or a campaign launched at 3am would pause
   * itself three minutes later.
   */
  deferred?: boolean;
  retryAt?: Date | null;
}

/** Refusals that mean "not yet", with a time to come back at. */
const DEFERRED_REFUSALS: ReadonlySet<MailReason> = new Set<MailReason>(['QUIET_HOURS', 'DAILY_CAP']);

/** The facts a merge tag may read, resolved once per recipient. */
interface MergeContext {
  lead: Record<string, unknown>;
  workspace: { name: string };
}

/** The workspace facts one tick needs, read once at the top of it. */
interface WorkspaceFacts {
  status: string;
  settings?: unknown;
  name?: string | null;
}

/** One merge token's value, or '' — never an object stringified into a
 *  customer's mail. */
function mergeValue(field: string, ctx: MergeContext): string {
  const [root, ...rest] = field.split('.');
  let cur: unknown = (ctx as unknown as Record<string, unknown>)[root];
  for (const key of rest) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur == null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  if (cur instanceof Date) return cur.toISOString();
  return '';
}

/** Pair each link with its original index, ordered longest-first — so a tracked
 *  rewrite replaces a longer URL before a shorter URL that is its prefix, while
 *  the original index still drives the ?i= redirect lookup. */
function byLengthDesc(links: string[]): Array<{ url: string; i: number }> {
  return links.map((url, i) => ({ url, i })).sort((a, b) => b.url.length - a.url.length);
}

/** HTML-escape (used to match escaped hrefs in the compiled email HTML). */
function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Sends a SENDING campaign in throttled batches via the `campaign.batch`
 * ScheduledJob (dedupKey = campaignId → one batch in flight per campaign;
 * single-replica runner = no double-send). Opt-out is re-checked at send time
 * (the audience froze earlier); every message gets a mandatory unsubscribe
 * footer + click-tracked links. Email goes through the outbound gateway as
 * BULK — which is what decides who it is from, whether it may go at all, and
 * what a failure MEANT; SMS/WhatsApp/VOICE go via the channel adapter and the
 * NetGSM clients, with no per-recipient conversation (replies still land in the
 * inbox through the normal inbound webhook → ingress).
 *
 * What this file still owns, and deliberately did not hand over: the audience
 * claim (PENDING→SENDING, atomic, one owner per row), the batching cadence, the
 * A/B split and its winner decision, the İYS preflights, and `Campaign.stats`.
 */
@Injectable()
export class CampaignSenderService implements OnModuleInit {
  private readonly logger = new Logger(CampaignSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outboundMail: OutboundMailService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly quota: MessageQuotaService,
    private readonly smsV2: SmsV2Client,
    private readonly conversationSpend: ConversationSpendService,
    private readonly iysClient: IysClient,
    private readonly budgeter: AccountRateBudgeter,
    private readonly voicesmsSend: VoicesmsSendClient,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(CAMPAIGN_BATCH_KIND, (job) => this.batch(job), (job, error) => this.settleDeadLetter(job, error));
    this.runner.registerHandler(CAMPAIGN_AB_DECIDE_KIND, (job) => this.decideAbWinner(job));
    this.runner.registerHandler(CAMPAIGN_LAUNCH_KIND, (job) => this.launchScheduled(job), (job, error) => this.settleDeadLetter(job, error));
  }

  /**
   * The send job gave up — say so on the campaign instead of leaving it SENDING
   * forever (`campaign-dead-letter`).
   *
   * Under sustained load a tick's fifty-odd queries can time out on an
   * exhausted connection pool while the runner's single claim query keeps
   * succeeding; five ticks later the job is FAILED, the campaign is still
   * SENDING, the remaining recipients are still PENDING, the counters are
   * frozen at the partial count and there is nothing anywhere the tenant can
   * read. Pause-then-Resume already recovers it — nobody was ever told to try.
   *
   * PAUSED is the settled state precisely because `resume()` is the recovery:
   * it flips back to SENDING and kicks a fresh batch, and every remaining
   * recipient is still PENDING and still claimable.
   *
   * Three rules, each protecting a sibling path:
   *  - a **guarded updateMany**, never `update()`: a campaign that reached
   *    SENT/CANCELLED/PAUSED meanwhile must be untouched, and a campaign
   *    deleted meanwhile must be a no-op rather than a P2025 thrown out of a
   *    best-effort hook;
   *  - the reason goes in the **stats blob** (`Campaign` has no error column),
   *    merged spread-first like every other writer of that blob, so it cannot
   *    clobber `delivered`/`undelivered`/`iysBlocked`, which the DLR poller's
   *    rollup merges in independently;
   *  - it **never throws**. It runs after the runner has already written the
   *    DLQ row; a bell that cannot be rung must not disturb that bookkeeping.
   */
  private async settleDeadLetter(job: ClaimedJob, error: string): Promise<void> {
    const workspaceId = job.payload?.workspaceId as string | undefined;
    const campaignId = job.payload?.campaignId as string | undefined;
    if (!workspaceId || !campaignId) return;
    try {
      const claimed = await this.prisma.campaign.updateMany({
        where: { id: campaignId, workspaceId, status: 'SENDING' },
        data: { status: 'PAUSED' },
      });
      if (claimed.count === 0) return;
      const s = await this.currentStats(campaignId);
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          stats: { ...s, stalledError: error.slice(0, 300), stalledAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      });
      this.logger.error(`campaign ${campaignId} paused after its ${job.kind} job dead-lettered: ${error}`);
      await notifyCommerce(
        this.prisma,
        {
          workspaceId,
          type: CAMPAIGN_STALLED_NOTIFICATION,
          title: 'Campaign paused',
          message: 'The send stopped after repeated errors. Review it, then resume to continue.',
          metadata: { campaignId, kind: job.kind, error: error.slice(0, 300) },
        },
        this.logger,
      );
    } catch (e: unknown) {
      this.logger.warn(
        `campaign dead-letter settle skipped (campaign=${campaignId}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Fires at a SCHEDULED campaign's `scheduledAt` (queued by
   * CampaignsService.launch/update). Idempotent and count-independent by
   * design: a retry after a crash must never be a silent no-op. If the guarded
   * SCHEDULED→SENDING updateMany below claims count 0 because a PRIOR attempt
   * already flipped the row and then crashed before reaching the batch-job
   * schedule call, a naive "count 0 → return" here would re-enter, do nothing,
   * and let the runner mark the retry DONE (it doesn't throw) — stranding the
   * campaign SENDING forever with PENDING recipients and no batch job queued.
   * So the count is only used to attempt the flip; what happens next is
   * decided by re-reading the campaign's actual status, and every step past
   * that is safe to repeat: schedule()'s dedupKey lookup collapses onto the
   * existing PENDING row (updates runAt in place) instead of duplicating it.
   */
  private async launchScheduled(job: ClaimedJob): Promise<void> {
    const { workspaceId, campaignId } = job.payload;
    await this.prisma.campaign.updateMany({
      where: { id: campaignId, workspaceId, status: 'SCHEDULED' },
      data: { status: 'SENDING', startedAt: new Date() },
    });
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    // Neither just-flipped nor already SENDING from an earlier attempt — the
    // campaign was cancelled (or otherwise moved on) meanwhile. No-op.
    if (!campaign || campaign.status !== 'SENDING') return;

    // A/B WINNER mode: the test-cohort window is measured from the real send
    // start — mirrors launch()'s immediate path, just computed here instead of
    // at the original (pre-scheduledAt) freeze time. Only relevant if the
    // freeze actually held back a remainder (winnerMode). abDecideAt is
    // computed/persisted at most once: a retry that reaches this line again
    // must not shift the test window forward each time it re-enters.
    if ((campaign as any).abMode === 'WINNER') {
      const held = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'HOLD' } });
      if (held > 0) {
        let abDecideAt = (campaign as any).abDecideAt as Date | null;
        if (!abDecideAt) {
          abDecideAt = new Date(Date.now() + AB_TEST_WINDOW_MS);
          await this.prisma.campaign.update({ where: { id: campaignId }, data: { abDecideAt } });
        }
        await this.scheduledJobs.schedule({
          workspaceId, kind: CAMPAIGN_AB_DECIDE_KIND, runAt: abDecideAt, dedupKey: `ab-decide:${campaignId}`, payload: { workspaceId, campaignId },
        });
      }
    }
    // (Re-)ensure the batch job on every invocation — a retry that reaches this
    // line after an earlier attempt already scheduled (or half-scheduled) one
    // just collapses onto the same PENDING row.
    await this.scheduledJobs.schedule({
      workspaceId, kind: CAMPAIGN_BATCH_KIND, runAt: new Date(), dedupKey: campaignId, payload: { workspaceId, campaignId },
    });
  }

  /**
   * A/B WINNER mode: after the test window, pick the variant with the best
   * open/click RATE and release the held-back remainder to it. Atomic claim
   * (abWinnerKey:null) so only one decider releases the remainder.
   *
   * Rate, not raw counts (`ab-raw-counts`): weights are per-variant, so the
   * bigger cohort collects more opens while converting worse, and the raw
   * comparator handed the entire remainder to the loser. Below a real sample
   * the decision is still MADE — a HELD remainder never sends — but it is made
   * on the authored weight and SAID so, in the log and in `stats.abDecision`.
   */
  private async decideAbWinner(job: ClaimedJob): Promise<void> {
    const { workspaceId, campaignId } = job.payload;
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign || (campaign as any).abWinnerKey || campaign.status !== 'SENDING') return;
    // Recompute variant stats from the recipient rows FIRST. `campaignVariant.stats`
    // is otherwise only written at the end of a batch() pass — and in WINNER mode
    // no batch runs during the test window (the remainder is HELD), so the cached
    // stats are frozen at ~0 from when the test cohort was just sent. Without this
    // recompute the winner sort collapses to the alphabetical key tiebreak and the
    // bulk audience gets the wrong variant. (Opens/clicks accrue on the recipient
    // rows via the tracker; this rolls them up into the per-variant counts.)
    await this.recomputeStats(workspaceId, campaignId);
    const variants = await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId } });
    if (variants.length < 2) return;
    const metric = (campaign as any).abWinnerMetric === 'CLICK' ? 'clicked' : 'opened';
    const stat = (v: any, key: string) => Number((v?.stats as any)?.[key] ?? 0) || 0;
    // RATE, not raw counts. With weights 3:1 the bigger cohort collects more
    // opens while converting worse, and the raw comparator then rolled the
    // WORSE variant out to the entire held-back remainder (`ab-raw-counts`).
    // A variant whose sends all failed scores 0 rather than NaN: a comparator
    // that can return NaN makes Array.sort's output engine-dependent.
    const rate = (v: any) => {
      const sent = stat(v, 'sent');
      return sent > 0 ? stat(v, metric) / sent : 0;
    };
    // Alphabetical stays LAST so the existing deterministic no-data behaviour
    // is preserved.
    const byRate = [...variants].sort(
      (a, b) => rate(b) - rate(a) || stat(b, metric) - stat(a, metric) || (a.key < b.key ? -1 : 1),
    );
    const leader = byRate[0];

    // A decision must still be MADE even when the numbers cannot carry one —
    // leaving the remainder HELD strands the held-back majority forever — but
    // it must not be reported in the same words as a measured one.
    const bigEnough = variants.filter((v: any) => stat(v, 'sent') >= AB_MIN_SAMPLE).length >= 2;
    const enoughEvents = stat(leader, metric) >= AB_MIN_EVENTS;
    const anySignal = variants.some((v: any) => stat(v, metric) > 0);
    let basis: 'RATE' | 'INSUFFICIENT_SAMPLE' | 'NO_SIGNAL' = 'RATE';
    let winner = leader;
    if (!bigEnough || !enoughEvents) {
      basis = anySignal ? 'INSUFFICIENT_SAMPLE' : 'NO_SIGNAL';
      // The heaviest variant, not the control: `campaign.body` is usually a
      // placeholder in an A/B campaign, so falling back to it would mail the
      // remainder something nobody wrote for them.
      winner = [...variants].sort(
        (a: any, b: any) => (Number(b.weight) || 0) - (Number(a.weight) || 0) || (a.key < b.key ? -1 : 1),
      )[0];
      this.logger.warn(
        basis === 'NO_SIGNAL'
          ? `campaign ${campaignId} A/B: no ${metric} signal on any variant — releasing to '${winner.key}' by the authored weight, not by measurement`
          : `campaign ${campaignId} A/B: too small a sample to call a ${metric} winner — releasing to '${winner.key}' by the authored weight`,
      );
    }
    const claimed = await this.prisma.campaign.updateMany({
      where: { id: campaignId, workspaceId, abWinnerKey: null, status: 'SENDING' },
      data: { abWinnerKey: winner.key },
    });
    if (claimed.count === 0) return; // a concurrent decide already released the remainder
    // Write down WHY, so the tenant can audit a decision that reaches the
    // majority of their audience. Merged spread-first, like every other writer
    // of this blob.
    const s = await this.currentStats(campaignId);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          ...s,
          abDecision: {
            metric,
            basis,
            winner: winner.key,
            decidedAt: new Date().toISOString(),
            variants: variants.map((v: any) => ({
              key: v.key,
              sent: stat(v, 'sent'),
              opened: stat(v, 'opened'),
              clicked: stat(v, 'clicked'),
              rate: rate(v),
            })),
          },
        } as Prisma.InputJsonValue,
      },
    });
    await this.prisma.campaignRecipient.updateMany({
      where: { workspaceId, campaignId, status: 'HOLD' },
      data: { status: 'PENDING', variantKey: winner.key },
    });
    this.logger.log(`campaign ${campaignId} A/B winner: variant ${winner.key} (by ${metric})`);
    await this.scheduledJobs.schedule({
      workspaceId, kind: CAMPAIGN_BATCH_KIND, runAt: new Date(), dedupKey: campaignId, payload: { workspaceId, campaignId },
    });
  }

  private async batch(job: ClaimedJob): Promise<void> {
    const { workspaceId, campaignId } = job.payload;
    const campaign = await this.prisma.campaign.findFirst({ where: { id: campaignId, workspaceId } });
    if (!campaign || campaign.status !== 'SENDING') return;

    // The workspace kill switch, BEFORE the PENDING→SENDING claim.
    //
    // This is the one place the gateway's own gate is not enough. Suspending a
    // workspace zeroes its entitlements, so the per-recipient reserve refuses —
    // and every refusal used to become a permanent FAILED row. FAILED rows are
    // never re-sent, so a temporary suspension permanently burned a paying
    // customer's remaining audience. Skipping the whole tick instead leaves
    // every recipient PENDING and self-heals the moment the workspace is
    // re-activated, the same shape as `ticariLegacyBlocked` below
    // (`suspension-doesnt-stop`).
    const ws = await this.loadWorkspace(workspaceId);
    const blocked = this.sendingBlocked(ws, campaign.channel);
    if (blocked) {
      this.logger.warn(`campaign ${campaignId}: tick skipped — ${blocked}`);
      return;
    }

    // Reclaim recipients stranded in SENDING by a prior batch that crashed
    // between the PENDING→SENDING claim and the SENT/FAILED mark. The batch
    // below selects only PENDING, so without this they'd be silently dropped
    // (and the campaign reported SENT). Safe: the job dedups on campaignId, so
    // only one batch per campaign runs at a time — any SENDING here is stale.
    await this.prisma.campaignRecipient.updateMany({
      where: { workspaceId, campaignId, status: 'SENDING' },
      data: { status: 'PENDING' },
    });

    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { workspaceId, campaignId, status: 'PENDING' },
      take: BATCH_SIZE,
    });
    if (recipients.length === 0) {
      // A/B WINNER mode: the test cohort is sent but the remainder is still HELD
      // awaiting the winner decision — the campaign is NOT done yet.
      const held = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'HOLD' } });
      if (held > 0) {
        await this.rearmAbDecide(workspaceId, campaign);
        return; // leave SENDING; the ab.decide job releases the remainder
      }
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', completedAt: new Date() } });
      return;
    }

    const links = (Array.isArray(campaign.links) ? campaign.links : []) as string[];

    // A/B: a recipient's variantKey selects that variant's subject/body/html.
    const variants = (campaign as any).abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId } })
      : [];
    const variantByKey = new Map(variants.map((v: any) => [v.key, v]));

    // SMS true n:n batching: resolve the active SMS channel ONCE per tick (not
    // per recipient) so eligible recipients can be collected and sent via a
    // SINGLE SmsV2Client.send call instead of N adapter round-trips. A channel
    // that opted back into the legacy GET API (`useLegacySend`), one with
    // incomplete secrets, or a missing/inactive channel all fall through to the
    // existing per-recipient `this.send()` path unchanged (it re-resolves the
    // channel itself and fails/legacy-sends exactly as it does today).
    let smsV2Config: ResolvedChannelConfig | null = null;
    if (campaign.channel === 'SMS') {
      const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
      if (ch) {
        const resolved = this.registry.resolveConfig(ch);
        const { usercode, password, msgheader } = resolved.secrets;
        if (resolved.public?.useLegacySend !== true && usercode && password && msgheader) {
          smsV2Config = resolved;
        }
      }
    }

    // TİCARİ hard-block, legacy-channel case (owner decision: fail-closed for
    // TİCARİ — see iysPreflight's docstring for the same contract on the REST
    // v2 path). The legacy per-recipient path (this.send() → NetgsmSmsAdapter's
    // legacy /sms/send/get) has NO İYS search and no iysfilter at all —
    // iysPreflight/sendSmsBatch only ever run when `smsV2Config` is set. A
    // TİCARİ campaign stuck here (channel opted back into useLegacySend, or
    // missing v2 creds/msgheader) can never prove İYS consent, so the whole
    // tick is skipped BEFORE the per-recipient claim loop below ever runs —
    // nothing in `recipients` gets claimed (PENDING→SENDING) or sent this
    // tick. Falling through to the normal end-of-batch() flow (recomputeStats
    // + the `remaining > 0` reschedule) means this retries every tick, same
    // self-healing shape as abortTicariTick's revert-to-PENDING, until ops
    // fixes the channel config. BİLGİLENDİRME campaigns are unaffected — only
    // TİCARİ requires proof of consent — so they still fall through to the
    // legacy loop below exactly as before.
    const ticariLegacyBlocked =
      campaign.channel === 'SMS' && campaign.iysMessageType === 'TICARI' && !smsV2Config;
    if (ticariLegacyBlocked) {
      this.logger.warn(
        `campaign ${campaignId}: TİCARİ campaign cannot run on a legacy-send channel — İYS preflight requires REST v2`,
      );
      await this.abortTicariTick(workspaceId, campaignId, []);
    }

    // VOICE (NetGSM Phase 5): `/voicesms/send` authenticates with the SAME
    // usercode/password as the SMS REST APIs — there is no separate
    // "VOICE channel" row for this (Channel.type==='VOICE' is a DIFFERENT,
    // unrelated feature: the Twilio-based AI voice-agent bridge). Reuse the
    // ACTIVE SMS channel's account exactly like NetgsmVoicemailPollService
    // already does for the sibling receive-side voicesms client.
    let voiceConfig: { usercode: string; password: string; brandCode: string } | null = null;
    if (campaign.channel === 'VOICE') {
      const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
      if (ch) {
        const resolved = this.registry.resolveConfig(ch);
        const { usercode, password } = resolved.secrets;
        if (usercode && password) {
          voiceConfig = {
            usercode,
            password,
            brandCode: typeof resolved.public?.brandCode === 'string' ? (resolved.public.brandCode as string).trim() : '',
          };
        }
      }
    }

    // No usercode/password resolvable at all this tick (no ACTIVE SMS
    // channel, or its secrets are incomplete) — voicesms/send has no
    // anonymous mode, so nothing can be sent regardless of İYS
    // classification. Mirrors `ticariLegacyBlocked`'s "the whole tick has
    // nothing it CAN do" shape: the claim loop below never runs for VOICE
    // this tick, and it self-heals (retries every tick) once ops fixes the
    // channel. A brandCode that's present-but-missing is a DIFFERENT,
    // TİCARİ-only case, checked inside iysArmaPreflight below — mirroring
    // iysPreflight's own brandCode gate for SMS.
    const voiceCredsBlocked = campaign.channel === 'VOICE' && !voiceConfig;
    if (voiceCredsBlocked) {
      this.logger.warn(
        `campaign ${campaignId}: VOICE campaign cannot run this tick — no ACTIVE SMS channel with usercode/password resolvable (voicesms/send reuses that account's credentials)`,
      );
    }

    const eligibleSms: Array<{ recipientId: string; phone: string; body: string }> = [];
    const eligibleVoice: Array<{ recipientId: string; phone: string; msg?: string }> = [];

    // What this tick actually achieved, for the retry bound below: a tick that
    // sends nothing and keeps putting rows back in the queue is the shape that
    // loops forever.
    let sentInLoop = 0;
    let revertedInLoop = 0;
    let lastFailReason: string | undefined;
    /** A send-window clamp asked us to come back at a particular time. */
    let deferUntil: Date | null = null;
    /** How many rows this tick actually claimed — the forward-progress guard. */
    let claimedInLoop = 0;
    const deadline = Date.now() + BATCH_BUDGET_MS;

    for (const r of ticariLegacyBlocked || voiceCredsBlocked ? [] : recipients) {
      // Hand the lock back rather than hold it for the rest of the audience
      // (`batches-stall-runner`). `break`, never `return`: the tail below
      // settles the batched SMS/VOICE sends whose quota is already reserved,
      // recomputes the stats and reschedules the remainder — a `return` would
      // strand all three. At least one row is always attempted, so a tick can
      // never make zero progress and re-queue the same rows forever.
      if (claimedInLoop > 0 && Date.now() >= deadline) {
        this.logger.debug(`campaign ${campaignId}: tick budget spent after ${claimedInLoop} recipient(s) — resuming next tick`);
        break;
      }
      // Atomic claim: a concurrent batch — e.g. a slow run reaped after 15 min and
      // re-dispatched while still in flight — that re-read the same PENDING rows
      // cannot also process this recipient. Only one updateMany flips PENDING→
      // SENDING; the loser sees count 0 and skips, so no double-send / double-meter.
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, workspaceId, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      if (claim.count === 0) continue;
      claimedInLoop += 1;

      // Exclude a lead bulk-deleted (deletedAt) or merged-away (mergedIntoId)
      // AFTER the audience froze: bulk-delete means "stop contacting", and a
      // merged tombstone would double-send to the merge target's same address.
      // Such a lead resolves to null here → SKIPPED (mirrors opt-out).
      const lead = await this.prisma.lead.findFirst({
        where: { id: r.leadId, workspaceId, deletedAt: null, mergedIntoId: null },
      });
      const to = this.recipientAddress(campaign.channel, lead);
      if (!lead || this.isOptedOut(campaign.channel, lead) || !to) {
        await this.mark(r.id, 'SKIPPED');
        continue;
      }

      // The merge context, resolved once per recipient and shared by every
      // sink below (subject, plain text, HTML, and the VOICE TTS line).
      const merge: MergeContext = {
        lead: lead as unknown as Record<string, unknown>,
        workspace: { name: ws?.name ?? '' },
      };

      // VOICE: no body/variant rendering — the TTS text/audioid lives in
      // campaign.voiceConfig, not campaign.body (which VOICE only uses as a
      // display label), and there is no unsubscribe-footer concept for a
      // phone call. `voicesms/send` has no batch shape (unlike
      // SmsV2Client.send), so collect for the per-recipient loop below
      // rather than a single batched call. `voiceConfig` is guaranteed
      // non-null here — `voiceCredsBlocked` already forced this loop to `[]`
      // otherwise.
      if (campaign.channel === 'VOICE') {
        try {
          await this.quota.reserve(workspaceId, 'VOICE');
        } catch (e: any) {
          await this.mark(r.id, 'FAILED', { error: (e?.message ?? String(e)).slice(0, 300) });
          continue;
        }
        // The lead is in scope HERE and nowhere else on the voice path —
        // `sendVoice` only ever sees `{recipientId, phone}`, which is why the
        // TTS line used to read "{{lead.contactPerson}}" aloud, brace by
        // brace. Resolve it now and carry it (`merge-tags-literal`).
        const spoken = voiceMessage(campaign.voiceConfig);
        eligibleVoice.push({
          recipientId: r.id,
          phone: to,
          ...(spoken ? { msg: this.interpolate(spoken, merge) } : {}),
        });
        continue;
      }

      // Resolve this recipient's content: their assigned A/B variant if any,
      // else the campaign control.
      const variant = (r as any).variantKey ? variantByKey.get((r as any).variantKey) : null;
      const srcBody = variant ? (variant as any).body : campaign.body;
      const srcSubject = variant ? ((variant as any).subject ?? campaign.subject) : campaign.subject;
      // A variant without its own HTML inherits the campaign's — so an HTML
      // campaign's A/B test varies the subject (+ plain-text part) rather than
      // silently degrading variant recipients to plain text.
      const srcHtml = variant ? ((variant as any).bodyHtml ?? (campaign as any).bodyHtml) : (campaign as any).bodyHtml;

      // Merge tags, BEFORE render()/renderHtml(): the tracked-link, unsubscribe
      // and open-pixel URLs those two inject contain no braces, so they are
      // untouched, and a lead value that itself contains `{{` cannot recurse.
      // This is also the point where the A/B variant fields were resolved, so
      // one insertion point covers control AND variants.
      //
      // The HTML part is escaped and the plain-text part is NOT. That asymmetry
      // is the contract: `renderEmailHtml` already escaped every author-written
      // character, so a raw lead value dropped into the compiled document
      // corrupts or injects — while HTML-escaping the text/SMS body would turn
      // "Ben & Jerry's" into "Ben &amp; Jerry&#39;s" in a plain-text sink.
      const mergedSubject = srcSubject ? this.interpolate(srcSubject as string, merge) : srcSubject;
      const mergedBody = this.interpolate((srcBody ?? '') as string, merge);
      const mergedHtml = srcHtml ? this.interpolate(srcHtml as string, merge, esc) : srcHtml;

      const body = this.render(campaign.channel, mergedBody, r.token, links);
      // EMAIL campaigns built with the block editor carry an HTML body; render it
      // (tracked links + HTML unsubscribe footer) and send it as the html part.
      const html =
        campaign.channel === 'EMAIL' && mergedHtml
          ? this.renderHtml(mergedHtml as string, r.token, links)
          : undefined;
      if (smsV2Config) {
        // Defer the actual send: reserve this recipient's quota now (as today —
        // reserve→send stays paired so a later batch-level failure can refund
        // it), then collect for the single batched SmsV2Client.send call below.
        try {
          await this.quota.reserve(workspaceId, 'SMS');
        } catch (e: any) {
          await this.mark(r.id, 'FAILED', { error: (e?.message ?? String(e)).slice(0, 300) });
          continue;
        }
        eligibleSms.push({ recipientId: r.id, phone: to, body });
        continue;
      }

      // The recipient's own token: it is what the unsubscribe header points at,
      // and what identifies WHO opted out when they use it.
      const outcome =
        campaign.channel === 'EMAIL'
          ? await this.sendEmail({
              workspaceId,
              campaignId,
              recipientId: r.id,
              leadId: lead.id,
              to,
              subject: (mergedSubject as string | null) ?? 'Update',
              text: body,
              ...(html ? { html } : {}),
              token: r.token,
              ticari: (campaign as any).iysMessageType === 'TICARI',
            })
          : legacyOutcome(await this.send(workspaceId, campaign.channel, to, body));

      if (outcome.disposition === 'RETRY') {
        if (outcome.deferred) {
          // Waiting for a window to open is not a failure, so it does not feed
          // the auto-pause streak — it moves the next tick instead.
          deferUntil = outcome.retryAt ?? deferUntil;
        } else {
          revertedInLoop += 1;
          lastFailReason = outcome.reason ?? lastFailReason;
        }
        await this.revertClaim(workspaceId, campaignId, r.id, outcome.error);
        // The next 49 recipients of this tick would hit the same wall.
        if (outcome.stopTick) break;
        continue;
      }
      if (outcome.disposition === 'SKIPPED') {
        await this.mark(r.id, 'SKIPPED', outcome.error ? { error: outcome.error.slice(0, 300) } : {});
        continue;
      }
      if (outcome.disposition === 'SENT') {
        sentInLoop += 1;
        await this.mark(r.id, 'SENT', { messageId: outcome.messageId ?? null, sentAt: new Date() });
        if (campaign.channel === 'SMS') {
          // Legacy per-recipient path (channel opted back into useLegacySend, or
          // v2 preconditions weren't met — see the smsV2Config resolution
          // above): this bypasses sendSmsBatch()'s settlement entirely, so
          // settle here instead. Same ref (recipientId) as the v2 batch path,
          // so debitOnce dedups — best-effort: a pricing/ledger blip must not
          // fail an already-sent, already-marked message.
          await this.conversationSpend
            .settleCampaignSms(workspaceId, { recipientId: r.id, text: body })
            .catch((err) =>
              this.logger.warn(
                `legacy campaign SMS settlement failed for recipient ${r.id}: ${String((err as Error)?.message ?? err)}`,
              ),
            );
        }
        continue;
      }
      lastFailReason = outcome.reason ?? lastFailReason;
      await this.mark(r.id, 'FAILED', { error: outcome.error?.slice(0, 300) });
    }

    if (smsV2Config && eligibleSms.length > 0) {
      await this.sendSmsBatch(workspaceId, campaignId, campaign, smsV2Config, eligibleSms);
    }

    if (voiceConfig && eligibleVoice.length > 0) {
      await this.sendVoice(workspaceId, campaignId, campaign, voiceConfig, eligibleVoice);
    }

    await this.recomputeStats(workspaceId, campaignId);

    // Bound the retry. Without this, "revert to PENDING" is an infinite 60s
    // loop: an exhausted quota or a rotated mailbox password stays true, so the
    // same batch re-queues itself forever against the same wall. Three
    // consecutive ticks that sent nothing and put rows back is enough evidence
    // to stop and say so (`campaign-failures-terminal`).
    //
    // Only a tick that actually got somewhere — or actually got nowhere — has
    // anything to say about the streak. The batched SMS/VOICE paths settle
    // their own rows outside this loop and never move these counters, so they
    // pay neither the read nor the write.
    if (revertedInLoop > 0 || sentInLoop > 0) {
      if (await this.settleFailStreak(workspaceId, campaignId, sentInLoop, revertedInLoop, lastFailReason)) return;
    }

    const remaining = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'PENDING' } });
    if (remaining > 0) {
      // The ordinary cadence, unless a send-window clamp named a later time to
      // come back at — retrying every 60s against a window that opens at 09:00
      // is 400 pointless ticks and 400 more refusals in the ledger.
      const next = new Date(Date.now() + BATCH_INTERVAL_SEC * 1000);
      await this.scheduledJobs.schedule({
        workspaceId,
        kind: CAMPAIGN_BATCH_KIND,
        runAt: deferUntil && deferUntil.getTime() > next.getTime() ? deferUntil : next,
        dedupKey: campaignId,
        payload: { workspaceId, campaignId },
      });
    } else {
      // A/B WINNER: draining the test cohort to 0 PENDING does NOT complete the
      // campaign while the remainder is still HELD awaiting the winner decision.
      // Mirror the empty-batch guard at the top of batch() — without this, the
      // batch that sends the LAST test-cohort recipient marks the campaign SENT,
      // and the later ab.decide job (which requires status=SENDING) then bails,
      // stranding the held-back majority so they are NEVER sent.
      const held = await this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, status: 'HOLD' } });
      if (held > 0) {
        await this.rearmAbDecide(workspaceId, campaign);
        return;
      }
      await this.prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', completedAt: new Date() } });
    }
  }

  /**
   * The winner decision, re-armed.
   *
   * A pause that spans the decision time leaves the decide job spent and the
   * remainder HELD forever: `decideAbWinner` refuses a non-SENDING campaign, so
   * the job runs, no-ops, and is gone (`ab-pause-strands`). Resuming kicks a
   * batch, and a batch that finds a HELD remainder with no winner is exactly
   * the moment to arm it again. It also covers a decide job lost some other way
   * (DLQ'd after maxAttempts, row deleted).
   *
   * LOAD-BEARING: `runAt` is the PERSISTED `abDecideAt`, never `now + window`.
   * Repeated pause/resume would otherwise push the decision forward forever,
   * and when the pause happened before the window elapsed the original job row
   * is still PENDING — `ScheduledJobService.schedule` updates that row's runAt
   * in place, so passing the stored time makes a correctly-armed decision a
   * harmless no-op write. A past `abDecideAt` is fine: the runner claims
   * `runAt <= now`.
   */
  private async rearmAbDecide(workspaceId: string, campaign: any): Promise<void> {
    if (campaign?.abMode !== 'WINNER' || campaign.abWinnerKey) return;
    await this.scheduledJobs.schedule({
      workspaceId,
      kind: CAMPAIGN_AB_DECIDE_KIND,
      runAt: (campaign.abDecideAt as Date | null) ?? new Date(),
      dedupKey: `ab-decide:${campaign.id}`,
      payload: { workspaceId, campaignId: campaign.id },
    });
  }

  /** The workspace facts one tick needs. Unreadable is not a reason to stop a
   *  tenant's campaign — it is a reason to say so and carry on as before. */
  private async loadWorkspace(workspaceId: string): Promise<WorkspaceFacts | null> {
    try {
      return await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { status: true, settings: true, name: true },
      });
    } catch (e: any) {
      this.logger.warn(`campaign tick: workspace read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /** Why this tick may not send, or null. `settings.email.paused` is an EMAIL
   *  switch and must not silence a tenant's SMS. */
  private sendingBlocked(ws: WorkspaceFacts | null, channel: string): string | null {
    if (!ws) return null;
    if (ws.status !== 'ACTIVE') return `workspace is ${ws.status}, not ACTIVE`;
    if (channel === 'EMAIL' && emailPaused(ws.settings)) return 'email sending is paused for this workspace';
    return null;
  }

  /**
   * Put one claimed recipient back in the queue.
   *
   * The compound WHERE is the whole point. Between the claim and here the
   * tracking service can flip the row to a terminal state — UNSUBSCRIBED, from
   * an opt-out processed concurrently — and an id-only WHERE would stomp that
   * back to PENDING and re-mail somebody who just opted out. That turns a retry
   * fix into a consent breach. The provider's own line rides along so the row
   * still says WHY it is waiting.
   */
  private async revertClaim(workspaceId: string, campaignId: string, id: string, error?: string): Promise<void> {
    await this.prisma.campaignRecipient.updateMany({
      where: { id, workspaceId, campaignId, status: 'SENDING' },
      data: { status: 'PENDING', ...(error ? { error: error.slice(0, 300) } : {}) },
    });
  }

  /**
   * Count the consecutive ticks that achieved nothing, and pause at the limit.
   *
   * Returns true when the campaign was paused, so the caller stops before
   * queueing another tick. The counter lives in `Campaign.stats` (merged
   * spread-first, like every other writer of that blob) rather than in a new
   * column, and it is only ever written when it CHANGES — a healthy campaign's
   * stats blob gains no key it never had.
   */
  private async settleFailStreak(
    workspaceId: string,
    campaignId: string,
    sent: number,
    reverted: number,
    reason?: string,
  ): Promise<boolean> {
    const s = await this.currentStats(campaignId);
    const current = Number(s.failStreak) || 0;
    if (sent > 0 || reverted === 0) {
      // Any progress at all clears it: the streak is about ticks that are
      // getting nowhere, not about individual failures.
      if (current === 0) return false;
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { stats: { ...s, failStreak: 0 } as Prisma.InputJsonValue },
      });
      return false;
    }

    const streak = current + 1;
    if (streak < FAIL_STREAK_LIMIT) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { stats: { ...s, failStreak: streak } as Prisma.InputJsonValue },
      });
      return false;
    }

    // Guarded on SENDING: a campaign cancelled or completed meanwhile must not
    // be resurrected into PAUSED by a tick that was already in flight.
    const paused = await this.prisma.campaign.updateMany({
      where: { id: campaignId, workspaceId, status: 'SENDING' },
      data: {
        status: 'PAUSED',
        stats: { ...s, failStreak: streak, pauseReason: reason ?? 'SEND_FAILURES' } as Prisma.InputJsonValue,
      },
    });
    if (paused.count > 0) {
      this.logger.warn(
        `campaign ${campaignId} auto-paused after ${streak} ticks that sent nothing (${reason ?? 'send failures'}) — recipients are left PENDING and resume where they stopped`,
      );
    }
    return paused.count > 0;
  }

  private isOptedOut(channel: string, lead: any): boolean {
    // EMAIL reads all three deliverability columns, not just the opt-out. The
    // audience froze at launch; a lead that hard-bounced or was verified
    // INVALID since then is an address `MailGuardService` refuses anyway, so
    // sending buys nothing, spends a metered message and costs another point of
    // reputation on a shared relay. The other channels keep their own single
    // flag — an unconditional check would silently skip an SMS or a VOICE
    // recipient whose EMAIL happens to be bad.
    if (channel === 'EMAIL') {
      return !!lead.emailOptOut || !!lead.emailBouncedAt || lead.emailVerifiedStatus === 'INVALID';
    }
    if (channel === 'SMS') return !!lead.smsOptOut;
    if (channel === 'WHATSAPP') return !!lead.waOptOut;
    // VOICE (NetGSM Phase 5): Lead has no dedicated call/voice opt-out flag
    // yet — reuse smsOptOut as the nearest proxy (both channels ring the
    // same lead phone number). A dedicated callOptOut/voiceOptOut column is
    // a follow-up; until then, the TİCARİ ARAMA İYS preflight below is the
    // authoritative compliance gate for commercial voice sends anyway.
    if (channel === 'VOICE') return !!lead.smsOptOut;
    return false;
  }

  private recipientAddress(channel: string, lead: any): string | null {
    if (!lead) return null;
    if (channel === 'EMAIL') return lead.email ?? null;
    if (channel === 'SMS') return lead.phone ?? null;
    if (channel === 'WHATSAPP') return lead.whatsapp || lead.phone || null;
    if (channel === 'VOICE') return lead.phone ?? null;
    return null;
  }

  /**
   * One campaign email, through the one gate every mail in the product passes.
   *
   * What used to live here — resolve the workspace mailbox, else a verified
   * sending domain, else the platform transport; build the unsubscribe header;
   * park the mailer's last error for one read — is the gateway's job now, and
   * three other callers had their own half-remembered copy of the same ladder.
   * What stays here is the campaign's own accounting: the reserve/refund
   * pairing this file has always owned (hence `alreadyMetered`, so the gate
   * does not charge a second unit for the same mail), and the translation of a
   * receipt into what this recipient's row should become.
   *
   * Nothing below throws. A gateway refusal is an outcome, not an exception —
   * the old shape turned `MESSAGES_EXHAUSTED` into a thrown error the outer
   * catch wrote onto the recipient row as a permanent FAILED.
   */
  private async sendEmail(input: {
    workspaceId: string;
    campaignId: string;
    recipientId: string;
    leadId: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    /** The recipient's own token: it is what the unsubscribe header points at,
     *  and what identifies WHO opted out when they use it. */
    token: string;
    ticari: boolean;
  }): Promise<RecipientOutcome> {
    const base = this.linkBase();
    // The unsubscribe link is mandatory and is built from the link base; if it
    // is unset the rendered body has no opt-out, so refuse to send rather
    // than ship non-compliant mail (a misconfigured deploy fails closed). It is
    // a deploy problem, not this recipient's, so the row waits rather than dies.
    if (!base) {
      return {
        disposition: 'RETRY',
        stopTick: true,
        reason: 'MISSING_PUBLIC_BASE_URL',
        error: 'PUBLIC_BASE_URL not configured (unsubscribe link required)',
      };
    }

    try {
      await this.quota.reserve(input.workspaceId, 'EMAIL');
    } catch (e: any) {
      // An exhausted plan is the workspace's condition, not this lead's: the
      // rest of the audience would hit it too, and FAILED rows never re-send.
      return {
        disposition: 'RETRY',
        stopTick: true,
        reason: e?.response?.code ?? e?.code ?? 'QUOTA_EXHAUSTED',
        error: (e?.message ?? String(e)).slice(0, 300),
      };
    }

    let receipt: MailReceipt;
    try {
      receipt = await this.outboundMail.send({
        workspaceId: input.workspaceId,
        mailClass: 'BULK',
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        leadId: input.leadId,
        // The header's URI is the SAME link the body already carries — same
        // base, same token as render()/renderHtml() used — so the gateway
        // recognises the footer the body has and does not add a second one.
        unsubscribe: { token: input.token, url: `${base}/api/public/u/${input.token}` },
        ticari: input.ticari,
        source: `campaign:${input.campaignId}`,
        // A real domain key, not a content hash: it closes the crash window
        // between "the relay accepted it" and "we marked the row SENT", where
        // the stranded-SENDING sweep would otherwise re-mail the recipient.
        // Only a row that really SENT dedupes; a refused or failed attempt
        // reopens the same ledger row.
        idempotencyKey: `campaign:${input.recipientId}`,
        alreadyMetered: true,
      });
    } catch (e: any) {
      // The gateway is documented never to throw; this keeps a broken promise
      // from leaking a reserved message unit.
      await this.quota.refund(input.workspaceId, 'EMAIL');
      return { disposition: 'RETRY', reason: 'TRANSIENT', error: (e?.message ?? String(e)).slice(0, 300) };
    }

    // A message that never reached anybody is not charged for — a refusal
    // least of all. DEDUPED counts as "never reached anybody" HERE even though
    // it is `ok`: the mail it refers to was delivered and metered on the
    // earlier attempt, and this attempt dispatched nothing. Keyed on `!ok`
    // instead, a recipient re-queued by the stranded-SENDING sweep debits a
    // second unit of the tenant's monthly allowance for one delivered email,
    // invisibly — the ledger still shows a single SENT MailLog row. The
    // gateway cannot compensate for us either: we send `alreadyMetered`, and
    // `MailGuardService.refundQuota` returns early on that flag by design.
    if (receipt.outcome !== 'SENT') await this.quota.refund(input.workspaceId, 'EMAIL');
    return outcomeFor(receipt);
  }

  private async send(
    workspaceId: string, channel: string, to: string, body: string,
  ): Promise<{ ok: boolean; messageId?: string | null; error?: string }> {
    try {
      // The unsubscribe link is mandatory and is built from the link base; if
      // it is unset the rendered body has no opt-out, so refuse to send rather
      // than ship non-compliant mail (a misconfigured deploy fails closed).
      // Checked on the base `render()` actually uses, never on PUBLIC_BASE_URL
      // alone, or a links-host-only deploy would refuse mail it could render.
      if (!this.linkBase()) {
        return { ok: false, error: 'PUBLIC_BASE_URL not configured (unsubscribe link required)' };
      }
      const channelType = channel === 'SMS' ? 'SMS' : 'WHATSAPP';
      const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: channelType, status: 'ACTIVE' } });
      if (!ch) return { ok: false, error: `no active ${channelType} channel` };
      // Reserve→send must be paired: if the adapter THROWS (network/provider
      // error), the reserved quota would otherwise leak. Refund on throw too,
      // mirroring the explicit result.status==='FAILED' refund below.
      await this.quota.reserve(workspaceId, channelType);
      try {
        const result = await this.registry.get(channelType).send({ config: this.registry.resolveConfig(ch), to, text: body });
        if (result.status === 'FAILED') {
          await this.quota.refund(workspaceId, channelType);
          return { ok: false, error: result.error };
        }
        return { ok: true, messageId: result.externalMessageId };
      } catch (e: any) {
        await this.quota.refund(workspaceId, channelType);
        return { ok: false, error: e?.message ?? String(e) };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  /**
   * ONE `SmsV2Client.send` call carrying every SENDABLE recipient of this tick
   * (true n:n — each message keeps its own already-rendered body + referansId)
   * instead of the N adapter round-trips the per-recipient path would cost.
   * Quota for every recipient in `eligible` was already reserved in the claim
   * loop above; `iysPreflight` refunds the reservation for anyone it pulls
   * OUT of the send (blocked/deferred/aborted) before we ever get here, so
   * the remaining batch-level refund below only ever covers `sendable`.
   * `iysfilter` is the commercial/informational passthrough — '11' for
   * TICARI, '0' otherwise. NOTE: `SmsV2SendRequest` (sms-v2.client.ts) has no
   * `brandcode` field today, so the v2 send itself cannot thread it through —
   * defense-in-depth server-side enforcement is via `iysfilter` alone until
   * that request shape is extended (tracked as a follow-up, out of this
   * task's scope).
   */
  private async sendSmsBatch(
    workspaceId: string,
    campaignId: string,
    campaign: { iysMessageType?: string | null; netgsmJobIds?: unknown },
    config: ResolvedChannelConfig,
    eligible: Array<{ recipientId: string; phone: string; body: string }>,
  ): Promise<void> {
    const { usercode, password, msgheader } = config.secrets;
    const isTicari = campaign.iysMessageType === 'TICARI';
    const iysfilter = isTicari ? '11' : '0';

    let sendable = eligible;
    if (isTicari) {
      const cleared = await this.iysPreflight(workspaceId, campaignId, config, eligible);
      // null = hard fail-closed abort: iysPreflight already reverted every
      // claimed recipient to PENDING, refunded their quota, and stamped
      // iysUnavailable — nothing left to do this tick.
      if (cleared === null) return;
      sendable = cleared;
      // Everyone was blocked (RET/YOK) or deferred (budget exhausted) this
      // tick — iysPreflight already handled their side effects; there's
      // simply nobody left to hand to SmsV2Client.send.
      if (sendable.length === 0) return;
    }

    let result: SmsV2SendResult;
    try {
      result = await this.smsV2.send(
        { usercode, password },
        {
          msgheader,
          messages: sendable.map((e) => ({ msg: e.body, no: e.phone, referansId: e.recipientId })),
          iysfilter,
        },
      );
    } catch (e: any) {
      // SmsV2Client.send is documented to never throw (every outcome resolves
      // to an ok:false result) — this is a defensive backstop only. Treat it
      // like any other non-retriable batch failure: nothing is known to have
      // been sent, so fail closed rather than silently drop the batch.
      result = { ok: false, code: '', jobid: null, message: e?.message ?? String(e), retriable: false, transport: false };
    }

    if (result.ok) {
      const jobid = result.jobid;
      const ids = sendable.map((e) => e.recipientId);
      // ONE atomic guarded UPDATE for the whole batch — not N Promise.all(update())
      // calls. The N-call form left a crash-between-marks window: if the process
      // died after marking some rows SENT but before the rest, the still-SENDING
      // survivors get reclaimed to PENDING by the stranded-SENDING sweep at the
      // top of batch() and RESENT on the next tick — up to BATCH_SIZE (50)
      // duplicate billed SMS from a single crash (the old per-recipient path's
      // window was ≤1 message). Guarding on status:'SENDING' (this claim's
      // current state) makes the marks all-or-nothing in one round-trip: either
      // every row here flips to SENT together, or — if the process crashes
      // before this statement commits — none do, and the reclaim sweep retries
      // the whole batch next tick, which is safe because nothing was actually
      // double-sent.
      //
      // Residual, irreducible window: a crash between NetGSM accepting the
      // batch (this jobid returned) and this statement committing still leaves
      // the rows in SENDING, gets reclaimed to PENDING, and RESENDS the whole
      // batch — no single statement on our side can close a gap that spans two
      // systems (the wire send and our own mark). Task 6's DLR reconciliation
      // (which correlates provider report rows back by referansId = this
      // recipient's own id) is the backstop to detect/report such a duplicate
      // after the fact; a future provider-side dedupe keyed on referansId
      // before resending an unresolved jobid would close it further.
      await this.prisma.$executeRaw`
        UPDATE "campaign_recipients"
           SET "status" = 'SENT', "messageId" = ${jobid}, "netgsmJobId" = ${jobid},
               "referansId" = "id", "sentAt" = NOW()
         WHERE "id" = ANY(${ids}) AND "workspaceId" = ${workspaceId}
           AND "campaignId" = ${campaignId} AND "status" = 'SENDING'
      `;
      if (jobid) {
        const existing = Array.isArray(campaign.netgsmJobIds) ? (campaign.netgsmJobIds as string[]) : [];
        if (!existing.includes(jobid)) {
          await this.prisma.campaign.update({
            where: { id: campaignId },
            data: { netgsmJobIds: [...existing, jobid] as Prisma.InputJsonValue },
          });
        }
      }
      // Settle the per-segment SMS cost for every recipient just marked SENT —
      // best-effort, one settlement per recipient so a single pricing/ledger
      // blip can never sink the rest of the batch (or, worse, the already-
      // wire-sent batch itself). `e.body` is each recipient's fully-rendered
      // text (already carrying the mandatory unsubscribe "Stop:" footer
      // `render()` appended above), so the billed segment count matches
      // exactly what NetGSM received. Campaign recipients have no Message row
      // to stamp — `settleCampaignSms` writes only the SpendLedger entry.
      await Promise.allSettled(
        sendable.map((e) =>
          this.conversationSpend
            .settleCampaignSms(workspaceId, { recipientId: e.recipientId, text: e.body })
            .catch((err) =>
              this.logger.warn(
                `campaign SMS settlement failed for recipient ${e.recipientId}: ${String((err as Error)?.message ?? err)}`,
              ),
            ),
        ),
      );
      return;
    }

    // Batch-level failure: no recipient here was actually sent — refund every
    // reserved quota unit in one call. Scoped to `sendable` (not the original
    // `eligible`): iysPreflight already refunded anyone it pulled out
    // (blocked/deferred) before we ever reached the wire send.
    await this.quota.refund(workspaceId, 'SMS', sendable.length);
    const ids = sendable.map((e) => e.recipientId);
    if (result.retriable || result.transport) {
      // Code 80 (rate limit) or a genuine transport failure — nothing reached
      // NetGSM (or NetGSM asked us to back off), so revert the claim to
      // PENDING and let the next scheduled batch tick retry these recipients.
      // Guarded on status:'SENDING' (this claim's current state): between the
      // claim and this revert, the tracking service can flip a recipient to a
      // terminal state (e.g. UNSUBSCRIBED, from an inbound STOP/opt-out
      // processed concurrently) — without the guard, an unconditional
      // id-only WHERE would stomp that terminal state back to PENDING and
      // re-send to someone who just opted out.
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: ids }, workspaceId, campaignId, status: 'SENDING' },
        data: { status: 'PENDING' },
      });
      return;
    }
    const error = (result.message ?? `NetGSM ${result.code || '?'}`).slice(0, 300);
    await Promise.all(sendable.map((e) => this.mark(e.recipientId, 'FAILED', { error })));
  }

  /**
   * TİCARİ pre-send İYS hard-block (owner decision: full-auto + fail-closed).
   * Narrows `eligible` down to the recipients actually cleared to receive a
   * commercial send this tick:
   *   - A phone that can't normalize to İYS's canonical 90XXXXXXXXXX
   *     domestic-mobile wire shape (`toIysMsisdn`) → permanently SKIPPED,
   *     same bucket as RET/YOK — there is no shape to even ask İYS about, so
   *     it can never be verified. Never sent to `/iys/search` as raw input.
   *   - RET or YOK (İYS holds no record at all) → permanently SKIPPED, folded
   *     into `campaign.stats.iysBlocked`. Per İYS's model, no record proves no
   *     consent for TİCARİ — this preflight has no signal to tell an ordinary
   *     consumer number from a tacir/esnaf one (which the ticari ileti
   *     mevzuatı otherwise exempts from the İYS opt-in requirement), so YOK is
   *     treated as blocked here too; an operator who KNOWS a given number is
   *     tacir/esnaf can still reach it outside this automatic gate.
   *   - ONAY → sendable.
   *   - The per-account İYS search budget (10/min, shared with iys-sync's
   *     `/iys/add`) is exhausted for a given recipient → SOFT unreachable:
   *     just that recipient is reverted to PENDING (its quota refunded) for
   *     the next tick; recipients already cleared ONAY earlier in this SAME
   *     tick still proceed to send. This is normal throttling, not a
   *     compliance failure.
   *   - A genuine `/iys/search` failure (transport/API error, or a response
   *     İYS answered with none of the three documented statuses) → HARD
   *     unreachable: we cannot prove consent for ANYONE this tick, so the
   *     WHOLE batch aborts (every claimed recipient — including any already
   *     bucketed ONAY earlier in this loop — reverts to PENDING, nothing
   *     sent, nothing FAILED) and `campaign.stats.iysUnavailable` is stamped.
   *     Returns `null` in this case; the caller sends nothing.
   *   - No `brandCode` configured on the channel → we can't even build the
   *     İYS auth header, so this is the same HARD abort, checked up front
   *     before any search call is made.
   */
  private async iysPreflight(
    workspaceId: string,
    campaignId: string,
    config: ResolvedChannelConfig,
    eligible: Array<{ recipientId: string; phone: string; body: string }>,
  ): Promise<Array<{ recipientId: string; phone: string; body: string }> | null> {
    const { usercode, password } = config.secrets;
    const brandCode = typeof config.public?.brandCode === 'string' ? (config.public.brandCode as string).trim() : '';
    if (!brandCode) {
      this.logger.warn(
        `campaign ${campaignId}: TİCARİ send blocked — no İYS brandCode configured on the SMS channel; failing closed`,
      );
      await this.abortTicariTick(workspaceId, campaignId, eligible);
      return null;
    }
    const creds = { usercode, password, brandCode };

    const sendable: Array<{ recipientId: string; phone: string; body: string }> = [];
    const blocked: Array<{ recipientId: string; phone: string; body: string; reason: string }> = [];
    const deferred: Array<{ recipientId: string; phone: string; body: string }> = [];
    // Cache within THIS tick only (a fresh Map per call) — several recipients
    // rarely share one phone, but when they do this saves a redundant search
    // call (and the budget unit it would have spent). Keyed on the NORMALIZED
    // wire phone (not the raw `r.phone`), so two recipients whose raw phone
    // happens to be spelled differently (0-prefixed vs +90 vs bare-10) but is
    // the SAME number still dedup onto one search call.
    const cache = new Map<string, IysSearchResult>();

    for (const r of eligible) {
      // İYS's wire format is the 90XXXXXXXXXX domestic-mobile shape (no `+`) —
      // `r.phone` is whatever shape the lead's phone happened to be typed in
      // (0-prefixed, +90, bare-10, ...). A phone that can't reduce to a TR
      // mobile at all can never be verified against İYS — treat it as blocked
      // (same bucket/side-effects as RET/YOK) with its own clear reason,
      // rather than either silently sending it or aborting the whole tick.
      const wirePhone = toIysMsisdn(r.phone);
      if (!wirePhone) {
        blocked.push({ ...r, reason: 'İYS: numara doğrulanamadı (geçersiz alıcı telefonu)' });
        continue;
      }
      let res = cache.get(wirePhone);
      if (!res) {
        if (!this.budgeter.tryTake(usercode, 'iys', IYS_SEARCH_BUDGET_LIMIT, IYS_SEARCH_BUDGET_WINDOW_MS)) {
          deferred.push(r);
          continue;
        }
        res = await this.iysClient.search(creds, wirePhone, 'MESAJ');
        cache.set(wirePhone, res);
      }
      if (!res.ok || res.status === null) {
        // A thrown/API error (ok:false) and an ok:true-but-unclassifiable
        // status are treated identically: neither tells us anything we can
        // act on, so — fail closed — abort the whole tick rather than guess.
        this.logger.warn(
          `campaign ${campaignId}: İYS search failed for a recipient (${res.message ?? 'unclassifiable response'}) — aborting the TİCARİ batch tick`,
        );
        await this.abortTicariTick(workspaceId, campaignId, eligible);
        return null;
      }
      if (res.status === 'RET' || res.status === 'YOK') {
        blocked.push({ ...r, reason: 'İYS: izin yok (RET/kayıt yok)' });
      } else {
        sendable.push(r); // ONAY
      }
    }

    if (blocked.length > 0) {
      await Promise.all(blocked.map((r) => this.mark(r.recipientId, 'SKIPPED', { error: r.reason })));
      await this.quota.refund(workspaceId, 'SMS', blocked.length);
      await this.bumpStat(campaignId, 'iysBlocked', blocked.length);
    }
    if (deferred.length > 0) {
      const ids = deferred.map((r) => r.recipientId);
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: ids }, workspaceId, campaignId, status: 'SENDING' },
        data: { status: 'PENDING' },
      });
      await this.quota.refund(workspaceId, 'SMS', deferred.length);
    }
    return sendable;
  }

  /**
   * Fail-closed abort for a TİCARİ tick: nothing in `eligible` was actually
   * sent, so every one of them reverts to PENDING (guarded on status:
   * 'SENDING', same as the code-80/transport-failure reverts below — a
   * concurrent opt-out must not get stomped back to PENDING) and its quota
   * reservation is refunded in bulk. `campaign.stats.iysUnavailable` is
   * stamped (merged, never clobbering delivered/undelivered/iysBlocked or
   * anything else already sitting in the blob) so ops can see WHY nothing
   * went out. The campaign itself stays SENDING — the existing batch
   * reschedule (in `batch()`) retries next tick.
   */
  private async abortTicariTick(
    workspaceId: string,
    campaignId: string,
    eligible: Array<{ recipientId: string; phone: string; body: string }>,
  ): Promise<void> {
    const ids = eligible.map((r) => r.recipientId);
    await this.prisma.campaignRecipient.updateMany({
      where: { id: { in: ids }, workspaceId, campaignId, status: 'SENDING' },
      data: { status: 'PENDING' },
    });
    await this.quota.refund(workspaceId, 'SMS', eligible.length);
    const s = await this.currentStats(campaignId);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: { ...s, iysUnavailable: true } as Prisma.InputJsonValue },
    });
  }

  /**
   * VOICE campaign send (NetGSM Phase 5) — `/voicesms/send` has NO batch
   * shape (unlike `SmsV2Client.send`): it's a per-number call, so every
   * eligible recipient of this tick gets its own `VoicesmsSendClient.send`
   * round-trip, throttled by the SAME BATCH_SIZE/BATCH_INTERVAL_SEC cadence
   * that already paces every `campaign.batch` tick — NetGSM's docs don't pin
   * a per-minute cap for this endpoint the way they do for
   * `/voicesms/receive` (2/min) or `/autocallservice` (10/min), so there is
   * no separate `AccountRateBudgeter` bucket for it here.
   *
   * `relationid` is this recipient's own `CampaignRecipient.id` — Task 3's
   * voice-report webhook consumer correlates purely by that id, so (unlike
   * the SMS v2 batch path) nothing needs to be stamped on `netgsmJobId`/
   * `referansId` on success: those two columns are the SMS DLR-poll
   * reconciler's OWN signal (`netgsm-dlr-poll.service.ts`'s
   * `pollV2Campaigns` selects ANY recipient row with `netgsmJobId` set, not
   * scoped to `campaign.channel === 'SMS'`) — stamping them here would leak
   * a voice call's jobid into that poller's next `/sms/rest/v2/report`
   * batch. The call's own jobid rides the plain, unindexed `messageId`
   * instead (mirrors the legacy per-recipient SMS path's own `messageId`
   * stamp).
   *
   * No `ConversationSpendService.settleVoice` call here (unlike
   * `sendSmsBatch`'s per-segment SMS settlement): `settleVoice` prices by
   * billable minutes from the call's actual talk duration, which isn't known
   * at send time — only once Task 3's voice-report webhook lands `talkSec`.
   *
   * CORRECTED (Final-review fix M3 — this docstring previously claimed
   * settlement was "deferred to the report consumer"; that was aspirational,
   * not true): `voice-report.consumer.ts`'s `VoiceReportConsumer.handle` only
   * writes `voiceState`/`pushButton`/`talkSec` onto `CampaignRecipient` and
   * rolls up `campaign.stats` — it contains NO `settleVoice`/ledger call.
   * Every VOICE campaign send today debits ₺0; this is a genuine gap, not a
   * deliberate deferral. TODO (real follow-up, out of this task's scope):
   * price VOICE campaign minutes — needs (a) a voice campaign tariff and (b)
   * a `settleVoice`-shaped call scoped to `CampaignRecipient` (mirroring
   * `settleCampaignSms`'s ledger-only shape, since `CampaignRecipient` has no
   * `costAmount` column to stamp the way `settleVoice`'s existing
   * `voiceCall`/`salesCall` targets do) — most naturally wired into
   * `VoiceReportConsumer.handle` once `talkSec` lands, since that's the only
   * place the real billable duration becomes known.
   */
  private async sendVoice(
    workspaceId: string,
    campaignId: string,
    campaign: { iysMessageType?: string | null; voiceConfig?: unknown },
    creds: { usercode: string; password: string; brandCode: string },
    /** `msg` is this recipient's OWN line: merge tags are resolved in the claim
     *  loop, the only place the lead is in scope on the voice path. */
    eligible: Array<{ recipientId: string; phone: string; msg?: string }>,
  ): Promise<void> {
    const isTicari = campaign.iysMessageType === 'TICARI';
    const iysfilter: '0' | '11' = isTicari ? '11' : '0';
    const vc = (campaign.voiceConfig && typeof campaign.voiceConfig === 'object' ? campaign.voiceConfig : {}) as {
      msg?: string;
      audioid?: string;
      keys?: string[];
    };

    let sendable = eligible;
    if (isTicari) {
      const cleared = await this.iysArmaPreflight(workspaceId, campaignId, creds, eligible);
      // null = hard fail-closed abort: iysArmaPreflight already reverted every
      // claimed recipient to PENDING, refunded their quota, and stamped
      // iysUnavailable — nothing left to do this tick.
      if (cleared === null) return;
      sendable = cleared;
      // Everyone was blocked (RET/YOK) or deferred (budget exhausted) this
      // tick — iysArmaPreflight already handled their side effects.
      if (sendable.length === 0) return;
    }

    const base = this.config.get<string>('PUBLIC_BASE_URL') ?? '';
    const reportUrl = netgsmWebhookUrl(base, workspaceId, 'voice-report') ?? undefined;

    for (const r of sendable) {
      let result: VoicesmsSendResult;
      try {
        result = await this.voicesmsSend.send(
          { usercode: creds.usercode, password: creds.password },
          {
            // The merged line when the claim loop produced one; the raw
            // configured text only when there was no lead to merge into it.
            ...((r.msg ?? vc.msg) ? { msg: r.msg ?? vc.msg } : {}),
            ...(vc.audioid ? { audioid: vc.audioid } : {}),
            no: r.phone,
            iysfilter,
            ...(isTicari && creds.brandCode ? { brandcode: creds.brandCode } : {}),
            relationid: r.recipientId,
            ...(reportUrl ? { url: reportUrl } : {}),
            ...(vc.keys && vc.keys.length ? { keys: vc.keys } : {}),
          },
        );
      } catch (e: any) {
        // VoicesmsSendClient.send is documented to never throw (every outcome
        // resolves to an ok:false result) — this is a defensive backstop only.
        result = {
          ok: false, code: '', jobid: null, relationid: r.recipientId,
          message: e?.message ?? String(e), retriable: false, transport: false,
        };
      }

      if (result.ok) {
        await this.mark(r.recipientId, 'SENT', { messageId: result.jobid, sentAt: new Date() });
        continue;
      }
      if (result.retriable || result.transport) {
        // Code 80 (rate limit) or a genuine transport failure — nothing
        // reached NetGSM (or NetGSM asked us to back off): revert the claim
        // to PENDING and let the next scheduled batch tick retry. Guarded on
        // status:'SENDING' — a concurrent opt-out must not get stomped back.
        await this.prisma.campaignRecipient.updateMany({
          where: { id: r.recipientId, workspaceId, campaignId, status: 'SENDING' },
          data: { status: 'PENDING' },
        });
        await this.quota.refund(workspaceId, 'VOICE');
        continue;
      }
      await this.quota.refund(workspaceId, 'VOICE');
      await this.mark(r.recipientId, 'FAILED', { error: (result.message ?? `NetGSM ${result.code || '?'}`).slice(0, 300) });
    }
  }

  /**
   * TİCARİ pre-send İYS hard-block for VOICE campaigns — same owner decision
   * and shape as `iysPreflight` (SMS's MESAJ preflight), but the consent type
   * is ARAMA (voice/call), not MESAJ. Shares the SAME `AccountRateBudgeter`
   * bucket (`'iys'`) and limit as `iysPreflight` and `iys-sync.service.ts`'s
   * `/iys/add` worker: `/iys/search` is one endpoint with a `type` param, and
   * NetGSM's rate cap is documented per-account/aggregate, not per-type.
   */
  private async iysArmaPreflight(
    workspaceId: string,
    campaignId: string,
    creds: { usercode: string; password: string; brandCode: string },
    eligible: Array<{ recipientId: string; phone: string; msg?: string }>,
  ): Promise<Array<{ recipientId: string; phone: string; msg?: string }> | null> {
    if (!creds.brandCode) {
      this.logger.warn(
        `campaign ${campaignId}: TİCARİ voice send blocked — no İYS brandCode configured on the ACTIVE SMS channel; failing closed`,
      );
      await this.abortTicariVoiceTick(workspaceId, campaignId, eligible);
      return null;
    }
    const iysCreds = { usercode: creds.usercode, password: creds.password, brandCode: creds.brandCode };

    const sendable: Array<{ recipientId: string; phone: string; msg?: string }> = [];
    const blocked: Array<{ recipientId: string; phone: string; msg?: string; reason: string }> = [];
    const deferred: Array<{ recipientId: string; phone: string; msg?: string }> = [];
    // Cache within THIS tick only — keyed on the NORMALIZED wire phone, same
    // dedupe rationale as iysPreflight's own cache.
    const cache = new Map<string, IysSearchResult>();

    for (const r of eligible) {
      const wirePhone = toIysMsisdn(r.phone);
      if (!wirePhone) {
        blocked.push({ ...r, reason: 'İYS: numara doğrulanamadı (geçersiz alıcı telefonu)' });
        continue;
      }
      let res = cache.get(wirePhone);
      if (!res) {
        if (!this.budgeter.tryTake(creds.usercode, 'iys', IYS_SEARCH_BUDGET_LIMIT, IYS_SEARCH_BUDGET_WINDOW_MS)) {
          deferred.push(r);
          continue;
        }
        res = await this.iysClient.search(iysCreds, wirePhone, 'ARAMA');
        cache.set(wirePhone, res);
      }
      if (!res.ok || res.status === null) {
        this.logger.warn(
          `campaign ${campaignId}: İYS ARAMA search failed for a recipient (${res.message ?? 'unclassifiable response'}) — aborting the TİCARİ voice batch tick`,
        );
        await this.abortTicariVoiceTick(workspaceId, campaignId, eligible);
        return null;
      }
      if (res.status === 'RET' || res.status === 'YOK') {
        blocked.push({ ...r, reason: 'İYS: arama izni yok (RET/kayıt yok)' });
      } else {
        sendable.push(r); // ONAY
      }
    }

    if (blocked.length > 0) {
      await Promise.all(blocked.map((r) => this.mark(r.recipientId, 'SKIPPED', { error: r.reason })));
      await this.quota.refund(workspaceId, 'VOICE', blocked.length);
      await this.bumpStat(campaignId, 'iysBlocked', blocked.length);
    }
    if (deferred.length > 0) {
      const ids = deferred.map((r) => r.recipientId);
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: ids }, workspaceId, campaignId, status: 'SENDING' },
        data: { status: 'PENDING' },
      });
      await this.quota.refund(workspaceId, 'VOICE', deferred.length);
    }
    return sendable;
  }

  /** Fail-closed abort for a TİCARİ voice tick — same shape as
   *  `abortTicariTick` (SMS), scoped to the 'VOICE' quota channel. */
  private async abortTicariVoiceTick(
    workspaceId: string,
    campaignId: string,
    eligible: Array<{ recipientId: string; phone: string; msg?: string }>,
  ): Promise<void> {
    const ids = eligible.map((r) => r.recipientId);
    await this.prisma.campaignRecipient.updateMany({
      where: { id: { in: ids }, workspaceId, campaignId, status: 'SENDING' },
      data: { status: 'PENDING' },
    });
    await this.quota.refund(workspaceId, 'VOICE', eligible.length);
    const s = await this.currentStats(campaignId);
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: { ...s, iysUnavailable: true } as Prisma.InputJsonValue },
    });
  }

  /** Current `Campaign.stats` blob (or `{}` if unset/malformed) — the
   *  read half of the read-modify-write merge every stats writer in this
   *  file uses so no field this method doesn't own is ever clobbered. */
  private async currentStats(campaignId: string): Promise<Record<string, unknown>> {
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { stats: true } });
    return c?.stats && typeof c.stats === 'object' ? (c.stats as Record<string, unknown>) : {};
  }

  /** Increments one numeric counter in `Campaign.stats` by `delta`, merging
   *  (spread-preserve) over whatever else is already in the blob. */
  private async bumpStat(campaignId: string, key: string, delta: number): Promise<void> {
    const s = await this.currentStats(campaignId);
    const current = Number(s[key]) || 0;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: { ...s, [key]: current + delta } as Prisma.InputJsonValue },
    });
  }

  /**
   * Merge tags — `{{lead.contactPerson}}`, `{{workspace.name}}`.
   *
   * The composer has suggested these tokens since the campaign editor shipped
   * and nothing ever substituted them, so two thousand leads received "Merhaba
   * {{lead.contactPerson}}" and the VOICE path read the braces aloud
   * (`merge-tags-literal`).
   *
   * `escape` must match the SINK, and only the HTML sink has one: the compiled
   * email HTML already escaped every author-written character, so a raw lead
   * value with `<`, `&` or a quote in it corrupts or injects the document —
   * while escaping the plain-text body would ship "Ben &amp; Jerry&#39;s" to
   * somebody reading text.
   *
   * The root whitelist is the injection-safe part: a token on any other root is
   * returned exactly as it was written, so this can never traverse into
   * anything it was not handed, and never silently eats an author's own braces.
   */
  private interpolate(template: string, ctx: MergeContext, escape?: (v: string) => string): string {
    if (!template || !template.includes('{{')) return template;
    return template.replace(
      /\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*(?:\|([^}]*))?\}\}/g,
      (match: string, field: string, fallback?: string) => {
        if (!MERGE_ROOTS.has(field.split('.')[0])) return match;
        let value = mergeValue(field, ctx);
        // The author's own default wins over anything we would guess.
        if (!value && fallback !== undefined) value = fallback.trim();
        if (!value) {
          for (const alias of NAME_ALIASES[field] ?? []) {
            value = mergeValue(alias, ctx);
            if (value) break;
          }
        }
        return escape ? escape(value) : value;
      },
    );
  }

  /**
   * The host every BULK link goes out on: click redirects, the open pixel and
   * the unsubscribe link (`shared-tracking-domain`).
   *
   * `LINK_BASE_URL` lets an operator put bulk links on their own host — one DNS
   * record, no per-tenant provisioning — so one tenant's URL getting listed
   * cannot take the login, invoice and password-reset mail down with it. Unset
   * (the default, and today's behaviour) it IS `PUBLIC_BASE_URL`.
   *
   * There is one reader on purpose: the body link, the pixel and the RFC 8058
   * List-Unsubscribe URI must share a base or the header stops matching the
   * footer the body carries, and the gateway then appends a second one.
   * Everything that is not bulk — invoice, quote, funnel, site and the NetGSM
   * callback URLs — stays on PUBLIC_BASE_URL.
   */
  private linkBase(): string {
    const links = (this.config.get<string>('LINK_BASE_URL') ?? '').trim();
    return links || (this.config.get<string>('PUBLIC_BASE_URL') ?? '').trim();
  }

  /** Rewrite links to click-tracked URLs + append a mandatory unsubscribe footer. */
  private render(channel: string, body: string, token: string, links: string[]): string {
    const base = this.linkBase();
    let out = body;
    if (base) {
      // Rewrite longest URLs first (keeping the original index for ?i=) so a URL
      // that is a string-prefix of another isn't matched inside the longer one.
      for (const { url, i } of byLengthDesc(links)) {
        out = out.split(url).join(`${base}/api/public/t/c/${token}?i=${i}`);
      }
      const unsub = `${base}/api/public/u/${token}`;
      out += channel === 'SMS' ? `\nStop: ${unsub}` : `\n\n—\nUnsubscribe: ${unsub}`;
    }
    return out;
  }

  /**
   * HTML body variant: rewrite the campaign-authored links to click-tracked URLs
   * (matching BOTH the raw and HTML-escaped form, since the compiled HTML escapes
   * hrefs) and append a mandatory HTML unsubscribe footer. `links` holds the real
   * (decoded) URLs so the tracked redirect target stays correct.
   */
  private renderHtml(html: string, token: string, links: string[]): string {
    const base = this.linkBase();
    let out = html;
    if (base) {
      // ATTRIBUTE-SCOPED, never a document-wide split/join.
      //
      // The blind replace rewrote `<img src>` too, so every image load — and
      // every image proxy, and Apple MPP — counted as a click, and the
      // click-based A/B winner was picked from them (`img-src-click`). Worse,
      // a link that is a string-PREFIX of an image URL produced
      // `src=".../t/c/tok?i=0/logo.png"`, whose `?i=` parses to NaN: the
      // tracker's `Number(i) || 0` then resolved index 0 and redirected the
      // image request to the href's page — a broken image AND a false click.
      // Only the value of an `href` attribute, matched whole, is rewritten.
      const tracked = new Map<string, string>();
      for (const { url, i } of byLengthDesc(links)) {
        const target = `${base}/api/public/t/c/${token}?i=${i}`;
        // Both spellings: the compiled HTML entity-escapes `&` inside an
        // attribute value, so the raw link and its escaped form both have to
        // resolve to the same tracked URL.
        if (!tracked.has(url)) tracked.set(url, target);
        if (!tracked.has(esc(url))) tracked.set(esc(url), target);
      }
      // All three quoting styles, matching `extractHrefLinks`'s own scan — a
      // link the extractor put in `links` that this pass could not find would
      // ship untracked, and the two must not disagree about what a link is.
      out = out.replace(
        /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
        (match, attr: string, dq?: string, sq?: string, bare?: string) => {
          const value = dq ?? sq ?? bare ?? '';
          const target = tracked.get(value) ?? tracked.get(value.trim());
          if (!target) return match;
          const quote = sq !== undefined ? "'" : '"';
          return `${attr}${quote}${target}${quote}`;
        },
      );
      const unsub = `${base}/api/public/u/${token}`;
      // The open pixel. Everything behind it already existed — the public
      // `t/o/:token` route serves a 1x1 GIF, CampaignTrackingService.open()
      // claims `openedAt` race-safely, recomputeStats counts the column and the
      // A/B winner sorts on it — but nothing ever emitted the <img>, so every
      // open count was a zero that looked measured.
      const pixel = `${base}/api/public/t/o/${token}`;
      const footer =
        `<table role="presentation" width="100%"><tr><td align="center" style="padding:16px;font-size:12px;color:#94a3b8">` +
        `<a href="${esc(unsub)}" style="color:#94a3b8">Unsubscribe</a></td></tr></table>` +
        `<img src="${esc(pixel)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
      // The compiled email HTML always has </body>; fall back to appending for a
      // hand-authored fragment so the mandatory unsubscribe link is never lost.
      out = out.includes('</body>') ? out.replace('</body>', `${footer}</body>`) : out + footer;
    }
    return out;
  }

  private async mark(id: string, status: string, extra: Record<string, any> = {}): Promise<void> {
    await this.prisma.campaignRecipient.update({ where: { id }, data: { status, ...extra } });
  }

  /**
   * Recompute send stats from the recipient rows (the source of truth) rather
   * than accumulating per-batch deltas. This is idempotent (a reaped/re-run batch
   * can't double-count) and immune to the lost-update race of a read-modify-write
   * on the JSON `stats` blob: even interleaved writers converge on the true count.
   */
  private async recomputeStats(workspaceId: string, campaignId: string): Promise<void> {
    const [groups, openedCount, clickedCount, sentCount] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { workspaceId, campaignId },
        _count: { _all: true },
      }),
      // Engagement is authoritatively recorded per-recipient (open/click set a
      // timestamp; unsubscribe sets status UNSUBSCRIBED — see CampaignTracking),
      // so it is fully derivable from the rows.
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, openedAt: { not: null } } }),
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, clickedAt: { not: null } } }),
      // `sent` counts the TIMESTAMP, not the status. An unsubscribe overwrites
      // status SENT → UNSUBSCRIBED, so counting the status made the sent total
      // fall every time a recipient opted out — a report that says a campaign
      // reached fewer people than it did (`sent-count-drops`). `sentAt` is
      // stamped once at delivery and never cleared, which is what "sent" means.
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, sentAt: { not: null } } }),
    ]);
    const countOf = (status: string) =>
      groups.find((g) => g.status === status)?._count._all ?? 0;
    const c = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { stats: true, abEnabled: true } });
    const s = (c?.stats ?? {}) as Record<string, number>;
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        stats: {
          // Spread the existing blob FIRST so any key this method doesn't own
          // (the static launch-time `recipients` total, and — critically —
          // `delivered`/`undelivered`/`iysBlocked`, which `netgsm-dlr-poll.
          // service.ts`'s `rollupCampaignStats` merges in independently)
          // survives a recompute that races it. Every field this method DOES
          // own is listed after the spread so it always wins over whatever
          // stale value was sitting in `s` for that same key.
          ...s,
          sent: sentCount,
          failed: countOf('FAILED'),
          skipped: countOf('SKIPPED'),
          // Recompute engagement from the recipient rows (the source of truth)
          // rather than carrying it forward from the stored blob. opened/clicked/
          // unsubscribed are maintained by the tracker's atomic jsonb_set bump();
          // re-writing them here from a STALE `...s` snapshot clobbered a concurrent
          // open/click/unsubscribe (the live lost-update this method claimed to be
          // immune to). Deriving all fields from rows makes the recompute truly
          // convergent under concurrency.
          opened: openedCount,
          clicked: clickedCount,
          unsubscribed: countOf('UNSUBSCRIBED'),
        } as Prisma.InputJsonValue,
      },
    });

    // Per-variant A/B stats — only for an A/B-enabled campaign, so a non-A/B
    // campaign (which may still have a lone leftover variant row) never pays for
    // the extra groupBys on the throttled batch path.
    const variants = (c as any)?.abEnabled
      ? await this.prisma.campaignVariant.findMany({ where: { workspaceId, campaignId }, select: { id: true, key: true } })
      : [];
    if (variants.length) {
      const [sentG, openG, clickG] = await Promise.all([
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, sentAt: { not: null } }, _count: { _all: true } }),
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, openedAt: { not: null } }, _count: { _all: true } }),
        this.prisma.campaignRecipient.groupBy({ by: ['variantKey'], where: { workspaceId, campaignId, clickedAt: { not: null } }, _count: { _all: true } }),
      ]);
      const cnt = (g: any[], key: string) => g.find((x) => x.variantKey === key)?._count._all ?? 0;
      await Promise.all(
        variants.map((v) =>
          this.prisma.campaignVariant.update({
            where: { id: v.id },
            data: { stats: { sent: cnt(sentG, v.key), opened: cnt(openG, v.key), clicked: cnt(clickG, v.key) } as Prisma.InputJsonValue },
          }),
        ),
      );
    }
  }
}

/**
 * What a receipt means for the recipient row.
 *
 * `REFUSED` is not a failure — policy said no, it is terminal, and it is never
 * retried. Which kind of "no" it was decides whose problem it is: the
 * recipient's (SKIPPED, like the opt-out re-check) or the workspace's (the row
 * waits, and the tick stops rather than walking the rest of the audience into
 * the same wall). That distinction is the whole reason the gateway returns a
 * receipt instead of the bare `false` all four of these used to share.
 */
function outcomeFor(r: MailReceipt): RecipientOutcome {
  const error = r.error ?? r.reason;
  const reason = r.reason;
  if (r.ok) return { disposition: 'SENT', messageId: r.messageId ?? null };

  if (r.outcome === 'REFUSED') {
    if (reason && RECIPIENT_REFUSALS.has(reason)) {
      return { disposition: 'SKIPPED', ...(error ? { error } : {}), reason };
    }
    if (reason && DEFERRED_REFUSALS.has(reason)) {
      return {
        disposition: 'RETRY',
        stopTick: true,
        deferred: true,
        ...(r.retryAt ? { retryAt: r.retryAt } : {}),
        ...(error ? { error } : {}),
        reason,
      };
    }
    return { disposition: 'RETRY', stopTick: true, ...(error ? { error } : {}), ...(reason ? { reason } : {}) };
  }

  if (r.outcome === 'FAILED_TRANSIENT') {
    // SYSTEMIC is retriable for the QUEUE but not for this attempt: the same
    // rejected password rejects the next forty-nine too.
    return {
      disposition: 'RETRY',
      ...(reason === 'SYSTEMIC' ? { stopTick: true } : {}),
      ...(error ? { error } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  // No transport at all is a deploy problem, not a dead address: it must never
  // burn an audience into rows that are never re-sent.
  if (reason === 'NOT_CONFIGURED') {
    return { disposition: 'RETRY', stopTick: true, ...(error ? { error } : {}), reason };
  }
  return { disposition: 'FAILED', ...(error ? { error } : {}), ...(reason ? { reason } : {}) };
}

/** The SMS/WhatsApp adapter path, unchanged: it still only knows sent or not. */
function legacyOutcome(r: { ok: boolean; messageId?: string | null; error?: string }): RecipientOutcome {
  return r.ok
    ? { disposition: 'SENT', messageId: r.messageId ?? null }
    : { disposition: 'FAILED', ...(r.error ? { error: r.error } : {}) };
}

/** The TTS line on a VOICE campaign, when it has one (an `audioid` campaign
 *  plays a recording and has no text to merge into). */
function voiceMessage(voiceConfig: unknown): string | null {
  if (!voiceConfig || typeof voiceConfig !== 'object') return null;
  const msg = (voiceConfig as Record<string, unknown>).msg;
  return typeof msg === 'string' && msg ? msg : null;
}
