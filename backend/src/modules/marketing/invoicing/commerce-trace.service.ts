import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

/** The mapper's output — `commerceActivity()` in commerce-activity.ts. */
export interface CommerceActivityRow {
  type: string;
  title: string;
  description: string | null;
  metadata: Prisma.InputJsonValue;
}

/**
 * The ONE writer of commerce rows onto a person's stream.
 *
 * Four call sites want to leave the same kind of trace (a quote emailed, a
 * quote answered, an invoice emailed, an invoice paid) and three of them are
 * inside money paths. Putting the write behind one collaborator buys three
 * things the call sites must not each re-derive:
 *
 * 1. **It never throws.** Every caller is finishing something irreversible —
 *    an invoice has just been marked PAID, a mail has already left. A trace
 *    that failed must not roll back, or appear to fail, the thing it records.
 *    The row is the story, not the transaction.
 *
 * 2. **It resolves the person in-workspace first.** `LeadActivity` has no
 *    `workspaceId` column of its own and reaches the tenant only through its
 *    `leadId` foreign key, so a lead id that belongs to a neighbour would
 *    otherwise be written happily. The read is the guard.
 *
 * 3. **It knows who the author is when nobody clicked.** `createdById` is
 *    required with `onDelete: Restrict`, and the customer — not a colleague —
 *    is who paid the invoice. The workspace's SYSTEM sentinel stands in, the
 *    same way ingress, the web form and the leadgen path already do. A
 *    workspace that somehow has no sentinel writes NOTHING rather than
 *    throwing an FK violation inside someone else's transaction.
 *
 * The sentinel cache deliberately remembers only a HIT. Caching a miss would
 * disable the trace for a whole workspace until the process restarted — the
 * bug `conversation-ingress.service.ts` documents having already fixed once.
 */
@Injectable()
export class CommerceTraceService {
  private readonly logger = new Logger(CommerceTraceService.name);
  private readonly sentinelCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Leave the row, or leave nothing. Never throws, never returns a failure —
   * the caller has no decision to make on the outcome.
   *
   * `leadId` is nullable because a document need not have a contact: a walk-in
   * sale invoiced to nobody has no person to write on, and that is a normal
   * state rather than an error.
   */
  async record(
    workspaceId: string,
    leadId: string | null,
    row: CommerceActivityRow,
    opts?: { actorId?: string | null },
  ): Promise<void> {
    if (!leadId) return;
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { id: leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) return;

      const createdById = opts?.actorId ?? (await this.resolveSentinel(workspaceId));
      if (!createdById) {
        this.logger.warn(
          `commerce trace skipped for lead=${leadId}: workspace ${workspaceId} has no SYSTEM user to attribute it to`,
        );
        return;
      }

      await this.prisma.leadActivity.create({
        data: {
          type: row.type,
          title: row.title,
          description: row.description,
          metadata: row.metadata,
          leadId,
          createdById,
        },
      });
    } catch (e) {
      this.logger.warn(
        `commerce trace failed for lead=${leadId} in ${workspaceId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    const cached = this.sentinelCache.get(workspaceId);
    if (cached) return cached;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    if (!row?.id) return null;
    this.sentinelCache.set(workspaceId, row.id);
    return row.id;
  }
}
