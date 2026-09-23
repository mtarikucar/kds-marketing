import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeAddress } from '../../../common/util/email-address';
import { SuppressionService } from '../compliance/suppression.service';
import { signLeadUnsubscribeToken } from '../channels/lead-unsubscribe.token';
import { OutboundMailService } from '../channels/outbound/outbound-mail.service';
import { MailOutcome, MailReason, MailTransport } from '../channels/outbound/outbound-mail.types';
import { SenderIdentity } from '../channels/outbound/sender-identity.service';
import { CampaignsService, EMAIL_SUBJECT_REQUIRED, RULES_ONLY_CHANNEL } from './campaigns.service';

/** Why a lead the audience rules matched will not be mailed. */
export interface AudienceExclusions {
  /** Unsubscribed from marketing mail on this channel. */
  optedOut: number;
  /** A hard bounce is on file for the address. */
  bounced: number;
  /** The address is known to be undeliverable. */
  invalid: number;
  /** On the suppression list for a reason the lead row does not carry —
   *  a complaint, an erasure tombstone, or another lead sharing the address. */
  suppressed: number;
  /** No address at all on this channel. */
  noEmail: number;
}

export interface AudiencePreview {
  channel: string;
  /** What the send will actually attempt. */
  matched: number;
  excluded: AudienceExclusions;
  /** Suppression was only checked for the first `SUPPRESSION_SAMPLE` addresses,
   *  so `suppressed` is a floor and `matched` a ceiling. */
  truncated: boolean;
  /** Absent only when the gateway could not answer at all — the card then says
   *  nothing about the sender rather than inventing an identity. */
  sender?: {
    /** False only for something that stops the WHOLE campaign. */
    ok: boolean;
    transport: MailTransport;
    from: { email: string; name: string; replyTo?: string };
    degraded?: SenderIdentity['degraded'];
    reason?: MailReason;
  };
}

export interface TestSendResult {
  ok: boolean;
  outcome: MailOutcome;
  to: string;
  transport: MailTransport;
  reason?: MailReason;
  userMessage?: { key: string; vars?: Record<string, string> };
  error?: string;
}

/**
 * How many addresses the suppression breakdown reads before it stops.
 *
 * `checkMany` is two queries for the whole batch, but the addresses still have
 * to be fetched, and a pre-launch card is not the place to stream a 50k-lead
 * audience out of Postgres. Past this the card says so (`truncated`) rather
 * than quietly reporting a number it did not measure.
 */
const SUPPRESSION_SAMPLE = 5000;

/**
 * Reasons the gate can return that are about the ADDRESS the preflight ran
 * against — the operator's own — and therefore say nothing about the audience.
 *
 * The preflight needs a recipient to run at all (§A1 gate 1), and the only
 * address on hand before a blast is the person looking at the screen. Their
 * own opt-out must not be reported as "this campaign will not send".
 */
const ADDRESS_SCOPED_REASONS: ReadonlySet<MailReason> = new Set<MailReason>([
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

/**
 * What the sender is allowed to know BEFORE the irreversible part.
 *
 * A campaign launch is the one action in the product that cannot be undone,
 * and until now it was a single click onto a confirm dialog that knew nothing:
 * not how many people it would reach, not who had been dropped and why, not
 * which address it would go out from, and with no way to see the mail itself
 * first (`prelaunch-safety`). An empty filter row was silently discarded on the
 * way, so "status = (blank)" quietly meant "everybody".
 *
 * Everything here is a READ plus one deliberate send. The counting reuses
 * `CampaignsService.resolveAudienceWhere` — the same predicate `launch()`
 * freezes the audience with — so the number on the card and the number in the
 * blast cannot drift apart. The sender block reuses the gateway's own
 * `preflight()`, which spends no quota and writes no ledger row.
 */
@Injectable()
export class CampaignPreviewService {
  private readonly logger = new Logger(CampaignPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly suppression: SuppressionService,
    private readonly outboundMail: OutboundMailService,
    private readonly config: ConfigService,
  ) {}

  /** Who this campaign would reach right now, and who it would not. */
  async audience(workspaceId: string, campaignId: string): Promise<AudiencePreview> {
    const campaign = await this.loadCampaign(workspaceId, campaignId);
    const channel = campaign.channel;

    // The send-time predicate, verbatim. Anything else here is a second
    // implementation of the audience, which is the bug this endpoint exists to
    // prevent.
    const sendWhere = await this.campaigns.resolveAudienceWhere(
      workspaceId,
      channel,
      campaign.audienceFilter,
    );
    // The same rules WITHOUT the reachability half, so each exclusion can be
    // counted on its own. `buildAudienceWhere` only adds reachability for the
    // channels it knows, so asking it about no channel asks it for the rules.
    const ruleWhere = (await this.campaigns.resolveAudienceWhere(
      workspaceId,
      RULES_ONLY_CHANNEL,
      campaign.audienceFilter,
    )) as Record<string, unknown>;

    const [matchedCount, ...excludedCounts] = await Promise.all([
      this.count(workspaceId, sendWhere),
      // A bucket that does not exist on this channel is a ZERO, never a query:
      // an empty `where` here would count every lead in the workspace and
      // report them as bounced.
      ...this.exclusionWheres(channel, ruleWhere).map((w) => (w ? this.count(workspaceId, w) : 0)),
    ]);
    const [optedOut, bounced, invalid, noEmail] = excludedCounts;

    const { suppressed, truncated } = await this.suppressedInAudience(workspaceId, channel, sendWhere);

    return {
      channel,
      matched: Math.max(0, matchedCount - suppressed),
      excluded: { optedOut, bounced, invalid, suppressed, noEmail },
      truncated,
      ...(await this.sender(workspaceId, campaign)),
    };
  }

  /**
   * One copy of this campaign to the person about to launch it.
   *
   * It goes through the gateway as BULK, exactly like the blast: same identity
   * ladder, same gates, same footer. What it deliberately does NOT do is touch
   * anything the campaign counts — no `CampaignRecipient` row, no stats bump,
   * and its own `source`, so the ledger can tell a rehearsal from the thing
   * itself.
   */
  async testSend(
    workspaceId: string,
    campaignId: string,
    actor: { id: string; email: string },
  ): Promise<TestSendResult> {
    const campaign = await this.loadCampaign(workspaceId, campaignId);
    if (campaign.channel !== 'EMAIL') {
      throw new BadRequestException('Only an email campaign can be test-sent');
    }
    const to = (actor.email ?? '').trim();
    if (!to) throw new BadRequestException('Your account has no email address to send a test to');
    const subject = (campaign.subject ?? '').trim();
    // The same rule `launch()` enforces, asked earlier: a rehearsal that ships
    // "Update" would teach the operator the wrong thing about their campaign.
    if (!subject) throw new BadRequestException(EMAIL_SUBJECT_REQUIRED);

    const unsubscribe = await this.testUnsubscribe(workspaceId, campaignId, to);
    const receipt = await this.outboundMail.send({
      workspaceId,
      mailClass: 'BULK',
      to,
      subject,
      text: this.neutralizeMergeTags(campaign.body ?? ''),
      ...(campaign.bodyHtml ? { html: this.neutralizeMergeTags(campaign.bodyHtml) } : {}),
      ...(unsubscribe.leadId ? { leadId: unsubscribe.leadId } : {}),
      ...(unsubscribe.link ? { unsubscribe: unsubscribe.link } : {}),
      ticari: campaign.iysMessageType === 'TICARI',
      // NOT `campaign:<id>`: that prefix is the campaign's own ledger slice and
      // is what attribution, the results panel and the ops snapshot read.
      source: `campaign-test:${campaignId}`,
      // Deliberately no idempotencyKey — an operator who fixes the copy and
      // tests again must actually receive the second mail.
    });

    return {
      ok: receipt.ok,
      outcome: receipt.outcome,
      to,
      transport: receipt.transport,
      ...(receipt.reason ? { reason: receipt.reason } : {}),
      ...(receipt.userMessage ? { userMessage: receipt.userMessage } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async loadCampaign(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        channel: true,
        subject: true,
        body: true,
        bodyHtml: true,
        iysMessageType: true,
        audienceFilter: true,
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  /** The tenant is re-named at the call site (not merely inside `where`), the
   *  way `launch()` does it — the scoping arch spec reads one call at a time. */
  private count(workspaceId: string, where: Prisma.LeadWhereInput): Promise<number> {
    return this.prisma.lead.count({ where: { ...where, workspaceId } });
  }

  /**
   * The four exclusion buckets, in one fixed order (optedOut, bounced,
   * invalid, noEmail) and mutually exclusive by construction: each one adds
   * the previous bucket's negation, so a lead that is both opted out and
   * bounced is counted once, under the reason the operator can act on first.
   */
  private exclusionWheres(
    channel: string,
    rules: Record<string, unknown>,
  ): Array<Prisma.LeadWhereInput | null> {
    if (channel === 'EMAIL') {
      const reachable = { email: { not: null } };
      return [
        { ...rules, ...reachable, emailOptOut: true },
        { ...rules, ...reachable, emailOptOut: false, emailBouncedAt: { not: null } },
        {
          ...rules,
          ...reachable,
          emailOptOut: false,
          emailBouncedAt: null,
          emailVerifiedStatus: 'INVALID',
        },
        { ...rules, email: null },
      ] as Array<Prisma.LeadWhereInput | null>;
    }
    if (channel === 'WHATSAPP') {
      // Reachability is an OR of two columns here, so "no address" is the
      // negation of both — pushed onto the AND array the rules may already own
      // (a key-level `AND` would clobber a tag/segment predicate).
      const ands = Array.isArray((rules as any).AND) ? ((rules as any).AND as any[]) : [];
      return [
        { ...rules, waOptOut: true, OR: [{ whatsapp: { not: null } }, { phone: { not: null } }] },
        // A phone number cannot hard-bounce or be syntactically invalid: those
        // two buckets are email-only.
        null,
        null,
        { ...rules, AND: [...ands, { whatsapp: null }, { phone: null }] },
      ] as Array<Prisma.LeadWhereInput | null>;
    }
    // SMS and VOICE both ring the same phone and share `smsOptOut`, exactly as
    // `buildAudienceWhere` treats them.
    return [
      { ...rules, phone: { not: null }, smsOptOut: true },
      null,
      null,
      { ...rules, phone: null },
    ] as Array<Prisma.LeadWhereInput | null>;
  }

  /**
   * How many of the reachable leads the GATE would still refuse.
   *
   * These are the ones no lead column can show: a spam complaint, an erasure
   * tombstone, or a suppression written against an address a DIFFERENT lead row
   * shares. `buildAudienceWhere` cannot express them, so the audience freeze
   * will happily materialise them and the sender will refuse them one by one —
   * this is where the operator finds out first.
   */
  private async suppressedInAudience(
    workspaceId: string,
    channel: string,
    sendWhere: Prisma.LeadWhereInput,
  ): Promise<{ suppressed: number; truncated: boolean }> {
    if (channel !== 'EMAIL') return { suppressed: 0, truncated: false };
    let rows: Array<{ email: string | null }>;
    try {
      rows = await this.prisma.lead.findMany({
        where: { ...sendWhere, workspaceId },
        select: { email: true },
        take: SUPPRESSION_SAMPLE + 1,
      });
    } catch (e: any) {
      // A preview that cannot read the suppression half still has a number
      // worth showing; it must not 500 the card.
      this.logger.warn(`audience suppression read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return { suppressed: 0, truncated: false };
    }
    const truncated = rows.length > SUPPRESSION_SAMPLE;
    const addresses = rows
      .slice(0, SUPPRESSION_SAMPLE)
      .map((r) => r.email)
      .filter((a): a is string => !!a);
    if (!addresses.length) return { suppressed: 0, truncated };
    const flagged = await this.suppression.checkMany(workspaceId, addresses, 'BULK');
    // Counted per LEAD, not per address: two lead rows sharing one suppressed
    // address are two recipients the send will refuse.
    return { suppressed: addresses.filter((a) => flagged.has(a)).length, truncated };
  }

  /** Who the mail will be from, and anything that stops the whole campaign. */
  private async sender(
    workspaceId: string,
    campaign: { id: string; subject: string | null; bodyHtml: string | null; iysMessageType: string | null },
  ): Promise<Pick<AudiencePreview, 'sender'>> {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').trim();
    let preflight;
    try {
      preflight = await this.outboundMail.preflight({
        workspaceId,
        mailClass: 'BULK',
        // The gate refuses to run without a recipient, and a preview has no one
        // recipient to name. A reserved-domain sentinel (RFC 2606) keeps the
        // address-shaped gates quiet — nobody is ever suppressed at
        // `.example` — so what comes back is about the CAMPAIGN: the identity
        // ladder, the kill switches, the send window. Anything address-scoped
        // is filtered out below in case one of them answers anyway.
        to: 'preview@audience.example',
        subject: campaign.subject ?? '',
        // Shaped like the real one (the campaign mints a per-recipient token at
        // freeze time) so the card learns about a missing PUBLIC_BASE_URL here
        // rather than from a whole blast that fails closed.
        ...(base ? { unsubscribe: { token: 'preview', url: `${base}/api/public/u/preview` } } : {}),
        ticari: campaign.iysMessageType === 'TICARI',
        source: `campaign:${campaign.id}`,
      });
    } catch (e: any) {
      // The audience half of the card is still worth showing; an identity we
      // could not resolve is simply left out rather than guessed at.
      this.logger.warn(`sender preflight failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return {};
    }

    const blocking =
      !preflight.ok && preflight.reason && !ADDRESS_SCOPED_REASONS.has(preflight.reason)
        ? preflight.reason
        : undefined;
    return {
      sender: {
        ok: !blocking,
        transport: preflight.transport,
        from: preflight.from,
        ...(preflight.degraded ? { degraded: preflight.degraded } : {}),
        ...(blocking ? { reason: blocking } : {}),
      },
    };
  }

  /**
   * The unsubscribe link on a rehearsal.
   *
   * When the operator is also on file as a lead — they often are, in their own
   * CRM — the footer carries that lead's real, deterministic token, so clicking
   * it does exactly what a recipient's click does. Otherwise there is nobody to
   * unsubscribe and the link is inert: the mail still carries one, because BULK
   * fails closed without it and a rehearsal must have the same shape as the
   * real thing.
   */
  private async testUnsubscribe(
    workspaceId: string,
    campaignId: string,
    to: string,
  ): Promise<{ leadId?: string; link?: { token: string; url: string } }> {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').trim();
    let leadId: string | undefined;
    try {
      const key = normalizeAddress(to);
      const lead = key
        ? await this.prisma.lead.findFirst({
            where: { workspaceId, emailNormalized: key, deletedAt: null, mergedIntoId: null },
            select: { id: true },
          })
        : null;
      leadId = lead?.id;
    } catch (e: any) {
      this.logger.warn(`test-send lead lookup failed (workspace=${workspaceId}): ${e?.message ?? e}`);
    }
    if (!base) return { ...(leadId ? { leadId } : {}) };
    const token = (leadId ? signLeadUnsubscribeToken(workspaceId, leadId) : null) ?? `test-${campaignId}`;
    return {
      ...(leadId ? { leadId } : {}),
      link: { token, url: `${base}/api/public/u/${token}` },
    };
  }

  /**
   * Strip the merge tags a rehearsal cannot fill.
   *
   * The real send substitutes them per recipient (`campaign-sender.service.ts`,
   * `interpolate`); a test send has no recipient, and shipping the braces to
   * the operator would teach them the campaign is broken when it is not. The
   * author's own `|default` wins, exactly as it does on the real path.
   */
  private neutralizeMergeTags(body: string): string {
    if (!body || !body.includes('{{')) return body;
    return body.replace(
      /\{\{\s*([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\s*(?:\|([^}]*))?\}\}/g,
      (_match: string, _field: string, fallback?: string) => (fallback ?? '').trim(),
    );
  }
}
