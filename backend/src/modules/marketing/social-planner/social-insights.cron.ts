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
 * accounts are due", selecting nothing but the account and workspace ids, and
 * every read and write that follows happens inside
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
 * WORK IS BOUNDED BY ACCOUNTS, AND THE BOUND IS AN ALLOWLIST rather than a
 * hope. A tick reads at most BATCH due account ROWS and hands each workspace
 * exactly the ids that came back for it, so the tick touches at most BATCH
 * accounts — full stop. This used to say the same thing while doing something
 * else: the due query selected only workspaceId, the loop de-duplicated it to a
 * workspace list, and pullWorkspace then INDEPENDENTLY re-queried its own due
 * accounts up to its own ACCOUNT_LIMIT. Two hundred due rows landing in two
 * hundred different workspaces therefore authorised twenty thousand account
 * reads, not two hundred, and the comment asserting otherwise is exactly how a
 * blast radius stays unnoticed. Ads-pull iterates the due rows themselves;
 * this now does the same, expressed as an id allowlist because the puller needs
 * the whole account row and the sealed token on it.
 *
 * The post reads are bounded separately and per workspace (TARGET_LIMIT), so
 * the honest worst case for a tick is BATCH account reads plus up to
 * TARGET_LIMIT post reads for each workspace represented in the batch. That
 * product is still large enough to outlive an hour if the providers are slow,
 * which is what BUDGET_MS below is for.
 *
 * The remainder rolls to the next hourly tick, and because the due query is
 * ordered oldest-first (nulls first) with every attempt stamping
 * insightsPulledAt, no account can be starved by a neighbour that keeps failing.
 */
@Injectable()
export class SocialInsightsCron {
  private readonly logger = new Logger(SocialInsightsCron.name);
  /** Due accounts considered per tick; the rest roll to the next hour. */
  private static readonly BATCH = 200;
  /**
   * WALL-CLOCK CEILING ON THE SWEEP BODY, and the reason it is not simply left
   * to the lock.
   *
   * withAdvisoryLock holds pg_try_advisory_xact_lock inside a Prisma
   * interactive transaction with a 55-minute body timeout. If the body outruns
   * that, Prisma rolls the transaction back — which RELEASES the lock — while
   * the body itself carries on running out on the normal pool. The next hourly
   * tick then finds the lock free and starts a second sweep alongside the first,
   * and the two of them race each other through the same provider endpoints.
   * The lock cannot prevent that; only finishing in time can.
   *
   * Twenty minutes is comfortably under the hourly cadence, so a tick is always
   * done before its successor starts, and comfortably under the transaction
   * timeout, so the rollback path stays theoretical. Whatever is left keeps its
   * place: unswept accounts were never stamped, so they are still due, still at
   * the head of the oldest-first queue, and are the first thing the next tick
   * picks up.
   */
  private static readonly BUDGET_MS = 20 * 60 * 1000;
  /**
   * Upper bound on the per-workspace lock transaction inside the sweep. Shorter
   * than BUDGET_MS on purpose: one slow workspace must not be able to consume
   * the entire tick's budget by itself.
   */
  private static readonly WORKSPACE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

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
        const deadline = Date.now() + SocialInsightsCron.BUDGET_MS;
        const dueBefore = new Date(Date.now() - SocialInsightsService.PULL_INTERVAL_MS);
        // System-global read: enabled social accounts that are due, across ALL
        // workspaces. It selects the two ids and nothing else — no row data is
        // touched here, only the identity of the accounts to hand to the
        // workspace-scoped puller below. The ACCOUNT id is the half that makes
        // the batch size real; see the class doc.
        const due = await this.prisma.socialAccount.findMany({
          where: {
            enabled: true,
            OR: [{ insightsPulledAt: null }, { insightsPulledAt: { lt: dueBefore } }],
          },
          orderBy: { insightsPulledAt: { sort: 'asc', nulls: 'first' } },
          take: SocialInsightsCron.BATCH,
          select: { id: true, workspaceId: true },
        });
        if (due.length === 0) return;

        // Group the due accounts by workspace, preserving due-order in BOTH
        // directions: the workspace holding the oldest account is swept first,
        // and within a workspace its oldest account is read first. That is what
        // keeps the queue fair. A Map preserves insertion order by spec, so the
        // first appearance of a workspace fixes its position.
        const byWorkspace = new Map<string, string[]>();
        for (const row of due) {
          const list = byWorkspace.get(row.workspaceId);
          if (list) list.push(row.id);
          else byWorkspace.set(row.workspaceId, [row.id]);
        }

        let accounts = 0;
        let posts = 0;
        let errors = 0;
        let swept = 0;
        let busy = 0;
        // Due accounts the sweep actually READ, summed off what each workspace
        // reports back. Three different things can leave a row in `due`
        // untouched — its workspace was busy, the tick ran out of budget before
        // reaching it, or its workspace supplied more than the puller's
        // per-workspace ACCOUNT_LIMIT and the surplus was shed — and only the
        // first two were visible from here. Counting what came back covers all
        // three without this file having to know about any of them.
        let processed = 0;
        // Workspaces the loop actually reached, however they turned out —
        // swept, busy or thrown. The remainder reported below is derived from
        // this rather than from `swept`, so a workspace that failed is not also
        // counted as one that never got its turn.
        let attempted = 0;
        let ranOut = false;
        for (const [workspaceId, accountIds] of byWorkspace) {
          // The budget is checked BEFORE each workspace rather than mid-flight:
          // a workspace is the smallest unit that can be abandoned without
          // leaving half its accounts stamped and half not.
          if (Date.now() >= deadline) {
            ranOut = true;
            break;
          }
          attempted++;
          // pullWorkspaceExclusive never throws — it records per-account
          // failures on the rows themselves and counts transaction failures.
          // The try is here anyway so that a defect in the sweep can never take
          // out the workspaces queued behind it.
          try {
            const r = await this.insights.pullWorkspaceExclusive(workspaceId, {
              accountIds,
              lockTimeoutMs: SocialInsightsCron.WORKSPACE_LOCK_TIMEOUT_MS,
            });
            // Before the skip check, so the one number that describes the tick
            // is accumulated on every path a workspace can take (it is zero for
            // a skipped one, which is the point).
            processed += r.processed;
            // Skipped means a manual refresh is pulling this workspace right
            // now. Nothing to do and nothing lost: its accounts stay unstamped,
            // so they are still due — and the manual pull is stamping them
            // anyway.
            if (r.skipped) {
              busy++;
              continue;
            }
            swept++;
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

        // WHAT THE TICK DID, not what it set out to do. This used to print
        // `due.length` — the size of the batch the query CHOSE — beside the
        // counts of work actually completed, so a tick that read a hundred
        // accounts because one workspace's surplus was shed still announced two
        // hundred "due account(s)". A log that overstates its own reach is worse
        // than no log: it is the reason nobody goes looking. The remainder is
        // named for the same reason, and it is genuinely a remainder rather than
        // a loss — an account the sweep did not reach was never stamped, so it
        // is still due and still at the head of the oldest-first queue.
        const deferred = due.length - processed;
        this.logger.log(
          `social insights sweep: ${accounts} account snapshot(s), ${posts} post metric(s), ` +
            `${errors} error(s) across ${swept} workspace(s) ` +
            `(${processed} of ${due.length} due account(s) processed` +
            `${busy > 0 ? `, ${busy} workspace(s) busy` : ''}` +
            `${deferred > 0 ? `, ${deferred} account(s) roll to the next tick` : ''})` +
            // Said out loud rather than inferred from a short count: a sweep
            // that keeps running out of budget is a sweep that needs a smaller
            // BATCH or a faster provider, and that is only visible if it says so.
            (ranOut
              ? ` — stopped at the ${SocialInsightsCron.BUDGET_MS / 60_000}min budget ` +
                `with ${byWorkspace.size - attempted} workspace(s) unreached`
              : ''),
        );
      },
      this.logger,
    );
  }
}
