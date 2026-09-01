import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { isNetworkConfigured } from './network-adapters';
import { networkSupportsInsights } from './network-insights';
import { SocialInsightsService } from './social-insights.service';

/** The networks that have a readable insights API at all. */
const INSIGHTS_NETWORKS = ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'LINKEDIN', 'TIKTOK', 'TWITTER'];

/** True when at least one insights-capable network has its platform app credentials. */
export function isAnyInsightsNetworkConfigured(): boolean {
  return INSIGHTS_NETWORKS.some((n) => networkSupportsInsights(n) && isNetworkConfigured(n));
}

/**
 * Hourly organic-insights sweep — the organic mirror of AdsPullService, and
 * written to the same shape on purpose so the two sweeps can be reasoned about
 * together.
 *
 * A single-replica advisory lock guards the tick, so under a multi-replica
 * deploy the losers skip silently instead of every replica hammering the same
 * provider endpoints with the same requests. The DUE-ROW query is the one
 * legitimately cross-workspace read (a system job, exactly like the ads,
 * review, token-refresh and calendar-renewal sweeps): it asks only "which
 * workspaces have an account that is due", selecting nothing but the workspace
 * id, and every read and write that follows happens inside
 * SocialInsightsService.pullWorkspace, which takes a workspaceId as its first
 * argument and inlines it on every query.
 *
 * INERT BY DEFAULT, twice over. It returns immediately when no insights-capable
 * network has platform credentials, and again when the secret box is
 * unconfigured — without MARKETING_SECRET_KEY every sealed token would fail to
 * open and the sweep would do nothing but stamp errors on every account in the
 * database. Same inert-feature convention the publish path and the token
 * refresher use.
 *
 * WORK IS BOUNDED, and bounded by ACCOUNTS rather than by workspaces. A tick
 * considers at most BATCH due accounts; the workspaces those accounts belong to
 * are the ones swept, and pullWorkspace re-applies the same every-6h staleness
 * gate internally, so a workspace with four due accounts costs four reads and
 * not forty. The remainder rolls to the next hourly tick, and because the due
 * query is ordered oldest-first (nulls first) with every attempt stamping
 * insightsPulledAt, no account can be starved by a neighbour that keeps failing.
 */
@Injectable()
export class SocialInsightsCron {
  private readonly logger = new Logger(SocialInsightsCron.name);
  /** Due accounts considered per tick; the rest roll to the next hour. */
  private static readonly BATCH = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: SocialInsightsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'social-insights-pull' })
  async pullDueWorkspaces(): Promise<void> {
    if (!isAnyInsightsNetworkConfigured()) return; // no provider app → nothing to sweep
    if (!isSecretBoxConfigured()) return; // no key → every token would fail to open

    await withAdvisoryLock(
      this.prisma,
      'social:pull-insights',
      async () => {
        const dueBefore = new Date(Date.now() - SocialInsightsService.PULL_INTERVAL_MS);
        // System-global read: enabled social accounts that are due, across ALL
        // workspaces. It selects the workspaceId and nothing else — the row
        // data is never touched here, only the set of workspaces to hand to the
        // workspace-scoped puller below.
        const due = await this.prisma.socialAccount.findMany({
          where: {
            enabled: true,
            OR: [{ insightsPulledAt: null }, { insightsPulledAt: { lt: dueBefore } }],
          },
          orderBy: { insightsPulledAt: { sort: 'asc', nulls: 'first' } },
          take: SocialInsightsCron.BATCH,
          select: { workspaceId: true },
        });
        if (due.length === 0) return;

        // Preserve due-order while de-duplicating: the workspace holding the
        // oldest account is swept first, which is what keeps the queue fair.
        const workspaceIds: string[] = [];
        const seen = new Set<string>();
        for (const row of due) {
          if (seen.has(row.workspaceId)) continue;
          seen.add(row.workspaceId);
          workspaceIds.push(row.workspaceId);
        }

        let accounts = 0;
        let posts = 0;
        let errors = 0;
        for (const workspaceId of workspaceIds) {
          // pullWorkspace never throws — it records per-account failures on the
          // rows themselves. The try is here anyway so that a defect in the
          // sweep can never take out the workspaces queued behind it.
          try {
            const r = await this.insights.pullWorkspace(workspaceId);
            accounts += r.accounts;
            posts += r.posts;
            errors += r.errors;
          } catch (e) {
            errors++;
            this.logger.error(
              `social insights sweep failed for workspace ${workspaceId}: ${(e as Error)?.message ?? e}`,
            );
          }
        }

        this.logger.log(
          `social insights sweep: ${accounts} account snapshot(s), ${posts} post metric(s), ` +
            `${errors} error(s) across ${workspaceIds.length} workspace(s) (${due.length} due account(s))`,
        );
      },
      this.logger,
    );
  }
}
