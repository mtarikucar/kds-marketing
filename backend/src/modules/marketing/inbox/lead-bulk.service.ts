import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { WorkflowExecutorService } from '../workflows/workflow-executor.service';

export interface ExportLeadsFilter {
  status?: string;
  assignedToId?: string;
  search?: string;
}

/**
 * Bulk lead operations for the inbox/leads list (GHL parity): soft-delete,
 * manual workflow enrollment, and CSV export. Workspace-scoped throughout; REP
 * callers are confined to their own leads (the assignedToId clamp). Kept out of
 * the (large) MarketingLeadsService and given its own service so the workflow
 * executor dependency stays localized.
 */
@Injectable()
export class LeadBulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: WorkflowExecutorService,
  ) {}

  private cleanIds(ids: string[]): string[] {
    return [...new Set(ids)].filter((s) => typeof s === 'string' && s.length > 0);
  }

  /** Soft-delete: tombstone via deletedAt so the leads list hides them. */
  async bulkDelete(workspaceId: string, leadIds: string[]) {
    const ids = this.cleanIds(leadIds);
    if (ids.length === 0) throw new BadRequestException('leadIds must contain at least one id');
    const res = await this.prisma.lead.updateMany({
      where: { id: { in: ids }, workspaceId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { deleted: res.count };
  }

  /** Manually enroll leads into a workflow (the missing manual-enroll path). */
  async bulkEnroll(workspaceId: string, leadIds: string[], workflowId: string, actorId: string) {
    const ids = this.cleanIds(leadIds);
    if (ids.length === 0) throw new BadRequestException('leadIds must contain at least one id');
    const workflow = await this.prisma.workflow.findFirst({
      where: { id: workflowId, workspaceId },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    // Only enroll leads that actually belong to the workspace (and aren't
    // tombstoned). Scoped read; ids from elsewhere fall out.
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: ids }, workspaceId, deletedAt: null, mergedIntoId: null },
      select: { id: true },
    });
    let enrolled = 0;
    let failed = 0;
    for (const lead of leads) {
      try {
        // executor.start is idempotent per (workflow, lead): a duplicate live
        // run returns null (skipped), a new run returns its id (enrolled). A
        // thrown error is a real failure, counted separately — not as a skip.
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
  async exportCsv(workspaceId: string, filter: ExportLeadsFilter): Promise<string> {
    // Only the optional predicate is hoisted; workspaceId is inlined in the
    // findMany call below (the fitness test requires a literal workspaceId).
    const match: Prisma.LeadWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}),
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

/** RFC-4180 cell + CSV-injection guard: neutralize a leading =/+/-/@/tab/CR
 *  (spreadsheet formula triggers) with a leading apostrophe, then quote when the
 *  value contains comma/quote/newline (doubling inner quotes). */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // formula-injection neutralization
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
