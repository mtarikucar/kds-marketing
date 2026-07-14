import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateWorkspaceAdminDto } from '../dto/platform.dto';

/**
 * Operator-facing workspace administration. This is the one surface that
 * legitimately spans workspaces — it is guarded by the platform realm, not
 * the marketing one, and lives outside modules/marketing so the
 * workspace-scoping arch spec keeps its teeth there.
 */
@Injectable()
export class WorkspacesAdminService {
  constructor(private prisma: PrismaService) {}

  async list(filter: { status?: string; search?: string }) {
    const where: Prisma.WorkspaceWhereInput = {};
    if (filter.status) where.status = filter.status;
    if (filter.search) {
      where.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { slug: { contains: filter.search, mode: 'insensitive' } },
        { productName: { contains: filter.search, mode: 'insensitive' } },
      ];
    }

    const workspaces = await this.prisma.workspace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Per-workspace headline counts in two grouped queries instead of 2N.
    const ids = workspaces.map((w) => w.id);
    const [userCounts, leadCounts] = await Promise.all([
      this.prisma.marketingUser.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids }, role: { not: 'SYSTEM' } },
        _count: { _all: true },
      }),
      this.prisma.lead.groupBy({
        by: ['workspaceId'],
        where: { workspaceId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const usersBy = new Map(userCounts.map((c) => [c.workspaceId, c._count._all]));
    const leadsBy = new Map(leadCounts.map((c) => [c.workspaceId, c._count._all]));

    return workspaces.map((w) => ({
      ...w,
      counts: {
        users: usersBy.get(w.id) ?? 0,
        leads: leadsBy.get(w.id) ?? 0,
      },
    }));
  }

  async findOne(id: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const [users, leads, openLeads, wonLeads] = await Promise.all([
      this.prisma.marketingUser.count({
        where: { workspaceId: id, role: { not: 'SYSTEM' } },
      }),
      this.prisma.lead.count({ where: { workspaceId: id } }),
      this.prisma.lead.count({
        where: { workspaceId: id, status: { notIn: ['WON', 'LOST'] } },
      }),
      this.prisma.lead.count({ where: { workspaceId: id, status: 'WON' } }),
    ]);

    const owner = await this.prisma.marketingUser.findFirst({
      where: { workspaceId: id, role: 'OWNER' },
      select: { id: true, email: true, firstName: true, lastName: true, lastLogin: true },
    });

    return { ...workspace, owner, counts: { users, leads, openLeads, wonLeads } };
  }

  async updateStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') {
    const existing = await this.prisma.workspace.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Workspace not found');

    return this.prisma.workspace.update({
      where: { id },
      data: { status },
      select: { id: true, slug: true, name: true, status: true },
    });
  }

  async update(id: string, dto: UpdateWorkspaceAdminDto) {
    const existing = await this.prisma.workspace.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Workspace not found');

    // Demoting an AGENCY back to STANDALONE would strand its child LOCATIONs — the
    // agency console that manages them (and the switch-into-sub-account flow) would
    // vanish, leaving the sub-accounts orphaned and unreachable. Refuse while any
    // remain. (Promoting STANDALONE→AGENCY is always safe.)
    if (dto.kind === 'STANDALONE') {
      const children = await this.prisma.workspace.count({
        where: { parentWorkspaceId: id, kind: 'LOCATION' },
      });
      if (children > 0) {
        throw new BadRequestException('Move or remove the sub-accounts before demoting this agency');
      }
    }

    const { coreIntegration, settings, ...scalar } = dto;
    return this.prisma.workspace.update({
      where: { id },
      data: {
        ...scalar,
        ...(settings !== undefined
          ? { settings: settings as Prisma.InputJsonValue }
          : {}),
        ...(coreIntegration !== undefined
          ? {
              coreIntegration:
                coreIntegration === null
                  ? Prisma.DbNull
                  : (coreIntegration as Prisma.InputJsonValue),
            }
          : {}),
      },
    });
  }
}
