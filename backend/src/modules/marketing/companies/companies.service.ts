import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface CreateCompanyInput {
  name: string;
  domain?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  notes?: string;
  customFields?: Record<string, unknown>;
}
export interface UpdateCompanyInput extends Partial<CreateCompanyInput> {
  archived?: boolean;
}

/**
 * Companies / B2B accounts (GoHighLevel parity). A company groups contacts
 * (Lead.companyId) and rolls up their opportunities + conversations. Pure code,
 * no FK — soft `workspaceId` scoping like the rest of CRM; deleting a company
 * detaches (nulls companyId on) its contacts rather than orphaning them.
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, opts: { search?: string; includeArchived?: boolean } = {}) {
    const companies = await this.prisma.company.findMany({
      where: {
        workspaceId,
        ...(opts.includeArchived ? {} : { archived: false }),
        ...(opts.search ? { name: { contains: opts.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
    });
    if (companies.length === 0) return [];
    // One grouped read for the contact counts (companyId is non-null here).
    const counts = await this.prisma.lead.groupBy({
      by: ['companyId'],
      where: { workspaceId, companyId: { in: companies.map((c) => c.id) } },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.companyId, c._count._all]));
    return companies.map((c) => ({ ...c, contactCount: countMap.get(c.id) ?? 0 }));
  }

  async get(workspaceId: string, id: string) {
    const company = await this.prisma.company.findFirst({ where: { id, workspaceId } });
    if (!company) throw new NotFoundException('Company not found');
    return { ...company, ...(await this.rollup(workspaceId, id)) };
  }

  /** Aggregate the company's contacts' open opportunities + conversation count. */
  private async rollup(workspaceId: string, companyId: string) {
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, companyId },
      select: { id: true },
    });
    const leadIds = leads.map((l) => l.id);
    if (leadIds.length === 0) {
      return { contactCount: 0, openOpportunities: 0, openValue: 0, conversationCount: 0 };
    }
    const [oppAgg, convCount] = await Promise.all([
      this.prisma.opportunity.aggregate({
        where: { workspaceId, leadId: { in: leadIds }, status: 'OPEN' },
        _count: { _all: true },
        _sum: { value: true },
      }),
      this.prisma.conversation.count({ where: { workspaceId, leadId: { in: leadIds } } }),
    ]);
    return {
      contactCount: leadIds.length,
      openOpportunities: oppAgg._count._all,
      openValue: Math.round(Number(oppAgg._sum.value ?? 0) * 100) / 100,
      conversationCount: convCount,
    };
  }

  /** The contacts linked to a company (lightweight rows for the detail view). */
  async listContacts(workspaceId: string, companyId: string) {
    return this.prisma.lead.findMany({
      where: { workspaceId, companyId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, businessName: true, contactPerson: true, email: true, phone: true, status: true, createdAt: true },
    });
  }

  async create(workspaceId: string, dto: CreateCompanyInput) {
    return this.prisma.company.create({
      data: {
        workspaceId,
        name: dto.name,
        domain: dto.domain ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        address: dto.address ?? null,
        city: dto.city ?? null,
        notes: dto.notes ?? null,
        customFields: (dto.customFields ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateCompanyInput) {
    const data: Prisma.CompanyUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.domain !== undefined) data.domain = dto.domain;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.city !== undefined) data.city = dto.city;
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.archived !== undefined) data.archived = dto.archived;
    if (dto.customFields !== undefined) data.customFields = dto.customFields as Prisma.InputJsonValue;
    const res = await this.prisma.company.updateMany({ where: { id, workspaceId }, data });
    if (res.count === 0) throw new NotFoundException('Company not found');
    const company = await this.prisma.company.findFirst({ where: { id, workspaceId } });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  /** Delete a company — detach its contacts (null companyId) so none are orphaned. */
  async remove(workspaceId: string, id: string) {
    const exists = await this.prisma.company.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Company not found');
    await this.prisma.$transaction([
      this.prisma.lead.updateMany({ where: { workspaceId, companyId: id }, data: { companyId: null } }),
      this.prisma.company.deleteMany({ where: { id, workspaceId } }),
    ]);
    return { message: 'Company deleted' };
  }
}
