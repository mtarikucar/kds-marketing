import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { SmsV2Client } from '../../netgsm/sms/sms-v2.client';

/** NetGSM's documented per-jobid cap: one `/sms/rest/v2/stats` query per jobid
 *  every 10 minutes. The cron itself ticks every 15 minutes (> 10), so under
 *  normal operation every jobid clears its budget by the time it's next due. */
const STATS_LIMIT = 1;
const STATS_WINDOW_MS = 600_000;
/** Campaigns older than this (by completedAt) stop being polled — a SENT blast
 *  from weeks ago has long since settled and NetGSM's own jobid history ages out. */
const LOOKBACK_DAYS = 7;

type NetgsmCreds = { usercode: string; password: string };

/** Per-jobid rollup: NetGSM status string -> count, as last observed. */
type JobStatusCounts = Record<string, number>;

interface CampaignRow {
  id: string;
  workspaceId: string;
  status: string;
  completedAt: Date | null;
  netgsmJobIds: unknown;
  stats: unknown;
}

/**
 * Reconciles NetGSM's per-jobid `/sms/rest/v2/stats` rollups (delivered /
 * undelivered / blacklist / iysNotValid / repeated / refunded / …) into
 * `campaign.stats.sms` for SMS campaigns. Unlike `netgsm-dlr-poll.service.ts`
 * (which resolves individual recipients from `report()`), this is a coarse,
 * campaign-level rollup straight from NetGSM's own aggregate — the source of
 * truth for "how many of this jobid's messages landed in each bucket",
 * independent of whether every recipient row was ever individually resolved.
 *
 * Every jobid burns its own `AccountRateBudgeter` slot
 * (`tryTake(usercode, 'stats:'+jobid, 1, 600_000)`) — NetGSM's real per-jobid
 * cap, NOT a shared per-account budget like `report`'s 60/min. A denial skips
 * ONLY that jobid this tick; its last-known rollup (if any) is kept as-is.
 *
 * `campaign.stats.sms` is rebuilt from scratch EVERY tick as:
 *   { jobs: { [jobid]: { [status]: count } }, [status]: totalAcrossJobids }
 * storing each jobid's LATEST known rows under `jobs[jobid]` and re-deriving
 * the totals by summing across every known jobid — never by adding this
 * tick's delta onto a running total. That is what makes a partial-budget tick
 * (some jobids denied, using their stale `jobs[jobid]` entry) safe: it can
 * never double-count a jobid's rows twice, because each jobid contributes
 * exactly one snapshot to the sum regardless of which tick last refreshed it.
 * The write always merges under the `sms` key of the wider `stats` blob
 * (spread-first, same discipline as `campaign-sender.service.ts`'s
 * `recomputeStats` and `netgsm-dlr-poll.service.ts`'s `rollupCampaignStats`)
 * so it never clobbers `sent`/`failed`/`opened`/`clicked`/`delivered`/… owned
 * by other writers.
 */
@Injectable()
export class CampaignSmsStatsService {
  private readonly logger = new Logger(CampaignSmsStatsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly smsV2: SmsV2Client,
    private readonly budgeter: AccountRateBudgeter,
  ) {}

  @Cron('*/15 * * * *', { name: 'campaign-sms-stats' })
  async reconcileDueStats(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'campaign-sms-stats',
      async () => {
        await this.reconcile();
      },
      this.logger,
    );
  }

  async reconcile(): Promise<{ scanned: number; updated: number }> {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

    const campaigns = await this.prisma.campaign.findMany({
      where: {
        channel: 'SMS',
        status: { in: ['SENDING', 'SENT'] },
        OR: [{ status: 'SENDING' }, { completedAt: { gte: since } }],
      },
      select: { id: true, workspaceId: true, status: true, completedAt: true, netgsmJobIds: true, stats: true },
    });
    const targets = campaigns.filter((c) => this.jobidsOf(c).length > 0);
    if (targets.length === 0) return { scanned: 0, updated: 0 };

    // Resolve+decrypt each workspace's active SMS channel at most once per tick,
    // even when several campaigns in this batch share a workspace.
    const credsByWorkspace = new Map<string, NetgsmCreds | null>();

    let updated = 0;
    for (const campaign of targets) {
      const creds = await this.resolveCreds(campaign.workspaceId, credsByWorkspace);
      if (!creds) continue;

      const wrote = await this.reconcileCampaign(campaign, creds);
      if (wrote) updated++;
    }
    return { scanned: targets.length, updated };
  }

  private jobidsOf(campaign: CampaignRow): string[] {
    const raw = Array.isArray(campaign.netgsmJobIds) ? (campaign.netgsmJobIds as unknown[]) : [];
    return raw.filter((j): j is string => typeof j === 'string' && j.length > 0);
  }

  /** Returns true iff at least one jobid was successfully queried this tick
   *  (i.e. a DB write actually happened). Budget denials on EVERY jobid, or an
   *  unexpected transport/error result on every attempted query, write nothing. */
  private async reconcileCampaign(campaign: CampaignRow, creds: NetgsmCreds): Promise<boolean> {
    const jobids = this.jobidsOf(campaign);
    const priorStats = campaign.stats && typeof campaign.stats === 'object' ? (campaign.stats as Record<string, unknown>) : {};
    const priorSms = priorStats.sms && typeof priorStats.sms === 'object' ? (priorStats.sms as Record<string, unknown>) : {};
    const priorJobs = priorSms.jobs && typeof priorSms.jobs === 'object' ? (priorSms.jobs as Record<string, JobStatusCounts>) : {};

    const jobs: Record<string, JobStatusCounts> = { ...priorJobs };
    let queried = false;

    for (const jobid of jobids) {
      if (!this.budgeter.tryTake(creds.usercode, `stats:${jobid}`, STATS_LIMIT, STATS_WINDOW_MS)) {
        continue; // denied this tick — keep whatever was last stored for this jobid (may be none yet)
      }
      let result;
      try {
        result = await this.smsV2.stats(creds, jobid);
      } catch (e: any) {
        this.logger.warn(`netgsm stats fetch failed for jobid=${jobid}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok) continue;

      queried = true;
      const perStatus: JobStatusCounts = {};
      for (const row of result.rows) {
        perStatus[row.status] = (perStatus[row.status] ?? 0) + row.count;
      }
      jobs[jobid] = perStatus;
    }

    if (!queried) return false; // nothing new resolved this tick — no write

    // Re-derive totals by summing every known jobid's LATEST snapshot — never
    // an incremental add — so a partial-budget tick (mixing freshly-queried
    // jobids with stale carried-over ones) can't double-count.
    const totals: JobStatusCounts = {};
    for (const perStatus of Object.values(jobs)) {
      for (const [status, count] of Object.entries(perStatus)) {
        totals[status] = (totals[status] ?? 0) + count;
      }
    }

    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        stats: {
          ...priorStats,
          sms: { ...totals, jobs },
        } as Prisma.InputJsonValue,
      },
    });
    return true;
  }

  private async resolveCreds(
    workspaceId: string,
    cache: Map<string, NetgsmCreds | null>,
  ): Promise<NetgsmCreds | null> {
    if (cache.has(workspaceId)) return cache.get(workspaceId) ?? null;
    const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    let creds: NetgsmCreds | null = null;
    if (ch) {
      const { secrets } = this.registry.resolveConfig(ch);
      if (secrets.usercode && secrets.password) {
        creds = { usercode: secrets.usercode, password: secrets.password };
      }
    }
    cache.set(workspaceId, creds);
    return creds;
  }
}
