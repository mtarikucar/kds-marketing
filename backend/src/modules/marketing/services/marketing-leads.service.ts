import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from './lead-auto-assigner.service';
import { CustomFieldsService } from './custom-fields.service';
import { EmailHygieneService } from '../leads/email-hygiene.service';
import { normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import { findCoreIntegratedWorkspaceId } from './core-workspace.helper';
import { CreateLeadDto } from '../dto/create-lead.dto';
import { UpdateLeadDto } from '../dto/update-lead.dto';
import { LeadFilterDto } from '../dto/lead-filter.dto';
import { ConvertLeadDto } from '../dto/convert-lead.dto';
import { MarketingEventTypes } from '../events/marketing-event-types';
import {
  CORE_PROVISIONING_PORT,
  CoreProvisioningPort,
} from '../../../core-contracts/provisioning/tenant-provisioning.port';
import {
  CoreProvisioningEmailInUseError,
  CoreProvisioningPlanInvalidError,
  CoreProvisioningSubdomainError,
} from '../../../core-contracts/provisioning/tenant-provisioning.types';

/**
 * Allowed lead status transitions. Terminal states (WON, LOST) are
 * captured by returning an empty array — no further move is permitted
 * once the lead is closed, otherwise a rep could flip a converted WON
 * lead back to NEW and leave the tenant/commission dangling.
 */
export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  NEW: ['CONTACTED', 'NOT_REACHABLE', 'LOST'],
  CONTACTED: ['MEETING_DONE', 'DEMO_SCHEDULED', 'NOT_REACHABLE', 'WAITING', 'LOST'],
  NOT_REACHABLE: ['CONTACTED', 'LOST'],
  MEETING_DONE: ['DEMO_SCHEDULED', 'OFFER_SENT', 'WAITING', 'LOST'],
  DEMO_SCHEDULED: ['MEETING_DONE', 'OFFER_SENT', 'WAITING', 'LOST'],
  OFFER_SENT: ['WAITING', 'WON', 'LOST'],
  WAITING: ['OFFER_SENT', 'WON', 'LOST'],
  WON: [],
  LOST: [],
};

@Injectable()
export class MarketingLeadsService {
  private readonly logger = new Logger(MarketingLeadsService.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private autoAssigner: LeadAutoAssignerService,
    // Step D decoupling: tenant/user/subscription provisioning is owned by
    // CORE behind this port — marketing no longer writes those tables.
    @Inject(CORE_PROVISIONING_PORT)
    private readonly provisioning: CoreProvisioningPort,
    private readonly outbox: OutboxService,
    private readonly customFields: CustomFieldsService,
    private readonly hygiene: EmailHygieneService,
  ) {}

  /** Epic 6 — a contact's companyId must reference a Company in the same
   *  workspace (soft ref; reject a missing/cross-tenant id at the boundary). */
  private async assertCompanyInWorkspace(workspaceId: string, companyId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, workspaceId },
      select: { id: true },
    });
    if (!company) throw new BadRequestException('Company not found in this workspace');
  }

  async create(workspaceId: string, dto: CreateLeadDto, userId: string, userRole: string) {
    // Idempotency: refuse to create a second OPEN lead for the same
    // email. Two reps logging the same prospect was the actual
    // user-pain (no unique constraint at the DB level because the
    // schema needs to allow a customer to come back later as a
    // separate opportunity, but blocking duplicates while the first
    // is still in pipeline is the right tradeoff). Scoped: another
    // workspace tracking the same prospect is not a duplicate here.
    if (dto.email) {
      const existing = await this.prisma.lead.findFirst({
        where: {
          workspaceId,
          // Dedup on the NORMALIZED key so "John@X.com" matches "john@x.com"
          // (raw email was case/format-sensitive); skip tombstoned leads.
          emailNormalized: normalizeEmail(dto.email),
          mergedIntoId: null,
          deletedAt: null,
          status: { notIn: ['WON', 'LOST'] },
        },
        select: { id: true, businessName: true, assignedTo: { select: { firstName: true, lastName: true } } },
      });
      if (existing) {
        const owner = existing.assignedTo
          ? `${existing.assignedTo.firstName} ${existing.assignedTo.lastName}`
          : 'unassigned';
        throw new ConflictException(
          `A lead with this email already exists (${existing.businessName}, owned by ${owner})`,
        );
      }
    }

    // Resolve the owner once, in this priority:
    //   1. explicit dto.assignedToId (manager picks a rep at creation)
    //   2. for REP creators → themselves (they own what they enter)
    //   3. auto-assigner (round-robin / least-loaded) when configured
    //   4. unassigned (null) — falls into the lead pool for the manager
    //
    // REP guard: assigning to another rep is a manager-only
    // action — `PATCH /leads/:id/assign` enforces that, so we have to
    // enforce it here too. Without this check a rep could POST a new
    // lead with `assignedToId` set to another rep and bypass the patch
    // guard entirely. Self-assignment is fine and matches priority 2.
    if (
      userRole === 'REP' &&
      dto.assignedToId &&
      dto.assignedToId !== userId
    ) {
      throw new ForbiddenException('Only managers can assign leads to other reps');
    }
    let resolvedAssignee: string | null = null;
    if (dto.assignedToId) {
      // Cross-reference must stay in-workspace: a manager pasting a rep
      // id from another workspace must not silently leak the lead there.
      const rep = await this.prisma.marketingUser.findFirst({
        where: { id: dto.assignedToId, workspaceId },
        select: { id: true },
      });
      if (!rep) throw new NotFoundException('Sales rep not found');
      resolvedAssignee = dto.assignedToId;
    } else if (userRole === 'REP') {
      resolvedAssignee = userId;
    } else {
      resolvedAssignee = await this.autoAssigner.pickAssignee(workspaceId);
    }

    // Epic A1 — validate/coerce custom field values against the workspace's
    // definitions (enforces SELECT options + required on create, drops unknowns).
    const customFields = await this.customFields.validateAndNormalize(
      workspaceId,
      'LEAD',
      dto.customFields,
      'create',
    );

    // Epic 6 — a supplied company must belong to this workspace (soft ref).
    if (dto.companyId) await this.assertCompanyInWorkspace(workspaceId, dto.companyId);

    // Epic 9a — list-hygiene tier-1: classify the email (syntax + MX) at ingest
    // so an INVALID address is kept out of email campaign audiences. Best-effort
    // + timeout-bounded; a transient DNS blip leaves it UNKNOWN (still mailable).
    const emailVerifiedStatus = await this.hygiene.verify(dto.email);

    const { customFields: _ignoredCustomFields, ...leadData } = dto;
    const lead = await this.prisma.lead.create({
      data: {
        ...leadData,
        workspaceId,
        companyId: dto.companyId || null, // normalize '' → null
        emailVerifiedStatus,
        nextFollowUp: dto.nextFollowUp ? new Date(dto.nextFollowUp) : undefined,
        assignedToId: resolvedAssignee,
        customFields: customFields as Prisma.InputJsonValue,
        phoneNormalized: normalizePhone(dto.phone),
        emailNormalized: normalizeEmail(dto.email),
      },
      include: {
        assignedTo: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    // Fire the `lead.created` workflow trigger (it was only emitted by the
    // form/channel paths, so manually-created leads never ran automations,
    // Slack alerts, outbound webhooks or AI routines). Best-effort.
    await this.emitLeadCreated(workspaceId, lead.id, lead.source);
    return lead;
  }

  /** Emit the lead.created domain event (workflow trigger). Best-effort. */
  private async emitLeadCreated(
    workspaceId: string,
    leadId: string,
    source: string,
  ): Promise<void> {
    await this.outbox
      .append({
        type: MarketingEventTypes.LeadCreated,
        idempotencyKey: `lead-created:${leadId}`,
        payload: { workspaceId, leadId, source, occurredAt: new Date().toISOString() },
      })
      .catch((e) =>
        this.logger.warn(
          `lead.created outbox append failed for ${leadId}: ${(e as Error).message}`,
        ),
      );
  }

  async findAll(workspaceId: string, filter: LeadFilterDto, userId: string, userRole: string) {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const where: Prisma.LeadWhereInput = {};

    if (userRole === 'REP') {
      // Reps always see only their leads — assignmentStatus has no
      // effect on their scope ("mine" is implicit for them).
      where.assignedToId = userId;
    } else if (filter.assignedToId) {
      where.assignedToId = filter.assignedToId;
    } else if (filter.assignmentStatus === 'unassigned') {
      where.assignedToId = null;
    } else if (filter.assignmentStatus === 'assigned') {
      where.assignedToId = { not: null };
    } else if (filter.assignmentStatus === 'mine') {
      where.assignedToId = userId;
    }

    if (filter.search) {
      where.OR = [
        { businessName: { contains: filter.search, mode: 'insensitive' } },
        { contactPerson: { contains: filter.search, mode: 'insensitive' } },
        { email: { contains: filter.search, mode: 'insensitive' } },
        { phone: { contains: filter.search, mode: 'insensitive' } },
      ];
    }

    if (filter.status) where.status = filter.status;
    if (filter.city) where.city = { contains: filter.city, mode: 'insensitive' };
    if (filter.region) where.region = { contains: filter.region, mode: 'insensitive' };
    if (filter.source) where.source = filter.source;
    if (filter.businessType) where.businessType = filter.businessType;
    if (filter.priority) where.priority = filter.priority;

    if (filter.dateFrom || filter.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) where.createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo) where.createdAt.lte = new Date(filter.dateTo);
    }

    const allowedSortFields = [
      'createdAt',
      'updatedAt',
      'businessName',
      'contactPerson',
      'city',
      'status',
      'source',
      'priority',
      'nextFollowUp',
    ];
    const orderBy: Prisma.LeadOrderByWithRelationInput = {};
    if (filter.sortBy && allowedSortFields.includes(filter.sortBy)) {
      (orderBy as any)[filter.sortBy] = filter.sortOrder || 'desc';
    } else {
      orderBy.createdAt = 'desc';
    }

    // Epic A4 — merged duplicates are tombstoned, not deleted; hide them from
    // the pipeline list/count (a direct GET /:id still resolves a tombstone).
    where.mergedIntoId = null;
    // Inbox productivity — soft-deleted leads (bulk delete) are hidden too.
    where.deletedAt = null;

    // workspaceId is spread LAST so no filter combination can ever
    // widen the query beyond the caller's workspace.
    const [leads, total] = await Promise.all([
      this.prisma.lead.findMany({
        where: { ...where, workspaceId },
        orderBy,
        skip,
        take: limit,
        include: {
          assignedTo: {
            select: { id: true, firstName: true, lastName: true },
          },
          _count: {
            select: { activities: true, offers: true, tasks: true },
          },
        },
      }),
      this.prisma.lead.count({ where: { ...where, workspaceId } }),
    ]);

    return {
      data: leads,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(workspaceId: string, id: string, userId: string, userRole: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, workspaceId },
      include: {
        assignedTo: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            createdBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
        offers: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            createdBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
        tasks: {
          orderBy: { dueDate: 'asc' },
          take: 50,
          where: { status: { not: 'CANCELLED' } },
          include: {
            assignedTo: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
        _count: {
          select: { activities: true, offers: true, tasks: true },
        },
      },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only view your own leads');
    }

    return lead;
  }

  async update(workspaceId: string, id: string, dto: UpdateLeadDto, userId: string, userRole: string) {
    // Workspace-safe id mutation: scoped pre-check, then update by id.
    const lead = await this.prisma.lead.findFirst({ where: { id, workspaceId } });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only update your own leads');
    }

    // Mirror create()'s "one OPEN lead per email per workspace" rule on
    // email change: editing a lead's email to one already held by another
    // open lead would otherwise sneak past the create-time dedup. Scoped to
    // this workspace, ignoring WON/LOST and this same row.
    if (dto.email !== undefined && dto.email && dto.email !== lead.email) {
      const clash = await this.prisma.lead.findFirst({
        where: {
          workspaceId,
          email: dto.email,
          status: { notIn: ['WON', 'LOST'] },
          mergedIntoId: null,
          deletedAt: null,
          id: { not: id },
        },
        select: { id: true, businessName: true, assignedTo: { select: { firstName: true, lastName: true } } },
      });
      if (clash) {
        const owner = clash.assignedTo ? `${clash.assignedTo.firstName} ${clash.assignedTo.lastName}` : 'unassigned';
        throw new ConflictException(`A lead with this email already exists (${clash.businessName}, owned by ${owner})`);
      }
    }

    // Build update explicitly — the DTO now omits assignedToId and
    // status, but being explicit keeps us safe from future DTO drift.
    const data: Prisma.LeadUpdateInput = {
      ...(dto.businessName !== undefined && { businessName: dto.businessName }),
      ...(dto.contactPerson !== undefined && { contactPerson: dto.contactPerson }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.whatsapp !== undefined && { whatsapp: dto.whatsapp }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.address !== undefined && { address: dto.address }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.region !== undefined && { region: dto.region }),
      ...(dto.businessType !== undefined && { businessType: dto.businessType }),
      ...(dto.tableCount !== undefined && { tableCount: dto.tableCount }),
      ...(dto.branchCount !== undefined && { branchCount: dto.branchCount }),
      ...(dto.currentSystem !== undefined && { currentSystem: dto.currentSystem }),
      ...(dto.source !== undefined && { source: dto.source }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.nextFollowUp !== undefined && {
        nextFollowUp: dto.nextFollowUp ? new Date(dto.nextFollowUp) : null,
      }),
      ...(dto.phone !== undefined && { phoneNormalized: normalizePhone(dto.phone) }),
      ...(dto.email !== undefined && { emailNormalized: normalizeEmail(dto.email) }),
      // Epic 6 — link/unlink the contact's B2B account ('' unlinks).
      ...(dto.companyId !== undefined && { companyId: dto.companyId || null }),
    };
    if (dto.companyId) await this.assertCompanyInWorkspace(workspaceId, dto.companyId);

    // Epic A1 — merge validated custom field values onto the existing map (a
    // partial update only touches the keys it sends; required is not enforced).
    let cfChangedKeys: string[] | null = null;
    if (dto.customFields !== undefined) {
      const validated = await this.customFields.validateAndNormalize(
        workspaceId,
        'LEAD',
        dto.customFields,
        'update',
      );
      const existing =
        (lead.customFields as Record<string, unknown> | null) ?? {};
      data.customFields = {
        ...existing,
        ...validated,
      } as Prisma.InputJsonValue;
      cfChangedKeys = Object.keys(validated);
    }

    const updated = await this.prisma.lead.update({
      where: { id },
      data,
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Best-effort change event for downstream workflow triggers (Epic A3+).
    // Never fail the update if the outbox append fails.
    if (cfChangedKeys && cfChangedKeys.length > 0) {
      try {
        await this.outbox.append({
          type: 'marketing.lead.customField.changed.v1',
          idempotencyKey: `lead-cf:${id}:${updated.updatedAt.getTime()}`,
          payload: { leadId: id, workspaceId, keys: cfChangedKeys },
        });
      } catch (e) {
        this.logger.warn(
          `customField.changed outbox append failed for lead ${id}: ${(e as Error).message}`,
        );
      }
    }
    return updated;
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: string,
    lostReason: string | undefined,
    userId: string,
    userRole: string,
  ) {
    const lead = await this.prisma.lead.findFirst({ where: { id, workspaceId } });
    if (!lead) throw new NotFoundException('Lead not found');

    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only update your own leads');
    }

    // Terminal states cannot be re-opened from this endpoint. WON in
    // particular is owned by `convert()` (which sets convertedTenantId);
    // flipping it back here would leave a dangling tenant.
    const allowed = ALLOWED_TRANSITIONS[lead.status] ?? [];
    if (status !== lead.status && !allowed.includes(status)) {
      throw new BadRequestException(
        `Invalid transition from ${lead.status} to ${status}`,
      );
    }
    if (status === 'WON') {
      throw new BadRequestException(
        'Use /convert to move a lead to WON (creates tenant and commission)',
      );
    }
    if (lead.convertedTenantId) {
      throw new BadRequestException(
        'Cannot change status of an already-converted lead',
      );
    }

    // Compound WHERE on the original status closes the TOCTOU window
    // between the transition validation above and the write. Without
    // it two managers (or a manager + rep) racing both pass the
    // ALLOWED_TRANSITIONS check from the same lead.status snapshot
    // then last-writer-wins the status — silently skipping any state
    // that was supposed to be sequential.
    const claim = await this.prisma.lead.updateMany({
      where: { id, workspaceId, status: lead.status },
      data: {
        status,
        ...(status === 'LOST' && lostReason ? { lostReason } : {}),
      },
    });
    if (claim.count === 0) {
      throw new BadRequestException(
        'Lead status changed concurrently — refresh and retry.',
      );
    }
    const updatedLead = await this.prisma.lead.findUniqueOrThrow({ where: { id } });

    await this.prisma.leadActivity.create({
      data: {
        type: 'STATUS_CHANGE',
        title: `Status changed to ${status}`,
        description: lostReason ? `Reason: ${lostReason}` : undefined,
        leadId: id,
        createdById: userId,
      },
    });

    // LOST terminates the pipeline. WON goes through convert() which
    // has its own task-cleanup hook. Cancel any open tasks attached to
    // the lead so they don't clutter the calendar — the rep would
    // never act on them.
    if (status === 'LOST') {
      await this.prisma.marketingTask.updateMany({
        where: {
          workspaceId,
          leadId: id,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        data: { status: 'CANCELLED' },
      });
    }

    // Notify the lead's assignee of the change — but only when the
    // change came from someone else (the assignee fired it themselves,
    // they already know).
    if (updatedLead.assignedToId && updatedLead.assignedToId !== userId) {
      await this.prisma.marketingNotification.create({
        data: {
          workspaceId,
          userId: updatedLead.assignedToId,
          type: 'INACTIVE_LEAD',
          title: 'Lead status updated',
          message: `${updatedLead.businessName}: ${lead.status} → ${status}`,
          metadata: { leadId: id, from: lead.status, to: status },
        },
      });
    }

    // Fire the `lead.status_changed` workflow trigger (the event the trigger
    // service subscribes to was never emitted, so those automations were dead).
    // Best-effort — never fail the status update on an outbox hiccup.
    if (status !== lead.status) {
      await this.outbox
        .append({
          type: MarketingEventTypes.LeadStatusChanged,
          idempotencyKey: `lead-status:${id}:${lead.status}->${status}:${Date.now()}`,
          payload: {
            workspaceId,
            leadId: id,
            fromStatus: lead.status,
            toStatus: status,
            occurredAt: new Date().toISOString(),
          },
        })
        .catch((e) =>
          this.logger.warn(
            `lead.status_changed outbox append failed for ${id}: ${(e as Error).message}`,
          ),
        );
    }

    return updatedLead;
  }

  async assign(
    workspaceId: string,
    id: string,
    assignedToId: string | null | undefined,
    actorId: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, workspaceId },
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    // Empty string / null / undefined → unassign. Treat all three the
    // same so the API is forgiving to clients that serialize "no
    // selection" differently (FormData empties, JSON nulls, etc.).
    const target = assignedToId && assignedToId.length > 0 ? assignedToId : null;
    const previous = lead.assignedTo;

    let rep:
      | { id: string; role: string; status: string; firstName: string; lastName: string }
      | null = null;
    if (target) {
      // Scoped cross-reference: the target rep must live in the same
      // workspace as the lead, or the row simply "does not exist" here.
      rep = await this.prisma.marketingUser.findFirst({
        where: { id: target, workspaceId },
        select: { id: true, role: true, status: true, firstName: true, lastName: true },
      });
      if (!rep) throw new NotFoundException('Sales rep not found');
      if (rep.role !== 'REP') {
        throw new BadRequestException('Target must be a REP');
      }
      if (rep.status !== 'ACTIVE') {
        throw new BadRequestException('Target rep is not active');
      }
    }

    // No-op (same owner) — skip writes so we don't pollute the timeline
    // with empty activity rows when a manager double-clicks Assign.
    if ((previous?.id ?? null) === target) {
      return this.prisma.lead.findUniqueOrThrow({
        where: { id },
        include: {
          assignedTo: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    }

    const updated = await this.prisma.lead.update({
      where: { id },
      data: { assignedToId: target },
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const fromName = previous
      ? `${previous.firstName} ${previous.lastName}`
      : null;
    const toName = rep ? `${rep.firstName} ${rep.lastName}` : null;
    const title = target
      ? fromName
        ? `Reassigned: ${fromName} → ${toName}`
        : `Assigned to ${toName}`
      : `Unassigned (was ${fromName ?? 'unknown'})`;

    await this.prisma.leadActivity.create({
      data: {
        type: 'STATUS_CHANGE',
        title,
        leadId: id,
        createdById: actorId,
        metadata: {
          kind: 'assignment',
          fromUserId: previous?.id ?? null,
          fromUserName: fromName,
          toUserId: target,
          toUserName: toName,
        },
      },
    });

    // Notify the new owner — they need to know a lead just landed in
    // their queue. Skip if they happened to assign it to themselves,
    // and skip entirely on unassign (no owner to notify).
    if (target && target !== actorId) {
      await this.prisma.marketingNotification.create({
        data: {
          workspaceId,
          userId: target,
          type: 'FOLLOW_UP_REMINDER',
          title: 'New lead assigned to you',
          message: `${updated.businessName} — ${updated.contactPerson}`,
          metadata: { leadId: id, assignedBy: actorId },
        },
      });
    }

    return updated;
  }

  /**
   * Bulk-assign a batch of leads to a single rep in one transaction.
   * Manager-only at the controller layer. Skips lead ids that don't
   * exist (reported back as `skipped`) and emits one summary
   * notification rather than N — keeps the rep's inbox usable when a
   * manager dumps 50 leads at once. `null` target unassigns the batch.
   */
  async bulkAssign(
    workspaceId: string,
    leadIds: string[],
    assignedToId: string | null | undefined,
    actorId: string,
  ) {
    const ids = Array.from(new Set(leadIds)).filter((s) => typeof s === 'string' && s.length > 0);
    if (ids.length === 0) {
      throw new BadRequestException('leadIds must contain at least one id');
    }

    const target = assignedToId && assignedToId.length > 0 ? assignedToId : null;
    let rep:
      | { id: string; role: string; status: string; firstName: string; lastName: string }
      | null = null;
    if (target) {
      // Scoped cross-reference — same reasoning as single assign().
      rep = await this.prisma.marketingUser.findFirst({
        where: { id: target, workspaceId },
        select: { id: true, role: true, status: true, firstName: true, lastName: true },
      });
      if (!rep) throw new NotFoundException('Sales rep not found');
      if (rep.role !== 'REP') {
        throw new BadRequestException('Target must be a REP');
      }
      if (rep.status !== 'ACTIVE') {
        throw new BadRequestException('Target rep is not active');
      }
    }

    // Fetch all leads (with current owner) in one round-trip so we can
    // diff each one and write a meaningful per-lead activity entry.
    // Scoped — ids from another workspace fall out as `skipped`.
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: ids }, workspaceId },
      include: {
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const found = new Set(leads.map((l) => l.id));
    const skipped = ids.filter((id) => !found.has(id));

    // Filter out no-ops (already assigned to target) — same reasoning
    // as the single-assign path: no audit churn when nothing changed.
    const changing = leads.filter((l) => (l.assignedToId ?? null) !== target);

    if (changing.length === 0) {
      return { assigned: 0, skipped, unchanged: leads.length };
    }

    const toName = rep ? `${rep.firstName} ${rep.lastName}` : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({
        where: { id: { in: changing.map((l) => l.id) }, workspaceId },
        data: { assignedToId: target },
      });
      await tx.leadActivity.createMany({
        data: changing.map((l) => {
          const fromName = l.assignedTo
            ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}`
            : null;
          const title = target
            ? fromName
              ? `Reassigned: ${fromName} → ${toName}`
              : `Assigned to ${toName}`
            : `Unassigned (was ${fromName ?? 'unknown'})`;
          return {
            type: 'STATUS_CHANGE',
            title,
            leadId: l.id,
            createdById: actorId,
            metadata: {
              kind: 'assignment',
              fromUserId: l.assignedTo?.id ?? null,
              fromUserName: fromName,
              toUserId: target,
              toUserName: toName,
              bulk: true,
            },
          };
        }),
      });

      // Single summary notification per rep — avoids burying the
      // inbox under 50 individual "lead assigned" rows when the
      // manager runs a batch. Skip when manager bulk-assigns to
      // themselves or unassigns.
      if (target && target !== actorId) {
        await tx.marketingNotification.create({
          data: {
            workspaceId,
            userId: target,
            type: 'FOLLOW_UP_REMINDER',
            title: `${changing.length} new lead${changing.length === 1 ? '' : 's'} assigned to you`,
            message: changing
              .slice(0, 3)
              .map((l) => l.businessName)
              .join(', ') + (changing.length > 3 ? `, +${changing.length - 3} more` : ''),
            metadata: {
              leadIds: changing.map((l) => l.id),
              assignedBy: actorId,
              bulk: true,
            },
          },
        });
      }
    });

    return { assigned: changing.length, skipped, unchanged: leads.length - changing.length };
  }

  /**
   * Convert a lead to a paying tenant. Provisioning (tenant + admin user +
   * subscription) is owned by CORE behind CoreProvisioningPort — idempotent on
   * the lead, so a retry or a concurrent convert that lost the claim converges
   * on the same tenant instead of minting a second one. Marketing only
   * finalizes its own state: claim the lead → WON, accept the offer, cancel
   * open tasks, stamp the SIGNUP commission, and emit marketing.lead.converted.
   */
  async convert(workspaceId: string, id: string, dto: ConvertLeadDto, userId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id, workspaceId } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.convertedTenantId) {
      throw new ConflictException('Lead already converted');
    }
    // Terminal states must not be re-opened to WON via the API. WON is reachable
    // only from OFFER_SENT/WAITING in the state machine; the Convert button is
    // hidden elsewhere in the UI, but the endpoint is directly reachable — so a
    // LOST (or stray WON-without-tenant) lead could otherwise be converted.
    if (lead.status === 'LOST' || lead.status === 'WON') {
      throw new BadRequestException(`A ${lead.status.toLowerCase()} lead cannot be converted`);
    }

    // Resolve the offer (marketing-owned) to derive the plan + offer overrides.
    // Scoped: an offer id from another workspace must not feed this convert.
    // The plan itself is validated + read by CORE inside the provisioning port;
    // marketing no longer touches SubscriptionPlan/Tenant/User/Subscription.
    let offer: Awaited<ReturnType<typeof this.prisma.leadOffer.findFirst>> | null = null;
    if (dto.offerId) {
      offer = await this.prisma.leadOffer.findFirst({
        where: { id: dto.offerId, workspaceId },
      });
      if (!offer || offer.leadId !== id) {
        throw new BadRequestException('Offer not found for this lead');
      }
    }
    const planId = offer?.planId ?? dto.planId ?? null;

    // Provision via the core port. Idempotent on the lead id, so a concurrent
    // convert that already provisioned the SAME tenant returns it again (the
    // claim below then decides the single winner). Port-local errors are
    // re-mapped to the same HTTP shapes the inline flow used to throw.
    const provision = await this.provisioning
      .provisionTenantForLead({
        leadId: id,
        idempotencyKey: `lead-convert:${id}`,
        tenantName: dto.tenantName,
        admin: {
          email: dto.adminEmail,
          firstName: dto.adminFirstName,
          lastName: dto.adminLastName,
        },
        plan: planId
          ? {
              planId,
              amountOverride:
                offer?.customPrice != null ? Number(offer.customPrice) : null,
              trialDaysOverride: offer?.trialDays ?? null,
            }
          : null,
      })
      .catch((err) => {
        if (err instanceof CoreProvisioningEmailInUseError) {
          throw new ConflictException('Admin email is already in use');
        }
        if (err instanceof CoreProvisioningPlanInvalidError) {
          throw new BadRequestException('Plan not found or inactive');
        }
        if (err instanceof CoreProvisioningSubdomainError) {
          throw new ConflictException('Could not allocate a free subdomain');
        }
        throw err;
      });

    const now = new Date();
    // SIGNUP commission basis = the plan's catalogue monthly price × rate, both
    // returned by the port as plan facts (rate already defaulted). NOT the
    // discounted offer price. Zero for a no-plan (FREE) conversion.
    const commissionAmount = provision.planFacts
      ? new Prisma.Decimal(provision.planFacts.monthlyPrice)
          .mul(provision.planFacts.commissionRate)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      : new Prisma.Decimal(0);
    // Period must use the same UTC basis as attainment bucketing (sales-target
    // periodRange uses Date.UTC) and the settlement consumer (occurredAt.slice(0,7)).
    // Local getMonth()/getFullYear() would file a late-month conversion into the
    // wrong month near the UTC boundary.
    const period = now.toISOString().slice(0, 7);

    let commissionId: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      // CRITICAL idempotency: claim the lead only if still unconverted. Two
      // managers converting at the same millisecond both pass the pre-check
      // and both call the (idempotent) port — which returns the SAME tenant —
      // but only the first updateMany here flips convertedTenantId. The loser
      // gets count=0 and aborts with 409; no double commission, one tenant.
      const claim = await tx.lead.updateMany({
        where: { id, workspaceId, convertedTenantId: null },
        data: {
          status: 'WON',
          convertedTenantId: provision.tenantId,
          convertedAt: now,
        },
      });
      if (claim.count === 0) {
        throw new ConflictException('Lead was converted concurrently');
      }
      const updatedLead = await tx.lead.findUniqueOrThrow({ where: { id } });

      if (offer) {
        await tx.leadOffer.update({
          where: { id: offer.id },
          data: { status: 'ACCEPTED' },
        });
      }

      // Cancel any open tasks attached to this lead — the deal is closed.
      await tx.marketingTask.updateMany({
        where: {
          workspaceId,
          leadId: id,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
        data: { status: 'CANCELLED' },
      });

      if (lead.assignedToId) {
        const commission = await tx.commission.create({
          data: {
            workspaceId,
            amount: commissionAmount,
            type: 'SIGNUP',
            status: 'PENDING',
            period,
            tenantId: provision.tenantId,
            leadId: id,
            marketingUserId: lead.assignedToId,
          },
          select: { id: true },
        });
        commissionId = commission.id;
      }

      await tx.leadActivity.create({
        data: {
          type: 'STATUS_CHANGE',
          title: 'Lead converted to customer',
          description: `Tenant "${dto.tenantName}" created`,
          leadId: id,
          createdById: userId,
        },
      });

      // Durable domain event (audit / analytics consumers). Same tx as the
      // claim so it only fires when the conversion actually committed.
      await this.outbox.append(
        {
          type: MarketingEventTypes.LeadConverted,
          tenantId: provision.tenantId,
          idempotencyKey: `lead-converted:${id}`,
          payload: {
            leadId: id,
            tenantId: provision.tenantId,
            marketingUserId: lead.assignedToId ?? null,
            commissionId,
            occurredAt: now.toISOString(),
          },
        },
        tx as any,
      );

      return { lead: updatedLead, tenantId: provision.tenantId };
    });

    // Welcome email outside the tx. Only on first provisioning — an idempotent
    // replay already delivered the password (adminTempPassword is empty then).
    // Failure here never rolls back the conversion; the owner can recover via
    // /auth/forgot-password.
    if (provision.created && provision.adminTempPassword) {
      // Product identity comes from env, not code: APP_NAME/APP_URL describe
      // the CORE product the lead was converted into (per-workspace branding
      // replaces this once Workspace.coreIntegration carries it). Without a
      // URL the credentials mail would point nowhere — skip it; the owner
      // can still recover via the core app's forgot-password flow.
      const appUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
      const appName = (process.env.APP_NAME ?? '').trim();
      if (!appUrl) {
        this.logger.warn(
          'APP_URL is not set — skipping tenant welcome email after lead conversion',
        );
      } else {
        try {
          await this.emailService.sendEmail({
            to: dto.adminEmail,
            subject: appName ? `${appName} hesabınız hazır` : 'Hesabınız hazır',
            template: 'marketing-tenant-welcome',
            context: {
              adminFirstName: dto.adminFirstName,
              adminEmail: dto.adminEmail,
              tenantName: dto.tenantName,
              rawPassword: provision.adminTempPassword,
              appName,
              appUrl,
              loginUrl: `${appUrl}/login`,
            },
          });
        } catch (err) {
          // Log only; do not fail the response.
          this.logger.error('Failed to send welcome email after lead conversion', err as any);
        }
      }
    }

    return result;
  }

  /**
   * Orphan-reconciliation sweep (Step D saga safety net). Conversion provisions
   * the tenant via the core port BEFORE the marketing finalization tx; if that
   * tx fails for a non-claim reason and the user never retries, the tenant is
   * left with no WON lead / commission. This finds provisioned-but-unfinalized
   * leads (via the core ledger port) and completes the marketing side. Driven
   * by an advisory-locked hourly cron (MarketingSchedulerService).
   */
  async reconcileOrphanProvisionedConversions(): Promise<{ reconciled: number }> {
    // Cron — no user context. Provisioned conversions only exist on the
    // single core-integrated workspace, so resolve it once up front and
    // scope every lookup/finalize below to it.
    const workspaceId = await findCoreIntegratedWorkspaceId(this.prisma);
    if (!workspaceId) {
      this.logger.warn(
        'No core-integrated workspace — skipping orphan-conversion reconciliation sweep',
      );
      return { reconciled: 0 };
    }

    const nowMs = Date.now();
    // Grace window: ignore ledger rows younger than 10 min (a convert may be
    // mid-flight); look back 24h (older orphans should already be handled).
    const records = await this.provisioning.listProvisionedLeads(
      new Date(nowMs - 24 * 60 * 60 * 1000),
      new Date(nowMs - 10 * 60 * 1000),
    );

    let reconciled = 0;
    for (const rec of records) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: rec.leadId, workspaceId },
        select: { id: true, assignedToId: true, convertedTenantId: true },
      });
      if (!lead || lead.convertedTenantId) continue; // gone or already finalized

      const commissionAmount = rec.planFacts
        ? new Prisma.Decimal(rec.planFacts.monthlyPrice)
            .mul(rec.planFacts.commissionRate)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        : new Prisma.Decimal(0);

      try {
        await this.finalizeReconciledConversion(
          workspaceId,
          lead.id,
          lead.assignedToId,
          rec.tenantId,
          commissionAmount,
        );
        reconciled += 1;
        this.logger.warn(
          `Reconciled orphan provisioned conversion: lead=${rec.leadId} tenant=${rec.tenantId}`,
        );
      } catch (err) {
        // A concurrent finalize won the claim → fine; anything else is logged.
        if (err instanceof ConflictException) continue;
        this.logger.error(
          `Orphan reconcile failed for lead=${rec.leadId}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    return { reconciled };
  }

  /** Marketing-only finalization for a reconciled orphan (claim + commission + event). */
  private async finalizeReconciledConversion(
    workspaceId: string,
    leadId: string,
    assignedToId: string | null,
    tenantId: string,
    commissionAmount: Prisma.Decimal,
  ): Promise<void> {
    const now = new Date();
    // Period must use the same UTC basis as attainment bucketing (sales-target
    // periodRange uses Date.UTC) and the settlement consumer (occurredAt.slice(0,7)).
    // Local getMonth()/getFullYear() would file a late-month conversion into the
    // wrong month near the UTC boundary.
    const period = now.toISOString().slice(0, 7);
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.lead.updateMany({
        where: { id: leadId, workspaceId, convertedTenantId: null },
        data: { status: 'WON', convertedTenantId: tenantId, convertedAt: now },
      });
      if (claim.count === 0) {
        throw new ConflictException('Lead was finalized concurrently');
      }
      await tx.marketingTask.updateMany({
        where: { workspaceId, leadId, status: { in: ['PENDING', 'IN_PROGRESS'] } },
        data: { status: 'CANCELLED' },
      });

      let commissionId: string | null = null;
      if (assignedToId) {
        const commission = await tx.commission.create({
          data: {
            workspaceId,
            amount: commissionAmount,
            type: 'SIGNUP',
            status: 'PENDING',
            period,
            tenantId,
            leadId,
            marketingUserId: assignedToId,
          },
          select: { id: true },
        });
        commissionId = commission.id;
        // LeadActivity.createdById requires a real MarketingUser; use the
        // assigned rep. Skipped entirely when the lead was unassigned.
        await tx.leadActivity.create({
          data: {
            type: 'STATUS_CHANGE',
            title: 'Lead conversion reconciled',
            description:
              'Provisioned tenant finalized by the orphan-reconciliation sweep',
            leadId,
            createdById: assignedToId,
          },
        });
      }

      await this.outbox.append(
        {
          type: MarketingEventTypes.LeadConverted,
          tenantId,
          idempotencyKey: `lead-converted:${leadId}`,
          payload: {
            leadId,
            tenantId,
            marketingUserId: assignedToId ?? null,
            commissionId,
            occurredAt: now.toISOString(),
          },
        },
        tx as any,
      );
    });
  }

  /**
   * Routine-applied advisory AI score. Guarded: only stamps an as-yet-unscored
   * lead in the given workspace (no re-score, no cross-tenant write). Returns the
   * number of rows written (0 if the lead was already scored / not in this workspace).
   */
  async applyAiScore(
    workspaceId: string,
    leadId: string,
    score: number,
    reason: string,
  ): Promise<number> {
    const res = await this.prisma.lead.updateMany({
      where: { id: leadId, workspaceId, scoredAt: null },
      data: { aiScore: score, aiScoreReason: reason, scoredAt: new Date() },
    });
    return res.count;
  }

  async delete(workspaceId: string, id: string) {
    // Workspace-safe id mutation: scoped pre-check, then update by id.
    const lead = await this.prisma.lead.findFirst({ where: { id, workspaceId } });
    if (!lead) throw new NotFoundException('Lead not found');

    // A converted (WON) lead must NOT be archived: flipping it to LOST would
    // leave its provisioned tenant + earned commission dangling against a now-
    // "lost" record (and corrupt won/lost reporting). Closed deals are final.
    if (lead.convertedTenantId || lead.status === 'WON') {
      throw new BadRequestException('A converted lead cannot be archived');
    }

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'LOST', lostReason: 'archived_by_manager' },
    });
    return { message: 'Lead archived successfully' };
  }
}
