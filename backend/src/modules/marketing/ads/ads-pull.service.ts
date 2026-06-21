import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { AdAccountService } from './ad-account.service';
import { isMetaAdsConfigured, isTiktokAdsConfigured } from './ads.types';

/**
 * Hourly ad-insights sweep for connected ad accounts (GoHighLevel parity).
 * Mirrors SubscriptionsSchedulerService: a single-replica advisory lock guards
 * the tick so two replicas never both sweep. The DUE-ROW query is the one
 * legitimately cross-workspace read (a system job) — whitelisted in the
 * workspace-scoping fitness test; every write it triggers (in pullAccount) is
 * workspace-scoped or id-keyed, and the (adAccountId, date, campaignId) unique
 * index makes a re-pull idempotent (upsert, never duplicate). pullAccount never
 * throws (every failure path — bad token, provider error, DB write error —
 * routes through markError, which stamps lastPulledAt), so a failing account is
 * pushed to the BACK of the lastPulledAt-ordered queue and retried next interval
 * rather than wedging at the nulls-first front and starving healthy accounts.
 *
 * Inert when no provider app is configured (env-gated): the sweep early-returns,
 * connect() rejects unconfigured providers, and pullAccount short-circuits — so
 * the whole feature is dormant until an operator enables a provider.
 */
@Injectable()
export class AdsPullService {
  private readonly logger = new Logger(AdsPullService.name);
  /** Bound work per tick; remaining due rows roll to the next hourly tick. */
  private static readonly BATCH = 200;
  /** Re-pull an account at most this often (insights change slowly + rate limits). */
  private static readonly PULL_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** Trailing window re-pulled each sweep (catches late-attributed conversions). */
  private static readonly WINDOW_DAYS = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adAccounts: AdAccountService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'ads-pull-insights' })
  async pullDueAccounts(): Promise<void> {
    if (!isMetaAdsConfigured() && !isTiktokAdsConfigured()) return; // no provider app → nothing to sweep
    await withAdvisoryLock(
      this.prisma,
      'ads:pull-insights',
      async () => {
        const now = Date.now();
        const dueBefore = new Date(now - AdsPullService.PULL_INTERVAL_MS);
        // System-global read: due ACTIVE accounts across ALL workspaces. Never
        // pulled (lastPulledAt null) or stale (older than the pull interval).
        const due = await this.prisma.adAccount.findMany({
          where: {
            status: 'ACTIVE',
            OR: [{ lastPulledAt: null }, { lastPulledAt: { lt: dueBefore } }],
          },
          orderBy: { lastPulledAt: { sort: 'asc', nulls: 'first' } },
          take: AdsPullService.BATCH,
          select: {
            id: true,
            workspaceId: true,
            provider: true,
            externalAdId: true,
            accessToken: true,
          },
        });
        if (due.length === 0) return;

        const to = new Date(now);
        const from = new Date(now - AdsPullService.WINDOW_DAYS * 86_400_000);
        const fromIso = from.toISOString().slice(0, 10);
        const toIso = to.toISOString().slice(0, 10);

        let pulled = 0;
        for (const account of due) {
          // pullAccount never throws — it records lastError + lastPulledAt on the
          // row itself, so one bad account never aborts the loop or blocks others.
          try {
            const written = await this.adAccounts.pullAccount(account, fromIso, toIso);
            if (written > 0) pulled++;
          } catch (e) {
            this.logger.error(
              `ad account ${account.id} sweep failed: ${(e as Error)?.message ?? e}`,
            );
          }
        }
        if (pulled > 0) this.logger.log(`ads sweep: refreshed ${pulled}/${due.length} account(s)`);
      },
      this.logger,
    );
  }
}
