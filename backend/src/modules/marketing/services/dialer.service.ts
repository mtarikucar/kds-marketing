import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SalesCallService } from './sales-call.service';

export interface DialFilter {
  status?: string;
  assignedToId?: string;
  businessType?: string;
  source?: string;
  city?: string;
  search?: string;
}

export interface LogOutcomeInput {
  status: string;
  durationSec?: number;
  notes?: string;
}

/** Max leads a preview-dial session queues — a focused calling sprint, not a dump. */
const DIAL_QUEUE_CAP = 100;

/**
 * Epic 11b — PREVIEW dialer. Materializes an ordered queue of leads (with a
 * phone) from an audience filter, then drives one-at-a-time click-to-dial via
 * SalesCallService (which enforces the single-line concurrency guard). The rep
 * previews each lead, dials, logs the outcome (mirrored onto the lead timeline by
 * SalesCallService), and the queue auto-advances. Sessions are owned by the rep
 * that created them; REP callers are clamped to their own assigned leads.
 */
@Injectable()
export class DialerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salesCalls: SalesCallService,
  ) {}

  private buildWhere(filter: DialFilter): Prisma.LeadWhereInput {
    return {
      deletedAt: null,
      mergedIntoId: null,
      // Only leads we can actually dial.
      phone: { not: null },
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assignedToId ? { assignedToId: filter.assignedToId } : {}),
      ...(filter.businessType ? { businessType: filter.businessType } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.city ? { city: { contains: filter.city, mode: 'insensitive' } } : {}),
      ...(filter.search
        ? { OR: [
            { businessName: { contains: filter.search, mode: 'insensitive' } },
            { contactPerson: { contains: filter.search, mode: 'insensitive' } },
            { phone: { contains: filter.search } },
          ] }
        : {}),
    };
  }

  /** Materialize a dial queue from the filter and return the session + first lead. */
  async createSession(workspaceId: string, marketingUserId: string, role: string, filter: DialFilter) {
    // REP callers may only dial their own assigned leads.
    const effective: DialFilter = role === 'REP' ? { ...filter, assignedToId: marketingUserId } : filter;
    const cond = this.buildWhere(effective);
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, ...cond },
      orderBy: { createdAt: 'asc' },
      take: DIAL_QUEUE_CAP,
      select: { id: true },
    });
    if (leads.length === 0) throw new BadRequestException('No callable leads match the filter');

    const session = await this.prisma.dialSession.create({
      data: {
        workspaceId,
        marketingUserId,
        total: leads.length,
        items: {
          create: leads.map((l, i) => ({ workspaceId, leadId: l.id, position: i })),
        },
      },
      select: { id: true },
    });
    return this.getSession(workspaceId, session.id, marketingUserId);
  }

  private async loadSession(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.prisma.dialSession.findFirst({
      where: { id, workspaceId, marketingUserId },
    });
    if (!session) throw new NotFoundException('Dial session not found');
    return session;
  }

  /** Like loadSession, but rejects a terminal (DONE/CANCELLED) session for mutations. */
  private async loadActiveSession(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.loadSession(workspaceId, id, marketingUserId);
    if (session.status !== 'ACTIVE') throw new ConflictException('Dial session is not active');
    return session;
  }

  /** The session state + the lead currently at the front of the queue (or null). */
  async getSession(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.loadSession(workspaceId, id, marketingUserId);
    const current = await this.currentLead(workspaceId, session);
    const doneCount = await this.prisma.dialSessionItem.count({
      where: { workspaceId, dialSessionId: id, outcome: { not: null } },
    });
    return {
      id: session.id,
      status: session.status,
      currentIndex: session.currentIndex,
      total: session.total,
      done: doneCount,
      current,
    };
  }

  /** Resolve the lead at the session's current position (null when drained). */
  private async currentLead(workspaceId: string, session: { id: string; currentIndex: number; total: number; status: string }) {
    if (session.status !== 'ACTIVE' || session.currentIndex >= session.total) return null;
    const item = await this.prisma.dialSessionItem.findFirst({
      where: { workspaceId, dialSessionId: session.id, position: session.currentIndex },
    });
    if (!item) return null;
    const lead = await this.prisma.lead.findFirst({
      where: { id: item.leadId, workspaceId },
      select: { id: true, businessName: true, contactPerson: true, phone: true, status: true, city: true },
    });
    return lead ? { itemId: item.id, callId: item.callId, lead } : null;
  }

  /** Click-to-dial the current lead (reuses the single-line click-to-dial path). */
  async dial(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.loadActiveSession(workspaceId, id, marketingUserId);
    const current = await this.currentLead(workspaceId, session);
    if (!current || !current.lead.phone) throw new BadRequestException('No current lead to dial');
    const result = await this.salesCalls.startCall(workspaceId, marketingUserId, {
      toPhone: current.lead.phone,
      leadId: current.lead.id,
    } as any);
    try {
      // by-id update of an item already resolved within this workspace+session.
      await this.prisma.dialSessionItem.update({ where: { id: current.itemId }, data: { callId: result.call.id } });
    } catch (e) {
      // The queue lost the link to this live call — free the single line now
      // rather than leave it held until the 30-min stale sweep.
      await this.salesCalls.logCall(workspaceId, result.call.id, marketingUserId, { status: 'CANCELLED' } as any).catch(() => undefined);
      throw e;
    }
    return { dialUri: result.dialUri, mode: result.mode, call: result.call };
  }

  /** Log the current lead's outcome (mirrors the timeline) and auto-advance. */
  async logOutcome(workspaceId: string, id: string, marketingUserId: string, dto: LogOutcomeInput) {
    const session = await this.loadActiveSession(workspaceId, id, marketingUserId);
    const current = await this.currentLead(workspaceId, session);
    if (!current) throw new BadRequestException('Nothing to log — the queue is finished');
    // Atomic item-level idempotency: only the FIRST log/skip of this item wins.
    // A concurrent double-submit (or a skip racing a log) finds outcome already
    // set, returns count 0, and must NOT advance again (which would skip a lead).
    const claim = await this.prisma.dialSessionItem.updateMany({
      where: { id: current.itemId, workspaceId, outcome: null },
      data: { outcome: dto.status },
    });
    // Already claimed (concurrent duplicate, OR a prior attempt that crashed
    // between claiming and advancing). Re-run the idempotent CAS-advance to
    // unstick the cursor rather than short-circuit — it no-ops if the index
    // already moved, so it can never double-advance.
    if (claim.count === 0) return this.advance(workspaceId, id, marketingUserId, session.currentIndex);
    if (current.callId) {
      // SalesCallService.logCall records the outcome + mirrors a LeadActivity.
      // Best-effort: a logCall hiccup must not strand the (already-claimed) queue.
      await this.salesCalls.logCall(workspaceId, current.callId, marketingUserId, {
        status: dto.status,
        durationSec: dto.durationSec,
        notes: dto.notes,
      } as any).catch(() => undefined);
    }
    return this.advance(workspaceId, id, marketingUserId, session.currentIndex);
  }

  /** Skip the current lead without dialing and advance. */
  async skip(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.loadActiveSession(workspaceId, id, marketingUserId);
    const current = await this.currentLead(workspaceId, session);
    if (!current) return this.getSession(workspaceId, id, marketingUserId); // nothing to skip
    // Claim the item SKIPPED if not already terminal; then always run the
    // idempotent CAS-advance (it no-ops if the cursor already moved, and unsticks
    // a cursor stranded by a crash between a prior claim and its advance).
    const claim = await this.prisma.dialSessionItem.updateMany({
      where: { id: current.itemId, workspaceId, outcome: null },
      data: { outcome: 'SKIPPED' },
    });
    if (claim.count > 0 && current.callId) {
      // The item was DIALED but the rep skipped instead of logging an outcome —
      // free the single line now (mirrors dial()'s own rollback and logOutcome),
      // or every subsequent Dial in the workspace 409s "Sales line is busy"
      // until the 30-min stale sweep. Best-effort: an already-finalized call
      // ("Call already logged") must not strand the (already-claimed) queue.
      await this.salesCalls
        .logCall(workspaceId, current.callId, marketingUserId, { status: 'CANCELLED' } as any)
        .catch(() => undefined);
    }
    return this.advance(workspaceId, id, marketingUserId, session.currentIndex);
  }

  /** Cancel the whole session. */
  async cancel(workspaceId: string, id: string, marketingUserId: string) {
    const session = await this.loadSession(workspaceId, id, marketingUserId);
    // Resolve the in-flight call BEFORE flipping the session — currentLead()
    // returns null for a non-ACTIVE session, so the lookup must happen first.
    const current = session.status === 'ACTIVE' ? await this.currentLead(workspaceId, session) : null;
    // Scoped guarded update — only flips an ACTIVE session.
    const claim = await this.prisma.dialSession.updateMany({
      where: { id, workspaceId, marketingUserId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    });
    if (claim.count > 0 && current?.callId) {
      // Ending the session mid-call would otherwise strand the INITIATED call
      // and hold the workspace's single sales line for up to 30 minutes.
      // Best-effort, same as skip(): an already-logged call is tolerated.
      await this.salesCalls
        .logCall(workspaceId, current.callId, marketingUserId, { status: 'CANCELLED' } as any)
        .catch(() => undefined);
    }
    return { id, status: 'CANCELLED' };
  }

  /**
   * Move the cursor forward — a compare-and-swap keyed on the expected index, so
   * two requests that both resolved the same current item can't both advance
   * (only the one whose expectedIndex still matches wins). DONE at the end.
   */
  private async advance(workspaceId: string, id: string, marketingUserId: string, expectedIndex: number) {
    const session = await this.loadSession(workspaceId, id, marketingUserId);
    const done = expectedIndex + 1 >= session.total;
    await this.prisma.dialSession.updateMany({
      where: { id, workspaceId, marketingUserId, status: 'ACTIVE', currentIndex: expectedIndex },
      data: { currentIndex: expectedIndex + 1, ...(done ? { status: 'DONE' } : {}) },
    });
    return this.getSession(workspaceId, id, marketingUserId);
  }
}
