import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgentRunService } from '../agents/agent-run.service';
import { BrandContextService } from '../brand-brain/brand-context.service';
import { ResearchJob, ResearchJobService } from './research-job.service';
import { ResearchFinalizeService, ResearchFinalizeResult } from './research-finalize.service';
import { RESEARCH_RUN_KIND } from './research-kinds';
import { buildMcpResearchInstruction, researchTargetVolume } from './research-contract';

/**
 * The `ScheduledJob.status` a job sits in while an MCP client holds it.
 *
 * Deliberately a status the two GENERIC sweepers do not know about:
 * `ScheduledJobRunnerService.claimBatch` only takes `PENDING`, and its
 * `reapStuck` only revives `RUNNING`. So a leased job is invisible to both,
 * and this service owns its whole lifetime — including its expiry — without
 * having to teach the generic runner about a lane it does not drain.
 *
 * The partial-unique index behind `(kind, dedupKey)` is `WHERE status =
 * 'PENDING'`, so a CLAIMED row also does not block tonight's cron from
 * enqueueing the same profile again.
 */
export const RESEARCH_JOB_CLAIMED = 'CLAIMED';

/**
 * How long a client holds a leased job before it returns to the queue.
 *
 * Bounded above by the AgentRun reaper, which fails a RUNNING run after an
 * hour — a lease outliving its own audit row would leave the job closable and
 * the run already marked stranded. Bounded below by how long a real research
 * session takes: expiring under a working client hands the same night to a
 * second one, and then the owner pays for it twice.
 */
export const RESEARCH_LEASE_MS = Number(process.env.RESEARCH_MCP_LEASE_MS ?? 30 * 60 * 1000);

/**
 * How many rows to try before giving up on a poll. Bounded because each miss
 * is either a lost race (another client got there first — there is no point
 * grinding through the whole queue) or a job whose profile is no longer
 * runnable (already closed on the way past).
 */
const MAX_CLAIM_ATTEMPTS = 5;

/** The MCP tool whose approvals the queue report has to surface. */
export const SUBMIT_RESEARCH_CANDIDATES_TOOL = 'jeeta.submit_research_candidates';

export interface ClaimedResearchJob {
  jobId: string;
  profileId: string;
  profileName: string;
  agentRunId: string;
  leaseExpiresAt: string;
  /** The FULL server-authored instruction — see buildMcpResearchInstruction. */
  instruction: string;
  targetVolume: number;
  language: string;
  geo: unknown;
  businessTypes: unknown;
  exclusions: string | null;
}

export interface ClaimResult {
  job: ClaimedResearchJob | null;
  /** Why there is no job. Never left implicit — see the class doc. */
  reason?: 'not-in-mcp-mode' | 'queue-empty';
}

export interface ResearchQueueStatus {
  mode: 'SERVER' | 'MCP';
  /** Jobs waiting for a drainer right now. */
  pending: number;
  /** Jobs a client currently holds a lease on. */
  claimed: number;
  oldestPendingAt: string | null;
  oldestPendingAgeHours: number | null;
  /**
   * When the oldest LIVE lease was taken, and how long ago in minutes.
   *
   * Reported separately from the pending age because they are different
   * problems with different owners: a job WAITING means nobody drains this
   * queue, a job HELD means a drainer took it and has not come back. Minutes,
   * not hours, because `RESEARCH_LEASE_MS` is thirty of them by default — an
   * age in hours would read `0` for every lease that has not yet expired.
   *
   * Null when nothing is held. Also null on the (unnatural) CLAIMED row with
   * no `lockedAt`: `releaseExpired` cannot see such a row either, so the honest
   * answer is "held, and we cannot say since when" rather than a made-up zero.
   */
  oldestClaimedAt: string | null;
  oldestClaimedAgeMinutes: number | null;
  /** `submit_research_candidates` calls sitting in the human approval queue. */
  pendingApprovals: number;
}

/** The context the Jeeta-keyed data tools need, resolved from the leased job. */
export interface ResearchToolLeaseContext {
  workspaceId: string;
  runId: string;
  geo: { country?: string | null; regions?: string[] | null; cities?: string[] | null };
}

/**
 * The MCP research lane: lease a queued job, work it on the owner's own Claude,
 * hand back candidates, close it.
 *
 * ## Why a lease and not just "read the queue"
 *
 * A research run is the single most expensive thing in the product — a long
 * model session on the owner's subscription plus live Apify/Firecrawl calls on
 * Jeeta's vendor keys. Two clients working the same job means the reasoning is
 * paid for twice and the crawl is paid for twice, for one night's leads. So a
 * job is LEASED, and the flip from PENDING is a single conditional UPDATE:
 * Postgres re-evaluates the predicate against the committed row version, so the
 * second caller matches zero rows and comes back empty. Remove `status:
 * 'PENDING'` from that where clause and both callers win.
 *
 * A lease also has to end on its own. A client that crashes mid-run must not
 * hold the night hostage, so an expired lease returns to PENDING — swept lazily
 * on the way into the next claim rather than by another cron nobody remembers.
 *
 * ## Why every refusal is loud
 *
 * `submit` and `complete` throw rather than returning a zero. A model reading
 * "0 staged" concludes nothing qualified and moves on; the workspace then sees
 * an empty review queue and concludes research found nothing. That confusion —
 * a failure wearing the costume of an empty result — is the exact bug this
 * repo keeps paying for (`.catch(() => 0)`, v2.271.0), and the whole MCP lane
 * is one long opportunity to reintroduce it.
 */
@Injectable()
export class ResearchLeaseService {
  private readonly logger = new Logger(ResearchLeaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ResearchJobService,
    private readonly finalize: ResearchFinalizeService,
    private readonly runs: AgentRunService,
    private readonly brandContext: BrandContextService,
  ) {}

  /**
   * Which side drains this workspace. Fail-safe in the SERVER direction:
   * anything that is not exactly `'MCP'` — a NULL from a row this code did not
   * create, a typo, a value from a future migration — means the platform's own
   * worker is still draining, and leasing on top of that would run the night
   * twice.
   */
  async modeFor(workspaceId: string): Promise<'SERVER' | 'MCP'> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { researchExecution: true },
    });
    return ws?.researchExecution === 'MCP' ? 'MCP' : 'SERVER';
  }

  /** Lease the next queued research job for this workspace, with its brief. */
  async claim(workspaceId: string): Promise<ClaimResult> {
    if ((await this.modeFor(workspaceId)) !== 'MCP') {
      return { job: null, reason: 'not-in-mcp-mode' };
    }

    await this.releaseExpired(workspaceId);

    const tried: string[] = [];
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const next = await this.prisma.scheduledJob.findFirst({
        where: {
          workspaceId,
          kind: RESEARCH_RUN_KIND,
          status: 'PENDING',
          runAt: { lte: new Date() },
          // A COPY: `tried` grows across attempts, and handing the live array
          // to Prisma would let a later push mutate a query already issued.
          ...(tried.length ? { id: { notIn: [...tried] } } : {}),
        },
        orderBy: { runAt: 'asc' },
        select: { id: true },
      });
      if (!next) return { job: null, reason: 'queue-empty' };
      tried.push(next.id);

      // THE ATOMIC CLAIM. `status: 'PENDING'` is what makes this safe: a
      // concurrent claimer's UPDATE blocks on the row lock, re-reads the
      // committed version, sees CLAIMED, and matches zero rows. Without it,
      // both callers "win" and the workspace pays for the same night twice.
      const claimedAt = new Date();
      const won = await this.prisma.scheduledJob.updateMany({
        where: { id: next.id, workspaceId, status: 'PENDING' },
        data: { status: RESEARCH_JOB_CLAIMED, lockedAt: claimedAt },
      });
      if (won.count === 0) continue; // somebody else got it — try the next row

      // Read back what we now own.
      const row = await this.prisma.scheduledJob.findFirst({
        where: { id: next.id, workspaceId },
        select: { id: true, payload: true },
      });
      const profileId = (row?.payload as { profileId?: string } | null)?.profileId;
      if (!profileId) {
        await this.close(workspaceId, next.id, 'DONE', 'job payload carried no profileId');
        continue;
      }

      // `buildJob` is the ONLY place the profile's status and the workspace's
      // daily lead allowance are read. A null means this job can produce
      // nothing tonight — close it rather than leave it PENDING, or it is
      // handed out again on every single poll, forever.
      const built = await this.jobs.buildJob(workspaceId, profileId);
      if (!built) {
        await this.close(
          workspaceId,
          next.id,
          'DONE',
          'profile paused or deleted, or the daily lead allowance is used up',
        );
        continue;
      }

      const agentRunId = await this.runs.start(workspaceId, {
        agent: 'research.mcp',
        goal: `Prospect for "${built.profile.name}" (drained by the workspace's own Claude)`,
        input: { jobId: next.id, profileId, geo: built.profile.geo },
      });
      await this.prisma.scheduledJob.updateMany({
        where: { id: next.id, workspaceId, status: RESEARCH_JOB_CLAIMED },
        data: { payload: { profileId, mcpAgentRunId: agentRunId } },
      });

      const brand = await this.brandContext.summaryFor(workspaceId).catch(() => null);
      const expiresAt = new Date(claimedAt.getTime() + RESEARCH_LEASE_MS);
      return {
        job: {
          jobId: next.id,
          profileId,
          profileName: built.profile.name,
          agentRunId,
          leaseExpiresAt: expiresAt.toISOString(),
          instruction: buildMcpResearchInstruction(built, brand, { jobId: next.id, expiresAt }),
          targetVolume: researchTargetVolume(built),
          language: built.profile.language,
          geo: built.profile.geo,
          businessTypes: built.profile.businessTypes,
          exclusions: built.profile.exclusions,
        },
      };
    }
    return { job: null, reason: 'queue-empty' };
  }

  /**
   * Hand back the candidates for a leased job.
   *
   * Everything after this point is the SHARED finalize path — the same
   * validation, clip, staging, metering and profile stamp the in-process
   * worker runs. Nothing here writes a candidate row of its own.
   */
  async submit(workspaceId: string, jobId: string, candidates: unknown[]): Promise<ResearchFinalizeResult> {
    // CLAIMED **or DONE**, unlike every other write here.
    //
    // `submit_research_candidates` is approval-gated, so on an APPROVAL-mode
    // workspace the client gets PENDING_APPROVAL, sensibly closes the job, and
    // the approval executor replays this call hours later once a human clicks.
    // Demanding CLAIMED would fail every approved submit — the candidates a
    // human just said yes to would be discarded and the review queue would look
    // empty, which is precisely the failure this lane is built to avoid.
    //
    // The tenant boundary is unchanged: `workspaceId` and `kind` still hold, and
    // staging is idempotent on (workspaceId, profileId, externalRef), so a
    // replay collapses rather than duplicating.
    const { job, runId, status } = await this.requireLeased(workspaceId, jobId, [
      RESEARCH_JOB_CLAIMED,
      'DONE',
    ]);

    // …but a DONE job must ALSO carry the marker `claim()` stamps on it.
    //
    // Without this, the DONE branch accepts every historical `research.run` in
    // the workspace, and those ids are not secret: `jeeta.list_background_jobs`
    // is a READ tool that returns `scheduled_jobs.id` filtered by kind and
    // status. A client could enumerate months of nights the SERVER lane drained
    // — on a workspace that never enabled MCP at all — and submit into any of
    // them, metering RESEARCH_LEAD spend outside any run and stamping the
    // profile with a `lastRunAt`/`lastRunStats` that describes work nobody did.
    //
    // `mcpAgentRunId` is written in exactly one place, the update that follows
    // the atomic claim; the server lane enqueues `{ profileId }` and never
    // touches the payload. So its presence is precisely "this job was once part
    // of the MCP lane", which is the only thing the approval-replay case needs.
    if (status !== RESEARCH_JOB_CLAIMED && !runId) {
      throw new NotFoundException(
        `research job ${jobId} is closed and was never leased through the MCP lane, so there is ` +
          'nothing to submit against it. Only a job you claimed with jeeta.claim_research_job ' +
          'accepts candidates after it closes — that path exists for replaying an approved submit, ' +
          'not for writing into a night the platform already researched itself.',
      );
    }

    const result = await this.finalize.finalize(job, runId, candidates);
    this.logger.log(
      `research(mcp) job ${jobId}: ${result.researched} qualified, ${result.staged} staged, ` +
        `${result.duplicates} dupes (ws ${workspaceId})`,
    );
    return result;
  }

  /** Close a leased job, successfully or with the reason it failed. */
  async complete(
    workspaceId: string,
    jobId: string,
    opts: { status: 'DONE' | 'FAILED'; reason?: string },
  ): Promise<{ closed: boolean; jobId: string; status: string }> {
    const { runId } = await this.requireLeased(workspaceId, jobId, [RESEARCH_JOB_CLAIMED]);
    const reason = (opts.reason ?? '').slice(0, 500) || undefined;

    const res = await this.close(workspaceId, jobId, opts.status, reason);
    if (runId) {
      await this.runs
        .finish(runId, {
          status: opts.status,
          ...(opts.status === 'FAILED' ? { error: reason ?? 'closed as failed by the MCP client' } : {}),
        })
        .catch((e) => this.logger.warn(`agent run ${runId} finish failed: ${(e as Error)?.message ?? e}`));
    }
    return { closed: res, jobId, status: opts.status };
  }

  /**
   * The context the Jeeta-keyed data tools run under.
   *
   * Resolved from the LEASED JOB, never from the caller's arguments. The run id
   * is what a `ToolCallLog` and an Apify/Firecrawl meter are attributed to, and
   * the geo is the profile's hard filter — if either came in as a tool argument,
   * an agent could bill its crawling onto another run or search outside the geo
   * the brief promised.
   */
  async toolContext(workspaceId: string, jobId: string): Promise<ResearchToolLeaseContext> {
    const { job, runId } = await this.requireLeased(workspaceId, jobId, [RESEARCH_JOB_CLAIMED]);
    if (!runId) {
      throw new BadRequestException(
        `research job ${jobId} has no agent run — claim it again with jeeta.claim_research_job`,
      );
    }
    return {
      workspaceId,
      runId,
      geo: (job.profile.geo as ResearchToolLeaseContext['geo']) ?? {},
    };
  }

  /**
   * What the panel has to say out loud.
   *
   * A queue nobody drains looks EXACTLY like a queue that found nothing, and
   * the difference is the whole risk of this design: the owner flips to MCP,
   * forgets to schedule a drainer, and research silently stops while the panel
   * shows an empty review queue. So the counts and the age of the oldest
   * waiting job are read and reported by name.
   */
  async queueStatus(workspaceId: string): Promise<ResearchQueueStatus> {
    // THE SWEEP RUNS HERE, not only on the way into a claim.
    //
    // `claim()` also sweeps, but only after its `mode !== 'MCP'` early return —
    // so the two ways a lease is actually abandoned were both unreachable:
    // an owner flipping back to SERVER (no client claims a SERVER queue, and
    // the refusal text tells it to stop polling), and a client that crashed and
    // never polls again. `CLAIMED` is a status the generic sweepers do not
    // know — `claimBatch` takes PENDING, `reapStuck` revives RUNNING — so
    // nothing else on the platform could ever move that row.
    //
    // This is the one call on this service that runs in BOTH modes with no
    // client involved: the home timeline reads it on every panel load and every
    // sixty-second refetch. Sweeping here bounds the damage of an abandoned
    // lease at one lease length plus one panel read, in either mode.
    //
    // Awaited BEFORE the counts rather than joined into the Promise.all below,
    // so the numbers reported are post-release. Counting concurrently would
    // report a row as `claimed` that is, by the time the panel draws it, back
    // in the queue.
    await this.releaseExpired(workspaceId);

    const [mode, pending, claimed, oldest, oldestLease, pendingApprovals] = await Promise.all([
      this.modeFor(workspaceId),
      this.prisma.scheduledJob.count({
        where: { workspaceId, kind: RESEARCH_RUN_KIND, status: 'PENDING' },
      }),
      this.prisma.scheduledJob.count({
        where: { workspaceId, kind: RESEARCH_RUN_KIND, status: RESEARCH_JOB_CLAIMED },
      }),
      this.prisma.scheduledJob.findFirst({
        where: { workspaceId, kind: RESEARCH_RUN_KIND, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      // The oldest LIVE lease. Ordered by `lockedAt` — when the lease was
      // taken — not by `createdAt`, which is when the cron enqueued the job and
      // says nothing about how long a drainer has been sitting on it.
      this.prisma.scheduledJob.findFirst({
        where: { workspaceId, kind: RESEARCH_RUN_KIND, status: RESEARCH_JOB_CLAIMED },
        orderBy: { lockedAt: 'asc' },
        select: { lockedAt: true },
      }),
      // The open owner decision the spec records: on an APPROVAL-mode
      // workspace every night's submit sits here until a human clicks, and no
      // candidate is saved until they do. Counted so that state is visible
      // rather than presenting as an empty review queue.
      this.prisma.approvalRequest.count({
        where: {
          workspaceId,
          status: 'PENDING',
          payload: { path: ['tool'], equals: SUBMIT_RESEARCH_CANDIDATES_TOOL },
        },
      }),
    ]);

    const oldestAt = oldest?.createdAt ?? null;
    const leaseAt = oldestLease?.lockedAt ?? null;
    return {
      mode,
      pending,
      claimed,
      oldestPendingAt: oldestAt ? oldestAt.toISOString() : null,
      oldestPendingAgeHours: oldestAt
        ? Math.floor((Date.now() - oldestAt.getTime()) / (60 * 60 * 1000))
        : null,
      oldestClaimedAt: leaseAt ? leaseAt.toISOString() : null,
      oldestClaimedAgeMinutes: leaseAt
        ? Math.floor((Date.now() - leaseAt.getTime()) / 60_000)
        : null,
      pendingApprovals,
    };
  }

  /**
   * An expired lease goes back to the queue.
   *
   * Lazy rather than a cron: a cron for this would be a second schedule to keep
   * alive for a lane whose whole point is that the platform runs less.
   *
   * TWO callers, deliberately, and the second is not redundant. `claim()` is
   * the fast path but it sweeps only after the mode check, so it never runs for
   * a workspace that has flipped back to SERVER and never runs at all once a
   * client stops polling — which is exactly when a lease is abandoned.
   * `queueStatus()` runs in both modes with no client involved, so it is what
   * makes an orphaned lease recoverable rather than permanent. Adding a
   * caller here is cheap: the UPDATE matches nothing in the normal case.
   */
  private async releaseExpired(workspaceId: string): Promise<void> {
    await this.prisma.scheduledJob.updateMany({
      where: {
        workspaceId,
        kind: RESEARCH_RUN_KIND,
        status: RESEARCH_JOB_CLAIMED,
        lockedAt: { lt: new Date(Date.now() - RESEARCH_LEASE_MS) },
      },
      data: { status: 'PENDING', lockedAt: null },
    });
  }

  /**
   * The job a caller claims to hold, or a loud refusal.
   *
   * Every predicate here is load-bearing and each rules out a different wrong
   * caller: `workspaceId` a neighbouring tenant, `kind` some other scheduled
   * job whose id was guessed, `status` a job that is not in a state this write
   * belongs to.
   *
   * What `status` does NOT rule out is an expired lease. Expiry is swept
   * lazily — by `claim()` and by `queueStatus()` — so a row whose lease ran out
   * an hour ago still reads CLAIMED until one of those runs. And a lease
   * carries no holder identity: `lockedAt` records WHEN, never WHO. So if A's
   * lease expires, the sweep returns the row to the queue and B claims it, A's
   * stale job id still resolves here and A can still submit or complete into
   * the job B now holds. Both are the same tenant and the staging write is
   * idempotent on `(workspaceId, profileId, externalRef)`, so the cost is lost
   * or duplicated work — B's job closed out from under it, or two clients'
   * candidates merged into one night — not a boundary crossing. Giving a lease
   * an owner token is the fix; it is not implemented, and this comment must not
   * pretend otherwise.
   */
  private async requireLeased(
    workspaceId: string,
    jobId: string,
    statuses: string[],
  ): Promise<{ job: ResearchJob; runId: string | null; status: string }> {
    const row = await this.prisma.scheduledJob.findFirst({
      where: { id: jobId, workspaceId, kind: RESEARCH_RUN_KIND, status: { in: statuses } },
      select: { id: true, payload: true, status: true },
    });
    if (!row) {
      throw new NotFoundException(
        `no claimed research job ${jobId} in this workspace — it was never claimed, belongs to ` +
          'someone else, or its lease expired and it went back to the queue. Claim again with ' +
          'jeeta.claim_research_job.',
      );
    }
    const payload = (row.payload ?? {}) as { profileId?: string; mcpAgentRunId?: string };
    if (!payload.profileId) {
      throw new BadRequestException(`research job ${jobId} carries no profileId`);
    }
    const job = await this.jobs.buildJob(workspaceId, payload.profileId);
    if (!job) {
      throw new BadRequestException(
        `the brief behind research job ${jobId} is paused or deleted, or the daily lead allowance ` +
          'is used up — nothing can be staged against it now.',
      );
    }
    return { job, runId: payload.mcpAgentRunId ?? null, status: row.status };
  }

  /** Terminal write on a leased job. Guarded so it can only close OUR lease. */
  private async close(
    workspaceId: string,
    jobId: string,
    status: 'DONE' | 'FAILED',
    reason?: string,
  ): Promise<boolean> {
    const res = await this.prisma.scheduledJob.updateMany({
      where: { id: jobId, workspaceId, status: RESEARCH_JOB_CLAIMED },
      data: {
        status,
        completedAt: new Date(),
        lockedAt: null,
        ...(reason !== undefined ? { lastError: reason } : {}),
      },
    });
    return res.count > 0;
  }
}
