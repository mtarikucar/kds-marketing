import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DEFAULT_MAIL_LANG, MailLang, resolveMailLang } from '../../../common/i18n/mail-copy';
import { OutboxService } from '../../outbox/outbox.service';
import {
  MarketingEmailEngagementPayload,
  MarketingEventTypes,
  MarketingSmsOptStatusPayload,
} from '../events/marketing-event-types';
import { verifyLeadUnsubscribeToken } from '../channels/lead-unsubscribe.token';
import { ConsentLedgerService, ConsentType } from '../compliance/consent-ledger.service';
import { IysSyncService } from '../compliance/iys-sync.service';
import { SuppressionService } from '../compliance/suppression.service';

/**
 * What the HTTP request behind a pixel or a click looked like.
 *
 * Optional everywhere, and an absent hit counts as a person: a caller that
 * cannot describe its request must not silently stop every open being counted.
 */
export interface TrackingHit {
  /** `User-Agent`, as sent. Null/absent when the client sent none. */
  ua?: string | null;
  /** The method the public route was reached on. */
  method?: string | null;
  /**
   * The shared `isAutomatedFetch` verdict, set ONLY by a route a person reaches
   * by navigating — the click redirect. It reads the `Sec-Fetch-*`/`Accept`
   * shape, which a scanner cannot fake without actually being a browser.
   *
   * Absent on the open pixel on purpose: a pixel is a subresource fetch, so its
   * `Sec-Fetch-Dest` is `image` and every genuine open would come back `true`.
   */
  automated?: boolean;
}

/**
 * Mail-security gateways and link previewers fetch every URL in a message, and
 * they do it from the recipient's own mail path — so their hits are
 * indistinguishable from a reader's unless we look. These three lists are
 * DENY-lists on purpose (`engagement-unqualified`): an unrecognised agent is a
 * person, because over-blocking silently deletes a tenant's real engagement and
 * nothing on the screen would say why.
 *
 * Deliberately NOT here: `GoogleImageProxy` / `YahooMailProxy`. Those fetch the
 * pixel when the mail is DISPLAYED — that fetch IS the open, and reading it as
 * a machine would zero every Gmail open in the product.
 */
const SCANNER_UA_RE =
  /safelinks|urldefense|proofpoint|mimecast|barracuda|bluecoat|symantec|forcepoint|ironport|messagelabs|sophos|fireeye|trend ?micro|bitdefender|kaspersky|avast|avira|eset|zscaler|netskope|cloudmark|virustotal|bingpreview|facebookexternalhit|twitterbot|telegrambot|discordbot|slackbot/;
/**
 * Two shapes, both deliberate. The word-bounded list catches a standalone
 * token; `bot/<version>` catches the `AhrefsBot/7.0` / `Googlebot/2.1` naming
 * every real crawler uses. A bare `bot` substring would be a third and is left
 * out: it fires on a Cubot phone's User-Agent, and losing that person's opens
 * forever is a worse trade than missing an unversioned crawler.
 */
const BOT_UA_RE =
  /\b(bot|bots|crawler|spider|scraper|slurp|fetcher|monitor|monitoring|scanner|validator|checker|probe|preview|prefetch|archiver|indexer)\b|bot\/\d/;
const TOOL_UA_RE =
  /curl\/|wget|libwww|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|apache-httpclient|node-fetch|axios\/|guzzlehttp|restsharp|powershell|headlesschrome|phantomjs|puppeteer|playwright|selenium|lighthouse/;

/**
 * How close to the send a hit has to land to be a delivery-time prefetch.
 *
 * A gateway scans on delivery, seconds after the relay hand-off; a person has
 * to notice the mail first. Five seconds is short enough that no reader is
 * plausibly inside it and long enough to catch the scanners that arrive with an
 * ordinary browser User-Agent (Apple MPP, most notably, which is invisible to
 * every rule above).
 */
const PREFETCH_WINDOW_MS = 5_000;

/**
 * Why this hit is a machine, or null when it counts as a person.
 *
 * Pure and exported so the question has ONE answer wherever a tracked link is
 * hit — the honest limit of it is written down in the rules above: it names the
 * machines it can name and lets the rest through.
 */
export function machineHitReason(hit: TrackingHit | undefined, sentAt?: Date | null): string | null {
  // A HEAD is never a render: no client displaying a message asks for the
  // headers of its images.
  if ((hit?.method ?? 'GET').toUpperCase() === 'HEAD') return 'head';
  // The navigation-shaped evidence, where the caller could gather it. It is the
  // strongest signal available — Defender detonation forges a current Chrome
  // User-Agent, but it cannot forge being a top-level browser navigation.
  if (hit?.automated === true) return 'automated';
  const ua = (hit?.ua ?? '').toLowerCase();
  if (ua) {
    if (SCANNER_UA_RE.test(ua)) return 'scanner';
    if (TOOL_UA_RE.test(ua)) return 'tool';
    if (BOT_UA_RE.test(ua)) return 'bot';
  }
  if (sentAt) {
    const since = Date.now() - new Date(sentAt).getTime();
    if (since >= 0 && since < PREFETCH_WINDOW_MS) return 'prefetch';
  }
  return null;
}

/** What an unsubscribe token turned out to be. */
type UnsubscribeSubject =
  /** The per-recipient token a campaign minted at launch. */
  | { kind: 'recipient'; r: CampaignRecipientRow }
  /** A signed lead-scoped token from mail that has no recipient row (R1). */
  | { kind: 'lead'; workspaceId: string; leadId: string };

/** Only the columns the unsubscribe path reads. */
interface CampaignRecipientRow {
  id: string;
  workspaceId: string;
  campaignId: string;
  leadId: string;
  status: string;
  /** Frozen at launch; null on rows created before that column existed. */
  channel?: string | null;
}

type EmailEngagementKind = 'opened' | 'clicked' | 'unsubscribed';

/** What this service raises, per thing a recipient did to the mail. */
const EMAIL_ENGAGEMENT_EVENT: Record<EmailEngagementKind, string> = {
  opened: MarketingEventTypes.EmailOpened,
  clicked: MarketingEventTypes.EmailClicked,
  unsubscribed: MarketingEventTypes.EmailUnsubscribed,
};

/** The opt-out column + the consent type that goes with it, per channel. */
const CHANNEL_OPT_OUT: Record<string, { column: 'emailOptOut' | 'smsOptOut' | 'waOptOut'; consent: ConsentType }> = {
  EMAIL: { column: 'emailOptOut', consent: 'MARKETING_EMAIL' },
  SMS: { column: 'smsOptOut', consent: 'MARKETING_SMS' },
  WHATSAPP: { column: 'waOptOut', consent: 'MARKETING_WHATSAPP' },
  // VOICE has no opt-out flag of its own. `smsOptOut` is the proxy its OWN
  // audience gate already reads (campaigns.service.ts's buildAudienceWhere) and
  // the one campaign-sender re-checks at send time, so anything else would let
  // the next voice campaign call someone who asked us to stop.
  VOICE: { column: 'smsOptOut', consent: 'MARKETING_SMS' },
};

/**
 * Resolves the unguessable per-recipient token behind open/click/unsubscribe
 * links and records the event. Click only ever returns a URL that was in the
 * campaign body at launch (Campaign.links), so the tracker can't be turned into
 * an open redirect. Unsubscribe flips the lead's per-channel opt-out so future
 * campaigns AND the AI engine honor it.
 */
@Injectable()
export class CampaignTrackingService {
  private readonly logger = new Logger(CampaignTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly iysSync: IysSyncService,
    private readonly suppression: SuppressionService,
    private readonly ledger: ConsentLedgerService,
  ) {}

  /**
   * The open pixel was fetched. `hit` describes the request, because most of
   * those fetches are not people (`engagement-unqualified`): a mail-security
   * gateway scanning on delivery, a link previewer, a monitor. One we can name
   * is not recorded at all — and deliberately not written onto the row either,
   * so the reader's own open a minute later still counts.
   */
  async open(token: string, hit?: TrackingHit): Promise<void> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r || r.openedAt) return;
    if (this.isMachine(r.id, 'open', hit, r.sentAt)) return;
    // A mail-client prefetch + the real open (or a proxied retry) hit the pixel
    // near-simultaneously — a VERY common case. The old check-then-act let BOTH
    // pass the openedAt-null check and each `bump`, double-counting the campaign's
    // "unique opens". Gate the bump on WINNING the openedAt:null→set transition:
    // only the first concurrent hit's updateMany matches a row (count 1), so the
    // open is counted exactly once. (The bump itself was already atomic.)
    await this.claimOpen(r.id, r.campaignId, r.workspaceId, r.leadId);
  }

  /** Returns the campaign-authored destination URL, or null (no open redirect). */
  async click(token: string, index: number, hit?: TrackingHit): Promise<string | null> {
    const r = await this.prisma.campaignRecipient.findUnique({ where: { token } });
    if (!r) return null;
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: r.campaignId, workspaceId: r.workspaceId },
      // `channel` decides whether this click is also an open: an SMS campaign
      // has no pixel and no such thing as an "open", and an opened count there
      // would silently flip an SMS A/B decision off its no-signal path.
      select: { links: true, channel: true },
    });
    const links = (Array.isArray(campaign?.links) ? campaign!.links : []) as string[];
    const url = links[index];
    if (!url || !/^https?:\/\//i.test(url)) return null;
    // The redirect is NOT conditional on any of this: a scanner that fetched
    // the link still gets taken to the destination, exactly as before. Only the
    // counting stops.
    if (this.isMachine(r.id, 'click', hit, r.sentAt)) return url;
    if (!r.clickedAt) {
      // Same race-safe claim as open(): only the first concurrent click counts.
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, clickedAt: null },
        data: { clickedAt: new Date() },
      });
      if (claim.count === 1) await this.bump(r.campaignId, 'clicked');
    }
    if (campaign?.channel === 'EMAIL') {
      // `click-not-open`: an image-blocking reader never loads the pixel, so a
      // campaign that was read and acted on reported "opened 0, clicked 40".
      // The claim sits OUTSIDE the clickedAt guard on purpose — someone who
      // clicks twice must still be able to claim their first open on the second.
      await this.claimOpen(r.id, r.campaignId, r.workspaceId, r.leadId);
      // Keyed per LINK, not per recipient: "clicked the pricing link" has to
      // fire for someone who clicked another link first, while a double-click
      // on the same one collapses into a single event (and one workflow run).
      await this.emitEngagement('clicked', `${r.id}:${index}`, {
        workspaceId: r.workspaceId,
        leadId: r.leadId,
        campaignId: r.campaignId,
        recipientId: r.id,
        url,
        linkIndex: index,
      });
    }
    return url;
  }

  /**
   * Claim the one open this recipient gets, and tell the workflow engine about
   * it — from the winning claim only, so a re-hit neither re-counts nor
   * re-starts an automation.
   */
  private async claimOpen(id: string, campaignId: string, workspaceId: string, leadId: string): Promise<void> {
    const claim = await this.prisma.campaignRecipient.updateMany({
      where: { id, openedAt: null },
      data: { openedAt: new Date() },
    });
    if (claim.count !== 1) return;
    await this.bump(campaignId, 'opened');
    await this.emitEngagement('opened', id, { workspaceId, leadId, campaignId, recipientId: id });
  }

  /** True when this hit must not be counted; it is logged, never stamped. */
  private isMachine(recipientId: string, kind: string, hit: TrackingHit | undefined, sentAt?: Date | null): boolean {
    const reason = machineHitReason(hit, sentAt);
    if (!reason) return false;
    // Deliberately not written to the row: stamping the FIRST hit would mark
    // the recipient a machine forever and hide the real person's later open.
    this.logger.debug(`${kind} on recipient=${recipientId} not counted (${reason})`);
    return true;
  }

  /**
   * Honour an unsubscribe click. `false` means "this token is not ours"; a
   * genuine failure THROWS, because the controller has to answer a retryable
   * 5xx rather than render "you have been unsubscribed" over a flag that was
   * never written (`unsubscribe-post-swallows`).
   *
   * Two kinds of token resolve here, and the second one is the whole reason
   * workflow/drip mail can carry a footer link at all (R1): the per-recipient
   * token a campaign minted at launch, and a signed lead-scoped token for mail
   * that never had a CampaignRecipient row.
   */
  async unsubscribe(token: string): Promise<boolean> {
    const subject = await this.resolveSubject(token);
    if (!subject) return false;

    if (subject.kind === 'lead') {
      // Lead tokens are EMAIL-only by construction (see the token module): SMS
      // and WhatsApp opt-out run through İYS and the NetGSM blacklist, which
      // this path deliberately does not touch.
      await this.optOutEmail(subject.workspaceId, subject.leadId, 'lead-token');
      await this.emitEngagement('unsubscribed', `lead:${subject.leadId}`, {
        workspaceId: subject.workspaceId,
        leadId: subject.leadId,
        campaignId: null,
        recipientId: null,
      });
      return true;
    }

    const r = subject.r;
    const channel = await this.channelOf(r);
    // An unrecognised channel is treated as EMAIL, all the way down: it is the
    // one opt-out with no external side effect to get wrong.
    const flag = CHANNEL_OPT_OUT[channel] ?? CHANNEL_OPT_OUT.EMAIL;
    if (channel === 'SMS') {
      // The flip + the follow-on blacklist-sync event both happen inside
      // emitSmsOptOutEvent's own transaction (see its docstring).
      await this.emitSmsOptOutEvent(r.workspaceId, r.leadId, r.id);
    } else if (flag.column === 'emailOptOut') {
      await this.optOutEmail(r.workspaceId, r.leadId, 'unsubscribe-link');
      // Only this branch: the SMS one already raises SmsOptedOut, and a second
      // event there would double-start any automation listening to both.
      await this.emitEngagement('unsubscribed', r.id, {
        workspaceId: r.workspaceId,
        leadId: r.leadId,
        campaignId: r.campaignId,
        recipientId: r.id,
      });
    } else {
      await this.flipAndRecord(r.workspaceId, r.leadId, flag.column, flag.consent, 'unsubscribe-link');
    }

    if (r.status !== 'UNSUBSCRIBED') {
      // Race-safe claim: only the first hit flips the status + counts (the opt-out
      // above is idempotent and always runs, so consent is honored regardless).
      const claim = await this.prisma.campaignRecipient.updateMany({
        where: { id: r.id, status: { not: 'UNSUBSCRIBED' } },
        data: { status: 'UNSUBSCRIBED' },
      });
      if (claim.count === 1) await this.bump(r.campaignId, 'unsubscribed');
    }
    return true;
  }

  /**
   * The language the confirm/result page is written in (G8).
   *
   * Read from the workspace whose mail the link came out of, so the page
   * matches the message the recipient is holding. It never throws and never
   * runs as part of the opt-out: a language lookup that failed must not be able
   * to turn a successful unsubscribe into a 5xx.
   */
  async pageLang(token: string): Promise<MailLang> {
    try {
      const subject = await this.resolveSubject(token);
      const workspaceId = subject
        ? subject.kind === 'lead'
          ? subject.workspaceId
          : subject.r.workspaceId
        : null;
      if (!workspaceId) return DEFAULT_MAIL_LANG;
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { defaultLanguage: true },
      });
      return resolveMailLang(ws?.defaultLanguage);
    } catch (e: any) {
      this.logger.warn(`Could not resolve the unsubscribe page language: ${e?.message ?? e}`);
      return DEFAULT_MAIL_LANG;
    }
  }

  /**
   * Recipient token first, then the signed lead token. That order matters: a
   * recipient token is a DB fact and a lead token is a claim, so the cheaper,
   * stronger answer wins and a forged claim can never shadow a real row.
   */
  private async resolveSubject(token: string): Promise<UnsubscribeSubject | null> {
    const r = (await this.prisma.campaignRecipient.findUnique({ where: { token } })) as CampaignRecipientRow | null;
    if (r) return { kind: 'recipient', r };
    const claim = verifyLeadUnsubscribeToken(token);
    if (!claim) return null;
    return { kind: 'lead', workspaceId: claim.workspaceId, leadId: claim.leadId };
  }

  /**
   * Which opt-out this click is about.
   *
   * The recipient row carries its own frozen `channel`, so deleting the
   * campaign can no longer turn an email opt-out into a WhatsApp one while
   * still answering "unsubscribed" (`unsubscribe-deleted-campaign`). The
   * campaign is only consulted for rows written before that column existed.
   *
   * When NEITHER knows, the answer is EMAIL — never a guess onto the SMS path.
   * That path pushes an İYS `RET` and an ACCOUNT-WIDE NetGSM blacklist entry,
   * which would also stop the customer's transactional and OTP messages to
   * that number; "stop mailing me" must not cost them their one-time codes.
   */
  private async channelOf(r: CampaignRecipientRow): Promise<string> {
    if (r.channel) return r.channel;
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: r.campaignId, workspaceId: r.workspaceId },
      select: { channel: true },
    });
    return campaign?.channel ?? 'EMAIL';
  }

  /**
   * Email opt-out is decided for the ADDRESS, not for one lead row: the same
   * person is often on file twice, and unsubscribing through one copy used to
   * leave the next campaign free to mail the other (`optout-per-lead-row`).
   * `SuppressionService` owns that projection AND the ConsentRecord that has to
   * accompany every flag flip, in one transaction.
   *
   * A lead with no address on file still gets the flag and the ledger row —
   * suppression has nothing to key on, but the person still asked us to stop.
   */
  private async optOutEmail(workspaceId: string, leadId: string, source: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { email: true, emailNormalized: true },
    });
    const address = lead?.emailNormalized || lead?.email || null;
    if (address) {
      await this.suppression.suppress(workspaceId, address, 'EMAIL', 'OPT_OUT', { source, leadId });
      return;
    }
    await this.flipAndRecord(workspaceId, leadId, 'emailOptOut', 'MARKETING_EMAIL', source);
  }

  /**
   * Flip one opt-out column and record the withdrawal with it, atomically.
   *
   * The flip is conditional on the lead NOT already carrying the flag — the
   * same "pending" idiom `SuppressionService` projects with. The end state is
   * identical, and it is what makes a retried One-Click POST (mail clients and
   * providers do retry) stop at one ConsentRecord instead of appending a new
   * one per delivery (`unsubscribe-no-consent-record`).
   */
  private async flipAndRecord(
    workspaceId: string,
    leadId: string,
    column: 'emailOptOut' | 'smsOptOut' | 'waOptOut',
    type: ConsentType,
    source: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const flip = await tx.lead.updateMany({
        where: { id: leadId, workspaceId, [column]: false },
        data: { [column]: true },
      });
      if (flip.count) await this.recordWithdrawal(tx, workspaceId, leadId, type, source);
    });
  }

  /** One dated, sourced ConsentRecord — the repo's rule is that no opt-out flag
   *  moves without one (mcp/tools/consent.tools.ts). */
  private async recordWithdrawal(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    leadId: string,
    type: ConsentType,
    source: string,
  ): Promise<void> {
    await this.ledger.record({ workspaceId, leadIds: [leadId], type, granted: false, source }, tx);
  }

  /**
   * Flips the lead's smsOptOut flag and mirrors the unsubscribe onto
   * NetgsmBlacklistSyncService via the outbox (defense-in-depth NetGSM
   * account-blacklist sync — see that service's docstring), both inside ONE
   * $transaction — the standard outbox idiom used by every other producer in
   * this codebase (state write + event insert atomic together when the
   * append succeeds). Keyed on the recipient row id so a retried/duplicate
   * POST of the SAME unsubscribe click collapses into one outbox row.
   *
   * The one difference from those producers: this event is best-effort — the
   * opt-out flag itself is the durable compliance record; the blacklist sync
   * is only defense-in-depth — so a failure reading the lead's phone OR
   * appending the event must NEVER fail the request, undo the flip, or skip
   * the UNSUBSCRIBED status bump that runs right after this call returns. A
   * plain try/catch around those two steps is NOT enough to protect the
   * flip: Postgres aborts the WHOLE transaction the instant any statement
   * inside it errors, and Prisma silently turns the eventual COMMIT into a
   * no-op ROLLBACK even when the JS error was caught (verified empirically
   * against a real Postgres instance — a caught inner error still discarded
   * every earlier write in the same interactive transaction). The SAVEPOINT
   * below isolates the read+append: on failure, only that sub-scope rolls
   * back and the flip commits normally.
   *
   * Phase 2 Task 3 (İYS auto-push) adds a SECOND, INDEPENDENT savepoint block
   * right after this one that enqueues an IysSyncJob (direction RET — a
   * public unsubscribe is always an opt-out) via IysSyncService — its own
   * savepoint (not shared with the blacklist-mirror block above) so a
   * failure in EITHER best-effort mirror can never take down the other, and
   * neither can ever touch the smsOptOut flip or the UNSUBSCRIBED status
   * bump that runs right after this call returns.
   */
  private async emitSmsOptOutEvent(workspaceId: string, leadId: string, recipientId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Conditional on the flag not being set yet, so the ConsentRecord below
      // is written exactly once per actual withdrawal however many times a
      // provider redelivers the One-Click POST. The end state is unchanged.
      const flip = await tx.lead.updateMany({
        where: { id: leadId, workspaceId, smsOptOut: false },
        data: { smsOptOut: true },
      });
      // Deliberately OUTSIDE the two savepoints below: the ledger row is part
      // of the compliance record, not a best-effort mirror, so it commits with
      // the flip or the whole request fails and is retried.
      if (flip.count) await this.recordWithdrawal(tx, workspaceId, leadId, 'MARKETING_SMS', 'unsubscribe-link');
      await tx.$executeRawUnsafe('SAVEPOINT sp_sms_optout_event');
      try {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
        if (lead?.phone) {
          await this.outbox.append(
            {
              type: MarketingEventTypes.SmsOptedOut,
              tenantId: null,
              payload: { workspaceId, leadId, phone: lead.phone } satisfies MarketingSmsOptStatusPayload,
              idempotencyKey: `${workspaceId}:${leadId}:${MarketingEventTypes.SmsOptedOut}:unsub:${recipientId}`,
            },
            tx,
          );
        }
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp_sms_optout_event');
      } catch (e: any) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp_sms_optout_event');
        this.logger.warn(`Failed to enqueue ${MarketingEventTypes.SmsOptedOut} for lead=${leadId}: ${e?.message ?? e}`);
      }

      await tx.$executeRawUnsafe('SAVEPOINT sp_iys_enqueue');
      try {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
        await this.iysSync.enqueueConsent(tx, {
          workspaceId,
          leadId,
          recipient: lead?.phone,
          direction: 'RET',
          source: 'HS_MESAJ',
          consentAt: new Date(),
        });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT sp_iys_enqueue');
      } catch (e: any) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT sp_iys_enqueue');
        this.logger.warn(`Failed to enqueue İYS sync job for lead=${leadId}: ${e?.message ?? e}`);
      }
    });
  }

  /**
   * Tell the workflow engine what this recipient just did
   * (`no-email-event-triggers`).
   *
   * Best-effort and always OUTSIDE a transaction. The claims above are bare
   * conditional `updateMany`s rather than interactive transactions precisely so
   * this append cannot take one down with it: a caught error inside a Prisma
   * interactive transaction still turns the COMMIT into a ROLLBACK (the trap
   * `emitSmsOptOutEvent` needs savepoints for), which would discard the very
   * claim the event is reporting and have the open re-counted on the next hit.
   *
   * The key is deterministic so a redelivery — an event the outbox retries, a
   * provider re-POSTing — collapses into one row and the executor's
   * start(..., event.id) dedupe cannot double-enrol the lead.
   */
  private async emitEngagement(
    kind: EmailEngagementKind,
    subjectKey: string,
    payload: Omit<MarketingEmailEngagementPayload, 'occurredAt'>,
  ): Promise<void> {
    const type = EMAIL_ENGAGEMENT_EVENT[kind];
    try {
      await this.outbox.append({
        type,
        tenantId: null,
        payload: { ...payload, occurredAt: new Date().toISOString() } satisfies MarketingEmailEngagementPayload,
        idempotencyKey: `${payload.workspaceId}:${type}:${subjectKey}`,
      });
    } catch (e: any) {
      this.logger.warn(`Failed to enqueue ${type} for ${subjectKey}: ${e?.message ?? e}`);
    }
  }

  /**
   * Atomically increment one analytics counter in the campaign's JSON stats.
   * A single jsonb_set UPDATE (no read-modify-write), so concurrent open/click
   * pixels across different recipients of the same campaign can't lose
   * increments. `key` is a fixed internal literal (never user input).
   */
  private async bump(
    campaignId: string,
    key: 'opened' | 'clicked' | 'unsubscribed',
  ): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE "campaigns"
         SET "stats" = jsonb_set(
           COALESCE("stats", '{}'::jsonb),
           ARRAY[$1],
           to_jsonb(COALESCE(("stats"->>$1)::int, 0) + 1),
           true)
       WHERE "id" = $2`,
      key,
      campaignId,
    );
  }
}
