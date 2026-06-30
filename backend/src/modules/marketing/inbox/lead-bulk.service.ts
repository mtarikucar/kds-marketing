import { Injectable, BadRequestException, NotFoundException, OnModuleInit, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { WorkflowExecutorService } from '../workflows/workflow-executor.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ScheduledJobRunnerService, ClaimedJob, JobHandlerResult } from '../scheduling/scheduled-job-runner.service';

export interface ExportLeadsFilter {
  status?: string;
  source?: string;
  businessType?: string;
  assignedToId?: string;
  assignmentStatus?: 'unassigned' | 'assigned' | 'mine';
  search?: string;
}

export interface EnrollFilter {
  status?: string;
  assignedToId?: string;
  businessType?: string;
  source?: string;
  city?: string;
  search?: string;
}

/** ScheduledJob kind for the resumable bulk-enroll fan-out (see enrollBatch). */
export const LEAD_ENROLL_BATCH_KIND = 'lead.enroll_batch';

/** Max leads a single bulk-by-filter enroll fans out — guards a runaway segment. */
const ENROLL_BY_FILTER_CAP = 5000;
/** Leads enrolled per background batch — same throttle shape as campaign sends. */
const ENROLL_BATCH_SIZE = 50;
/** Delay between batches (~50 enrolls/min, bounding inline workflow advances). */
const ENROLL_BATCH_INTERVAL_SEC = 30;

/**
 * Discriminated payload for the enroll fan-out job. `ids` enrolls a fixed,
 * pre-resolved set (paged by offset); `filter` walks the audience by lead-id
 * cursor so the set is re-read fresh each batch (no upfront count→findMany TOCTOU)
 * and capped by `processed`.
 */
type EnrollJobPayload =
  | { mode: 'ids'; workspaceId: string; workflowId: string; actorId: string; ids: string[]; offset: number }
  | { mode: 'filter'; workspaceId: string; workflowId: string; actorId: string; filter: EnrollFilter; afterId: string | null; processed: number };

/**
 * Bulk lead operations for the inbox/leads list (GHL parity): soft-delete,
 * manual workflow enrollment, and CSV export. Workspace-scoped throughout; REP
 * callers are confined to their own leads (the assignedToId clamp). Kept out of
 * the (large) MarketingLeadsService and given its own service so the workflow
 * executor dependency stays localized.
 *
 * Enrollment is NEVER run inline: a bulk enroll can fan out thousands of
 * `executor.start` calls, each of which synchronously advances the workflow to
 * its first wait (real email/SMS/WhatsApp/AI sends). Doing that in the request
 * would block the event loop and time out, leaving a non-resumable partial. So
 * enrolls enqueue a `lead.enroll_batch` ScheduledJob that processes a bounded
 * slice per tick and re-schedules itself — resumable across restarts (the
 * runner's crash reaper re-drives a stuck batch), throttled, and idempotent per
 * (workflow, lead) via executor.start.
 */
@Injectable()
export class LeadBulkService implements OnModuleInit {
  private readonly logger = new Logger(LeadBulkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: WorkflowExecutorService,
    private readonly scheduledJobs: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(LEAD_ENROLL_BATCH_KIND, (job) => this.enrollBatch(job));
  }

  private cleanIds(ids: string[]): string[] {
    return [...new Set(ids)].filter((s) => typeof s === 'string' && s.length > 0);
  }

  /** Soft-delete: tombstone via deletedAt so the leads list hides them. */
  async bulkDelete(workspaceId: string, leadIds: string[]) {
    const ids = this.cleanIds(leadIds);
    if (ids.length === 0) throw new BadRequestException('leadIds must contain at least one id');
    // Converted/WON leads are FINAL — soft-deleting one hides it from won/lost
    // reporting while its provisioned tenant + earned commission dangle (the
    // single delete() refuses them for exactly this reason). Protect them in the
    // bulk path too: exclude them from the tombstone and report how many were
    // skipped so the operator understands why fewer than selected were removed.
    const skippedProtected = await this.prisma.lead.count({
      where: {
        id: { in: ids },
        workspaceId,
        deletedAt: null,
        OR: [{ convertedTenantId: { not: null } }, { status: 'WON' }],
      },
    });
    const res = await this.prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId, deletedAt: null, convertedTenantId: null, status: { not: 'WON' } },
      data: { deletedAt: new Date() },
    });
    return { deleted: res.count, skippedProtected };
  }

  /**
   * Manually enroll a fixed set of leads into a workflow (the missing
   * manual-enroll path). Resolves the scoped, non-tombstoned subset, then
   * enqueues the resumable fan-out job. Returns the queued count — enrollment
   * happens in the background.
   */
  async bulkEnroll(workspaceId: string, leadIds: string[], workflowId: string, actorId: string) {
    const ids = this.cleanIds(leadIds);
    if (ids.length === 0) throw new BadRequestException('leadIds must contain at least one id');
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
      select: { id: true },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    // Only enroll leads that actually belong to the workspace (and aren't
    // tombstoned). Scoped read; ids from elsewhere fall out.
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: ids }, workspaceId, deletedAt: null, mergedIntoId: null },
      select: { id: true },
    });
    if (leads.length === 0) throw new BadRequestException('No matching leads to enroll');
    await this.assertNoEnrollInFlight(workspaceId, workflowId);
    await this.enqueue({
      mode: 'ids', workspaceId, workflowId, actorId, ids: leads.map((l) => l.id), offset: 0,
    });
    return { queued: leads.length };
  }

  /**
   * Bulk-enroll every lead matching an audience FILTER into a workflow (the
   * "drip sequence" entry point — Epic 9c). Workspace-scoped, capped, and
   * idempotent per (workflow, lead). Enrolling the WHOLE list (no filter) is a
   * deliberate, high-blast-radius action, so it must be explicitly confirmed via
   * `enrollAll`. The actual fan-out runs in the background batch job.
   */
  async bulkEnrollByFilter(
    workspaceId: string,
    filter: EnrollFilter,
    workflowId: string,
    actorId: string,
    enrollAll = false,
  ) {
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
      select: { id: true },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    const hasFilter = !!(filter.status || filter.assignedToId || filter.businessType || filter.source || filter.city || filter.search);
    if (!hasFilter && !enrollAll) {
      throw new BadRequestException('Select at least one filter, or confirm enrolling all contacts');
    }

    // Advisory total for the queued response + the cap rejection (so the operator
    // can narrow). The fan-out itself walks by cursor and re-caps via `processed`,
    // so a concurrent insert between this count and the batch cannot exceed the cap.
    const cond = buildEnrollCond(filter);
    const total = await this.prisma.lead.count({ where: { workspaceId, ...cond } });
    if (total === 0) throw new BadRequestException('No leads match the filter');
    if (total > ENROLL_BY_FILTER_CAP) {
      throw new BadRequestException(`Filter matches ${total} leads — narrow it to ${ENROLL_BY_FILTER_CAP} or fewer to enroll`);
    }
    await this.assertNoEnrollInFlight(workspaceId, workflowId);
    await this.enqueue({
      mode: 'filter', workspaceId, workflowId, actorId, filter, afterId: null, processed: 0,
    });
    return { queued: total };
  }

  /**
   * Reject a second enroll into the same workflow while one is still fanning
   * out — prevents a pile-up and prevents a fresh chain from clobbering an
   * in-flight one's cursor. (The dedupKey on schedule() is the concurrent-racer
   * backstop; this gives the operator a clean error in the common case.)
   */
  private async assertNoEnrollInFlight(workspaceId: string, workflowId: string): Promise<void> {
    const inFlight = await this.prisma.scheduledJob.findFirst({
      where: { workspaceId, kind: LEAD_ENROLL_BATCH_KIND, dedupKey: enrollDedupKey(workflowId), status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (inFlight) {
      throw new BadRequestException('An enrollment is already running for this automation — wait for it to finish');
    }
  }

  /** Enqueue the FIRST batch; the handler then advances the same row in place. */
  private async enqueue(payload: EnrollJobPayload): Promise<void> {
    await this.scheduledJobs.schedule({
      workspaceId: payload.workspaceId,
      kind: LEAD_ENROLL_BATCH_KIND,
      runAt: new Date(),
      dedupKey: enrollDedupKey(payload.workflowId),
      payload: payload as unknown as Prisma.InputJsonValue,
    });
  }

  /** Reschedule directive: advance THIS job row to the next slice (no child row). */
  private next(payload: EnrollJobPayload): JobHandlerResult {
    return {
      reschedule: {
        runAt: new Date(Date.now() + ENROLL_BATCH_INTERVAL_SEC * 1000),
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    };
  }

  /**
   * One slice of an enroll fan-out. Re-fetches the (still-scoped) workflow, runs
   * a bounded batch of executor.start calls, then RETURNS a reschedule directive
   * for the next slice (the runner advances this same row in place — one row per
   * chain, so it can't collide with itself on the dedup index). Returning void
   * ends the chain. A throw bubbles to the runner, which retries with backoff
   * (and reaps a crashed RUNNING batch) — so the fan-out is resumable.
   */
  private async enrollBatch(job: ClaimedJob): Promise<JobHandlerResult> {
    const p = job.payload as EnrollJobPayload;
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: p.workflowId, workspaceId: p.workspaceId },
    });
    if (!workflow) return; // workflow deleted mid-fanout — stop the chain

    if (p.mode === 'ids') {
      const slice = p.ids.slice(p.offset, p.offset + ENROLL_BATCH_SIZE);
      const leads = slice.length
        ? await this.prisma.lead.findMany({
            where: { id: { in: slice }, workspaceId: p.workspaceId, deletedAt: null, mergedIntoId: null },
            select: { id: true },
          })
        : [];
      const tally = await this.enrollLeads(workflow, leads, p.actorId);
      this.logger.debug(`enroll ids batch wf=${p.workflowId} off=${p.offset} ${JSON.stringify(tally)}`);
      const nextOffset = p.offset + slice.length;
      return nextOffset < p.ids.length ? this.next({ ...p, offset: nextOffset }) : undefined;
    }

    // mode === 'filter' — walk the audience by lead-id cursor, capped by processed.
    const budget = ENROLL_BY_FILTER_CAP - p.processed;
    if (budget <= 0) return;
    const take = Math.min(ENROLL_BATCH_SIZE, budget);
    const cond = buildEnrollCond(p.filter);
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId: p.workspaceId, ...cond, ...(p.afterId ? { id: { gt: p.afterId } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: { id: true },
    });
    if (leads.length === 0) return;
    const tally = await this.enrollLeads(workflow, leads, p.actorId);
    this.logger.debug(`enroll filter batch wf=${p.workflowId} after=${p.afterId ?? 'start'} ${JSON.stringify(tally)}`);
    const processed = p.processed + leads.length;
    // A short batch means the audience is drained; stop. A full batch that hasn't
    // hit the cap continues from the last id.
    return leads.length === take && processed < ENROLL_BY_FILTER_CAP
      ? this.next({ ...p, afterId: leads[leads.length - 1].id, processed })
      : undefined;
  }

  /** Enroll loop — executor.start is idempotent per (workflow, lead). */
  private async enrollLeads(workflow: unknown, leads: Array<{ id: string }>, actorId: string) {
    let enrolled = 0;
    let failed = 0;
    for (const lead of leads) {
      try {
        // A duplicate live run returns null (skipped), a new run returns its id
        // (enrolled). A thrown error is a real failure, counted separately.
        const runId = await this.executor.start(
          workflow as any,
          { leadId: lead.id },
          { manual: true, enrolledBy: actorId },
        );
        if (runId) enrolled++;
      } catch {
        failed++;
      }
    }
    return { enrolled, skipped: leads.length - enrolled - failed, failed };
  }

  /** RFC-4180 CSV of the workspace's (non-deleted) leads, honoring basic filters. */
  async exportCsv(
    workspaceId: string,
    filter: ExportLeadsFilter,
    userId?: string,
    userRole?: string,
  ): Promise<string> {
    // Mirror MarketingLeadsService.findAll's assignment scoping so the exported
    // CSV reflects EXACTLY the on-screen, filtered list. A REP is always pinned
    // to their own leads; a manager's unassigned/assigned/mine selection (or an
    // explicit rep id) maps to the same assignedToId predicate the list uses.
    let assignment: Prisma.LeadWhereInput = {};
    if (userRole === 'REP') {
      assignment = { assignedToId: userId };
    } else if (filter.assignedToId) {
      assignment = { assignedToId: filter.assignedToId };
    } else if (filter.assignmentStatus === 'unassigned') {
      assignment = { assignedToId: null };
    } else if (filter.assignmentStatus === 'assigned') {
      assignment = { assignedToId: { not: null } };
    } else if (filter.assignmentStatus === 'mine') {
      assignment = { assignedToId: userId };
    }

    // Only the optional predicate is hoisted; workspaceId is inlined in the
    // findMany call below (the fitness test requires a literal workspaceId).
    const match: Prisma.LeadWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.businessType ? { businessType: filter.businessType } : {}),
      ...assignment,
      ...(filter.search
        ? {
            OR: [
              { businessName: { contains: filter.search, mode: 'insensitive' } },
              { contactPerson: { contains: filter.search, mode: 'insensitive' } },
              { phone: { contains: filter.search } },
              { email: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const COLUMNS: Array<[string, (l: any) => unknown]> = [
      ['Business Name', (l) => l.businessName],
      ['Contact Person', (l) => l.contactPerson],
      ['Phone', (l) => l.phone],
      ['Email', (l) => l.email],
      ['Status', (l) => l.status],
      ['City', (l) => l.city],
      ['Region', (l) => l.region],
      ['Source', (l) => l.source],
      ['Business Type', (l) => l.businessType],
      ['Created At', (l) => l.createdAt?.toISOString?.() ?? ''],
    ];
    const lines: string[] = [COLUMNS.map((c) => csvCell(c[0])).join(',')];
    // Cursor-paged DB reads; bounded total rows so a giant workspace can't
    // balloon the in-memory CSV string (a one-shot export, not a stream).
    const PAGE = 1000;
    const MAX_ROWS = 100_000;
    let cursor: string | undefined;
    while (lines.length <= MAX_ROWS) {
      const rows: any[] = await this.prisma.lead.findMany({
        where: { workspaceId, deletedAt: null, mergedIntoId: null, ...match },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      for (const l of rows) lines.push(COLUMNS.map(([, get]) => csvCell(get(l))).join(','));
      if (rows.length < PAGE) break;
      cursor = rows[rows.length - 1].id;
    }
    return lines.join('\r\n');
  }
}

/** dedupKey namespacing so one enroll fan-out runs per workflow at a time. */
function enrollDedupKey(workflowId: string): string {
  return `enroll:${workflowId}`;
}

/**
 * Audience predicate for an enroll filter — WITHOUT workspaceId, which the
 * caller inlines at each Prisma call (the scoping fitness test requires an
 * inline literal, not a hoisted `where`). Always excludes tombstoned/merged.
 */
function buildEnrollCond(filter: EnrollFilter): Prisma.LeadWhereInput {
  return {
    deletedAt: null,
    mergedIntoId: null,
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}),
    ...(filter.businessType ? { businessType: filter.businessType } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.city ? { city: { contains: filter.city, mode: 'insensitive' } } : {}),
    ...(filter.search
      ? { OR: [
          { businessName: { contains: filter.search, mode: 'insensitive' } },
          { contactPerson: { contains: filter.search, mode: 'insensitive' } },
          { email: { contains: filter.search, mode: 'insensitive' } },
        ] }
      : {}),
  };
}

/** RFC-4180 cell + CSV-injection guard: neutralize a leading =/+/-/@/tab/CR
 *  (spreadsheet formula triggers) with a leading apostrophe, then quote when the
 *  value contains comma/quote/newline (doubling inner quotes). */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // formula-injection neutralization
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
