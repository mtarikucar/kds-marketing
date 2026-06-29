import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateOfferDto } from '../dto/create-offer.dto';
import { UpdateOfferDto } from '../dto/update-offer.dto';
import { rangeEndInclusive } from './report-date-range.util';
import { safePage, safeLimit } from '../common/paging';
import {
  CORE_PROVISIONING_PORT,
  CoreProvisioningPort,
} from '../../../core-contracts/provisioning/tenant-provisioning.port';

@Injectable()
export class MarketingOffersService {
  constructor(
    private prisma: PrismaService,
    // Step E: snapshot plan display facts at offer-create via the port, so the
    // offer never reads SubscriptionPlan and stays valid after the FK is dropped.
    @Inject(CORE_PROVISIONING_PORT)
    private readonly provisioning: CoreProvisioningPort,
  ) {}

  async create(
    workspaceId: string,
    dto: CreateOfferDto,
    userId: string,
    userRole: string,
  ) {
    // Resolve the lead scoped first — the offer inherits the lead's
    // workspace, so a cross-workspace leadId must read as "not found".
    const lead = await this.prisma.lead.findFirst({
      where: { id: dto.leadId, workspaceId },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    // REP can only create offers for their own leads
    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only create offers for your own leads');
    }

    // Snapshot the plan's display facts via the port (no SubscriptionPlan read
    // from marketing). A missing/unknown planId snapshots nothing.
    const planSnapshot = dto.planId
      ? await this.provisioning.describePlan(dto.planId)
      : null;

    return this.prisma.leadOffer.create({
      data: {
        workspaceId,
        planId: dto.planId,
        planCode: planSnapshot?.planCode ?? null,
        planName: planSnapshot?.planName ?? null,
        planMonthlyPrice: planSnapshot?.monthlyPrice ?? null,
        planCurrency: planSnapshot?.currency ?? null,
        customPrice: dto.customPrice,
        discount: dto.discount,
        trialDays: dto.trialDays,
        notes: dto.notes,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : undefined,
        leadId: dto.leadId,
        createdById: userId,
      },
      include: {
        lead: { select: { id: true, businessName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async findAll(
    workspaceId: string,
    userId: string,
    userRole: string,
    page = 1,
    limit = 20,
    filter: { status?: string; dateFrom?: string; dateTo?: string } = {},
  ) {
    // The controller forwards the raw `?page`/`?limit` query (no transform), so
    // a non-numeric `?page=abc` would make `(page - 1) * limit` NaN and Prisma
    // throw a 500. Coerce to safe bounds so a bad param degrades to page 1.
    const p = safePage(page);
    const lim = safeLimit(limit, 20, 100);
    const skip = (p - 1) * lim;
    // REPs only see their own offers. The workspace clause is inlined at
    // each call site so the scoping fitness test can verify it statically.
    const repFilter = userRole === 'REP' ? { createdById: userId } : {};

    // Honour the list filters the Offers page sends — a status <Select> and a
    // from/to date range. These were previously dropped (the controller only
    // forwarded page/limit), so picking "SENT" or a date range silently
    // returned every offer. Date semantics mirror the leads list: filter on
    // createdAt, end date inclusive to end-of-day.
    const where: Prisma.LeadOfferWhereInput = { workspaceId, ...repFilter };
    if (filter.status) where.status = filter.status;
    if (filter.dateFrom || filter.dateTo) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (filter.dateFrom) createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo) createdAt.lte = rangeEndInclusive(filter.dateTo);
      where.createdAt = createdAt;
    }

    const [offers, total] = await Promise.all([
      this.prisma.leadOffer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: lim,
        include: {
          lead: { select: { id: true, businessName: true, contactPerson: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.leadOffer.count({ where }),
    ]);

    return {
      data: offers,
      meta: { total, page: p, limit: lim, totalPages: Math.ceil(total / lim) },
    };
  }

  async findOne(workspaceId: string, id: string, userId: string, userRole: string) {
    const offer = await this.prisma.leadOffer.findFirst({
      where: { id, workspaceId },
      include: {
        lead: {
          select: { id: true, businessName: true, contactPerson: true, email: true, phone: true },
        },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!offer) throw new NotFoundException('Offer not found');

    if (userRole === 'REP' && offer.createdById !== userId) {
      throw new ForbiddenException('You can only view your own offers');
    }

    return offer;
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateOfferDto,
    userId: string,
    userRole: string,
  ) {
    // Scoped pre-check; the id-keyed update below is safe once the offer
    // is known to live in the actor's workspace.
    const offer = await this.prisma.leadOffer.findFirst({
      where: { id, workspaceId },
    });

    if (!offer) throw new NotFoundException('Offer not found');

    if (userRole === 'REP' && offer.createdById !== userId) {
      throw new ForbiddenException('You can only update your own offers');
    }

    // Explicit allow-list (no `{ ...dto }` mass-assignment). `status` is
    // DELIBERATELY excluded: state transitions are owned by markSent()/
    // convert(), so a client-supplied status here must never leak into the
    // write and skip those guarded flows.
    const data: Prisma.LeadOfferUpdateInput = {
      ...(dto.planId !== undefined && { planId: dto.planId }),
      ...(dto.customPrice !== undefined && { customPrice: dto.customPrice }),
      ...(dto.discount !== undefined && { discount: dto.discount }),
      ...(dto.trialDays !== undefined && { trialDays: dto.trialDays }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.validUntil !== undefined && {
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      }),
    };

    return this.prisma.leadOffer.update({
      where: { id },
      data,
      include: {
        lead: { select: { id: true, businessName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async markSent(workspaceId: string, id: string, userId: string, userRole: string) {
    const offer = await this.prisma.leadOffer.findFirst({
      where: { id, workspaceId },
      include: { lead: { select: { status: true, convertedTenantId: true } } },
    });

    if (!offer) throw new NotFoundException('Offer not found');

    if (userRole === 'REP' && offer.createdById !== userId) {
      throw new ForbiddenException('You can only send your own offers');
    }
    if (offer.status !== 'DRAFT') {
      throw new BadRequestException('Only draft offers can be sent');
    }
    if (offer.lead.convertedTenantId || ['WON', 'LOST'].includes(offer.lead.status)) {
      throw new BadRequestException('Lead is already closed');
    }
    // Refuse to send an already-expired offer. The scheduler flips
    // SENT offers to EXPIRED past validUntil; if someone tries to
    // send a DRAFT whose validUntil is in the past, bail here instead
    // of producing a born-expired SENT row.
    if (offer.validUntil && offer.validUntil.getTime() < Date.now()) {
      throw new BadRequestException(
        'Offer validUntil is in the past — extend it before sending',
      );
    }

    const [updatedOffer] = await this.prisma.$transaction([
      this.prisma.leadOffer.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date() },
      }),
      // Advance the lead to OFFER_SENT atomically: a compound WHERE re-asserts
      // (inside the tx) that the lead is still open + unconverted, so a convert()
      // racing between the read above and this write can't be reverted WON→
      // OFFER_SENT. updateMany matches 0 rows (no-op) when the lead already moved.
      this.prisma.lead.updateMany({
        where: {
          id: offer.leadId,
          workspaceId,
          convertedTenantId: null,
          status: { notIn: ['OFFER_SENT', 'WAITING', 'WON', 'LOST'] },
        },
        data: { status: 'OFFER_SENT' },
      }),
    ]);

    return updatedOffer;
  }

  /**
   * Customer accepted the quote: SENT → ACCEPTED, and advance the lead
   * OFFER_SENT → WAITING (the "accepted, awaiting provisioning" state that
   * convert() consumes — convert allows OFFER_SENT/WAITING). The heavyweight
   * WON + tenant provisioning stays in convert(); this only records the
   * customer's decision. Same ownership/closed-lead guards as markSent.
   */
  async markAccepted(workspaceId: string, id: string, userId: string, userRole: string) {
    const offer = await this.prisma.leadOffer.findFirst({
      where: { id, workspaceId },
      include: { lead: { select: { status: true, convertedTenantId: true } } },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    if (userRole === 'REP' && offer.createdById !== userId) {
      throw new ForbiddenException('You can only accept your own offers');
    }
    if (offer.status !== 'SENT') {
      throw new BadRequestException('Only sent offers can be accepted');
    }
    if (offer.lead.convertedTenantId || ['WON', 'LOST'].includes(offer.lead.status)) {
      throw new BadRequestException('Lead is already closed');
    }

    const [updatedOffer] = await this.prisma.$transaction([
      this.prisma.leadOffer.update({
        where: { id },
        data: { status: 'ACCEPTED' },
      }),
      // Guarded compound WHERE mirrors markSent: advance ONLY from OFFER_SENT on
      // an unconverted lead, so a convert() racing to WON can't be reverted to
      // WAITING. updateMany matches 0 rows (no-op) when the lead already moved.
      this.prisma.lead.updateMany({
        where: {
          id: offer.leadId,
          workspaceId,
          convertedTenantId: null,
          status: 'OFFER_SENT',
        },
        data: { status: 'WAITING' },
      }),
    ]);

    return updatedOffer;
  }

  /**
   * Customer declined the quote: SENT → REJECTED. Offer-only — the lead's
   * pipeline status is the manager's call (re-quote, or mark LOST separately),
   * so rejection never moves the lead. Same ownership/status guards as accept.
   */
  async markRejected(workspaceId: string, id: string, userId: string, userRole: string) {
    const offer = await this.prisma.leadOffer.findFirst({ where: { id, workspaceId } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (userRole === 'REP' && offer.createdById !== userId) {
      throw new ForbiddenException('You can only reject your own offers');
    }
    if (offer.status !== 'SENT') {
      throw new BadRequestException('Only sent offers can be rejected');
    }
    return this.prisma.leadOffer.update({
      where: { id },
      data: { status: 'REJECTED' },
    });
  }

  async delete(workspaceId: string, id: string) {
    const offer = await this.prisma.leadOffer.findFirst({
      where: { id, workspaceId },
      include: { lead: { select: { convertedTenantId: true } } },
    });
    if (!offer) throw new NotFoundException('Offer not found');
    // An ACCEPTED offer is the attribution + plan basis of a converted deal —
    // deleting it would zero the conversion's revenue/attribution. Never delete
    // an accepted offer or any offer on a converted lead.
    if (offer.status === 'ACCEPTED' || offer.lead?.convertedTenantId) {
      throw new BadRequestException(
        'An accepted offer on a converted lead cannot be deleted',
      );
    }

    await this.prisma.leadOffer.delete({ where: { id } });
    return { message: 'Offer deleted successfully' };
  }
}
