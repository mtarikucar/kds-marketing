import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { NetgsmReportClient } from './netgsm-report.client';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { SmsV2Client, SmsV2ReportRow } from '../../netgsm/sms/sms-v2.client';
import { mapNetgsmDlr, mapNetgsmV2Status } from './netgsm-dlr.util';

/** The minimal Channel-row shape this poller reads; `select`ed explicitly
 *  (rather than relying on the default full-row fetch) so `workspaceId` is
 *  always a literal in the query args — satisfies both the actual grouping
 *  need and `workspace-scoping.arch.spec.ts`'s static check. */
interface ChannelRow {
  id: string;
  workspaceId: string;
  type: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/** ACTIVE, non-legacy-flagged SMS channels sharing one NetGSM account
 *  (usercode) — the unit the per-account report budget is keyed on. A single
 *  account can back more than one channel/workspace (agencies sharing one
 *  NetGSM contract), so 1:1 messages and campaign recipients across every
 *  member workspace are polled together, bounded by ONE shared budget. */
interface AccountGroup {
  usercode: string;
  password: string;
  channelIds: string[];
  workspaceIds: string[];
}

const JOBID_BATCH = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Last 10 digits of any phone-ish string (strips formatting/country code) —
 *  used only as the FALLBACK attribution key when a report row's referansId
 *  doesn't resolve (see pollV2Campaigns). */
function last10Digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '').slice(-10);
}

/**
 * Tolerant best-effort parse of NetGSM's `deliveredDate` (documented shape is
 * roughly `ddMMyyyyHHmmss`/`ddMMyyyyHHmm`, TR local time, but the exact
 * separators/length are account-dependent — mirrors this file's parsing
 * philosophy elsewhere: never throw, never block a write over a cosmetic
 * timestamp). Any string with at least a `ddMMyyyyHHmm` digit run parses;
 * anything else (or an unparseable date) falls back to "now" rather than
 * leaving `deliveredAt` unset — a slightly-off timestamp beats a missing one.
 */
function parseDeliveredAt(raw: string | null): Date {
  if (raw) {
    const d = raw.replace(/\D/g, '');
    if (d.length >= 12) {
      const day = Number(d.slice(0, 2));
      const month = Number(d.slice(2, 4)) - 1;
      const year = Number(d.slice(4, 8));
      const hour = Number(d.slice(8, 10));
      const minute = Number(d.slice(10, 12));
      const second = d.length >= 14 ? Number(d.slice(12, 14)) : 0;
      const parsed = new Date(year, month, day, hour, minute, second);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}

/**
 * Polls NetGSM delivery reports (NetGSM does NOT push them). Once a minute,
 * advisory-locked (single replica, mirrors the offer-expire sweeper), it
 * covers two independent surfaces:
 *
 *  1. 1:1 conversation messages (Message rows) — the two-way customer-service
 *     delivery confirmation the integration is for.
 *  2. Campaign blast recipients (CampaignRecipient rows) — delivery tracking
 *     for bulk sends, new in Phase 1 (campaigns previously had none).
 *
 * ACTIVE SMS channels are enumerated globally (Phase 0's "union fix" pattern:
 * one `channel.findMany` across all workspaces rather than a per-workspace
 * loop) and split in two:
 *  - Legacy-flag channels (`configPublic.useLegacySend === true`) keep the
 *    OLD single-bulkid `NetgsmReportClient` path, fully preserved, one
 *    channel/workspace at a time.
 *  - Everything else groups by NetGSM account (`usercode`) and polls via
 *    `SmsV2Client.report`, batched ≤50 jobids per call.
 *
 * Every report CALL (legacy or v2, 1:1 or campaign) spends one unit of that
 * account's `AccountRateBudgeter.tryTake(usercode, 'report', 60, 60_000)`
 * budget — NetGSM's real per-account cap. A budget denial stops further
 * report calls for THAT account this tick only; every other account's
 * processing is untouched (no more global MAX_REPORTS_PER_TICK).
 *
 * Every write remains id-keyed (Message.update / CampaignRecipient.update by
 * `id`) — even though a batch's reads can span several workspaces of the same
 * NetGSM account for efficiency, no write can ever address a row outside the
 * workspace it was read from, so this system cron never crosses tenants
 * (mirrors the offer-expire sweeper / workspace-scoping.arch.spec.ts's
 * id-keyed-write exemption).
 */
@Injectable()
export class NetgsmDlrPollService {
  private readonly logger = new Logger(NetgsmDlrPollService.name);

  /** Only poll sends from the recent past; older ones age out (no report kept). */
  private static readonly WINDOW_HOURS = 72;
  /** NetGSM's documented per-account report-endpoint cap (both legacy and v2
   *  report calls draw from this same account-level budget). */
  private static readonly REPORT_LIMIT = 60;
  private static readonly REPORT_WINDOW_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly legacyReport: NetgsmReportClient,
    private readonly smsV2: SmsV2Client,
    private readonly budgeter: AccountRateBudgeter,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'netgsm-dlr-poll' })
  async pollDueReports(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'netgsm-dlr-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ polled: number; updated: number }> {
    const since = new Date(Date.now() - NetgsmDlrPollService.WINDOW_HOURS * 3_600_000);

    // Enumerate ACTIVE SMS channels globally (no workspace loop) — each row
    // carries its own workspaceId, which every downstream query below uses.
    const channels = await this.prisma.channel.findMany({
      where: { type: 'SMS', status: 'ACTIVE' },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    });
    if (channels.length === 0) return { polled: 0, updated: 0 };

    let polled = 0;
    let updated = 0;

    // Legacy-flag channels: OLD per-bulkid path, fully preserved.
    for (const ch of channels.filter((c) => this.isLegacy(c))) {
      const r = await this.pollLegacyChannel(ch, since);
      polled += r.polled;
      updated += r.updated;
    }

    // Everything else: group by NetGSM account and poll via REST v2 report.
    const accounts = this.buildAccountGroups(channels.filter((c) => !this.isLegacy(c)));
    for (const account of accounts.values()) {
      const messages = await this.pollV2Messages(account, since);
      polled += messages.polled;
      updated += messages.updated;

      const campaigns = await this.pollV2Campaigns(account, since);
      polled += campaigns.polled;
      updated += campaigns.updated;
    }

    if (updated > 0) {
      this.logger.log(`netgsm-dlr-poll: updated ${updated} of ${polled} polled report(s)`);
    }
    return { polled, updated };
  }

  private isLegacy(ch: { configPublic: unknown }): boolean {
    const pub =
      ch.configPublic && typeof ch.configPublic === 'object'
        ? (ch.configPublic as Record<string, unknown>)
        : {};
    return pub.useLegacySend === true;
  }

  private buildAccountGroups(channels: ChannelRow[]): Map<string, AccountGroup> {
    const groups = new Map<string, AccountGroup>();
    for (const ch of channels) {
      const { secrets } = this.registry.resolveConfig(ch);
      if (!secrets.usercode || !secrets.password) continue;
      let group = groups.get(secrets.usercode);
      if (!group) {
        group = { usercode: secrets.usercode, password: secrets.password, channelIds: [], workspaceIds: [] };
        groups.set(secrets.usercode, group);
      }
      group.channelIds.push(ch.id);
      if (!group.workspaceIds.includes(ch.workspaceId)) group.workspaceIds.push(ch.workspaceId);
    }
    return groups;
  }

  /** OLD single-bulkid report path, scoped to one legacy-flagged channel
   *  (one workspace) — behavior-preserving relative to the pre-v2 poller,
   *  just budgeted per-account instead of by a global per-tick cap. */
  private async pollLegacyChannel(
    ch: ChannelRow,
    since: Date,
  ): Promise<{ polled: number; updated: number }> {
    const { secrets } = this.registry.resolveConfig(ch);
    if (!secrets.usercode || !secrets.password) return { polled: 0, updated: 0 };

    const convos = await this.prisma.conversation.findMany({
      where: { workspaceId: ch.workspaceId, channelId: ch.id, lastMessageAt: { gte: since } },
      select: { id: true },
    });
    if (convos.length === 0) return { polled: 0, updated: 0 };

    const candidates = await this.prisma.message.findMany({
      where: {
        workspaceId: ch.workspaceId,
        conversationId: { in: convos.map((c) => c.id) },
        direction: 'OUTBOUND',
        status: 'SENT',
        externalMessageId: { not: null },
        createdAt: { gte: since },
      },
      select: { id: true, externalMessageId: true },
      orderBy: { createdAt: 'asc' },
      // Query-level cap restored: one account-minute of report budget
      // (REPORT_LIMIT), so this candidate fetch can never outgrow what a
      // single tick could possibly spend on this account, regardless of how
      // many OUTBOUND/SENT messages accumulate in the window.
      take: NetgsmDlrPollService.REPORT_LIMIT,
    });

    let polled = 0;
    let updated = 0;
    for (const msg of candidates) {
      if (!this.budgeter.tryTake(secrets.usercode, 'report', NetgsmDlrPollService.REPORT_LIMIT, NetgsmDlrPollService.REPORT_WINDOW_MS)) {
        break; // account budget exhausted this tick — resume next tick
      }
      polled++;
      let row;
      try {
        row = await this.legacyReport.fetchStatus(
          { usercode: secrets.usercode, password: secrets.password },
          msg.externalMessageId as string,
        );
      } catch (e: any) {
        this.logger.warn(`netgsm legacy report fetch failed for bulkid=${msg.externalMessageId}: ${e?.message ?? e}`);
        continue;
      }
      if (!row) continue;

      const mapping = mapNetgsmDlr(row.durumcode, row.hatakod ?? undefined);
      if (!mapping.terminal) continue;

      await this.prisma.message.update({
        where: { id: msg.id },
        data: { status: mapping.status, error: mapping.reason },
      });
      updated++;
    }
    return { polled, updated };
  }

  /** 1:1 conversation messages sent via REST v2 for this account. Each v2
   *  send is single-recipient, so `externalMessageId` (the jobid) maps to
   *  exactly one Message row — jobids batch ≤50 per report() call. */
  private async pollV2Messages(
    account: AccountGroup,
    since: Date,
  ): Promise<{ polled: number; updated: number }> {
    const convos = await this.prisma.conversation.findMany({
      where: {
        workspaceId: { in: account.workspaceIds },
        channelId: { in: account.channelIds },
        lastMessageAt: { gte: since },
      },
      select: { id: true },
    });
    if (convos.length === 0) return { polled: 0, updated: 0 };

    const candidates = await this.prisma.message.findMany({
      where: {
        workspaceId: { in: account.workspaceIds },
        conversationId: { in: convos.map((c) => c.id) },
        direction: 'OUTBOUND',
        status: 'SENT',
        externalMessageId: { not: null },
        createdAt: { gte: since },
      },
      select: { id: true, externalMessageId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) return { polled: 0, updated: 0 };

    const byJobid = new Map(candidates.map((m) => [m.externalMessageId as string, m]));
    let polled = 0;
    let updated = 0;

    for (const jobidBatch of chunk([...byJobid.keys()], JOBID_BATCH)) {
      if (!this.budgeter.tryTake(account.usercode, 'report', NetgsmDlrPollService.REPORT_LIMIT, NetgsmDlrPollService.REPORT_WINDOW_MS)) {
        break; // account budget exhausted this tick — remaining batches resume next tick
      }
      polled += jobidBatch.length;

      let result;
      try {
        result = await this.smsV2.report({ usercode: account.usercode, password: account.password }, jobidBatch);
      } catch (e: any) {
        this.logger.warn(`netgsm v2 report fetch failed for account ${account.usercode}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok) continue;

      for (const row of result.rows) {
        const msg = byJobid.get(row.jobid);
        if (!msg) continue; // report answered for a jobid outside this batch — ignore

        const mapping = mapNetgsmV2Status(row.status, row.errorCode);
        if (!mapping.terminal) continue;

        await this.prisma.message.update({
          where: { id: msg.id },
          data: { status: mapping.status, error: mapping.reason },
        });
        updated++;
      }
    }
    return { polled, updated };
  }

  /** Campaign blast recipients sent via REST v2 for this account. Unlike 1:1
   *  sends, one jobid covers MANY recipients (true n:n bulk) — grouped by
   *  jobid, one report() call per ≤50-jobid chunk covers every recipient of
   *  those jobids. Rows are attributed back by `referansId` (= the
   *  recipient's own id, per campaign-sender's sendSmsBatch), falling back to
   *  a last-10-digit `telno` match against the recipient's lead phone. A
   *  report row that matches NEITHER — e.g. the residual duplicate-batch
   *  window flagged in Task 5's fix round, where a jobid's rows can outlive
   *  the specific recipient set that jobid was last stamped on — is TOLERATED
   *  and skipped silently; it is not this poller's job to reconcile a wire
   *  send that no longer corresponds to any pending recipient. */
  private async pollV2Campaigns(
    account: AccountGroup,
    since: Date,
  ): Promise<{ polled: number; updated: number }> {
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: {
        workspaceId: { in: account.workspaceIds },
        deliveryStatus: null,
        netgsmJobId: { not: null },
        sentAt: { gte: since },
      },
      select: { id: true, workspaceId: true, campaignId: true, leadId: true, netgsmJobId: true, referansId: true },
      orderBy: { sentAt: 'asc' },
    });
    if (recipients.length === 0) return { polled: 0, updated: 0 };

    // CampaignRecipient has no Prisma relation to Lead (leadId is a bare FK) —
    // fetch phones separately for the telno fallback-match path.
    const leadIds = [...new Set(recipients.map((r) => r.leadId))];
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId: { in: account.workspaceIds }, id: { in: leadIds } },
      select: { id: true, phone: true },
    });
    const phoneByLeadId = new Map(leads.map((l) => [l.id, l.phone]));

    const byJobid = new Map<string, typeof recipients>();
    for (const r of recipients) {
      const jobid = r.netgsmJobId as string;
      const list = byJobid.get(jobid);
      if (list) list.push(r);
      else byJobid.set(jobid, [r]);
    }

    let polled = 0;
    let updated = 0;
    const touchedCampaigns = new Map<string, string>(); // campaignId -> workspaceId

    for (const jobidBatch of chunk([...byJobid.keys()], JOBID_BATCH)) {
      if (!this.budgeter.tryTake(account.usercode, 'report', NetgsmDlrPollService.REPORT_LIMIT, NetgsmDlrPollService.REPORT_WINDOW_MS)) {
        break; // account budget exhausted this tick — remaining batches resume next tick
      }
      polled += jobidBatch.reduce((n, j) => n + (byJobid.get(j)?.length ?? 0), 0);

      let result;
      try {
        result = await this.smsV2.report({ usercode: account.usercode, password: account.password }, jobidBatch);
      } catch (e: any) {
        this.logger.warn(`netgsm v2 campaign report fetch failed for account ${account.usercode}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok) continue;

      // One recipient is attributed at most once per tick — so distinct report
      // rows map to DISTINCT recipients. Without this, two rows that resolve to
      // the same recipient (a duplicate/stale referansId, or — on the telno
      // fallback — two recipients of this jobid that share a phone) both matched
      // group.find()'s FIRST hit: one recipient was updated twice and the other
      // was orphaned at deliveryStatus null (stuck, re-polled until it aged out).
      const claimed = new Set<string>();
      for (const row of result.rows) {
        const group = byJobid.get(row.jobid);
        if (!group) continue; // report answered for a jobid outside this batch — ignore

        const recipient = this.attributeCampaignRow(row, group, phoneByLeadId, claimed);
        if (!recipient) continue; // no matching (unclaimed) recipient — TOLERATE, skip silently
        claimed.add(recipient.id);

        const mapping = mapNetgsmV2Status(row.status, row.errorCode);
        if (!mapping.terminal) continue; // stays unresolved (deliveryStatus null) — re-polled next tick

        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            deliveryStatus: mapping.status, // terminal ⇒ 'DELIVERED' | 'FAILED'
            deliveredAt: parseDeliveredAt(row.deliveredDate),
            errorCode: row.errorCode,
          },
        });
        updated++;
        touchedCampaigns.set(recipient.campaignId, recipient.workspaceId);
      }
    }

    for (const [campaignId, workspaceId] of touchedCampaigns) {
      await this.rollupCampaignStats(workspaceId, campaignId);
    }
    return { polled, updated };
  }

  /** Attribute one report row to a recipient of its jobid group: primary key
   *  is `referansId` (= recipient id, stamped at send time); fallback is a
   *  last-10-digit match of the row's `telno` against the recipient's lead
   *  phone. Returns undefined (never throws) when neither resolves. */
  private attributeCampaignRow(
    row: SmsV2ReportRow,
    group: Array<{ id: string; workspaceId: string; campaignId: string; leadId: string }>,
    phoneByLeadId: Map<string, string | null>,
    claimed: Set<string>,
  ): { id: string; workspaceId: string; campaignId: string } | undefined {
    if (row.referansId) {
      const byId = group.find((r) => r.id === row.referansId && !claimed.has(r.id));
      if (byId) return byId;
    }
    if (row.telno) {
      const rowLast10 = last10Digits(row.telno);
      if (rowLast10) {
        const byPhone = group.find(
          (r) => !claimed.has(r.id) && last10Digits(phoneByLeadId.get(r.leadId)) === rowLast10,
        );
        if (byPhone) return byPhone;
      }
    }
    return undefined;
  }

  /** Rolls delivered/undelivered counters into `campaign.stats` — a MERGE
   *  (spreads the existing blob) rather than `recomputeStats`'s
   *  rebuild-from-rows, so this never clobbers keys owned by other writers
   *  (sent/failed/skipped/opened/clicked/unsubscribed). */
  private async rollupCampaignStats(workspaceId: string, campaignId: string): Promise<void> {
    const [delivered, undelivered] = await Promise.all([
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, deliveryStatus: 'DELIVERED' } }),
      this.prisma.campaignRecipient.count({ where: { workspaceId, campaignId, deliveryStatus: 'FAILED' } }),
    ]);
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { stats: true },
    });
    if (!campaign) return;
    const stats = campaign.stats && typeof campaign.stats === 'object' ? (campaign.stats as Record<string, unknown>) : {};
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: { ...stats, delivered, undelivered } as Prisma.InputJsonValue },
    });
  }
}
