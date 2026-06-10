import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class MarketingDistributionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One row per workspace (`workspaceId` is unique). A workspace that has
   * never saved a config has no row yet — that reads as the DISABLED
   * default rather than an error, mirroring the auto-assigner's "missing
   * row means manual assignment" semantics. Returns the config plus a
   * hydrated `lastAssignedTo` name so the UI can show
   * "last assigned: Ahmet Y."
   */
  async get(workspaceId: string) {
    const cfg = await this.prisma.marketingDistributionConfig.findFirst({
      where: { workspaceId },
    });
    if (!cfg) {
      return {
        id: null,
        workspaceId,
        strategy: 'DISABLED',
        lastAssignedToId: null,
        updatedById: null,
        updatedAt: null,
        lastAssignedTo: null,
      };
    }
    const lastAssignedTo = cfg.lastAssignedToId
      ? await this.prisma.marketingUser.findFirst({
          where: { id: cfg.lastAssignedToId, workspaceId },
          select: { id: true, firstName: true, lastName: true },
        })
      : null;
    return { ...cfg, lastAssignedTo };
  }

  async update(workspaceId: string, strategy: string, actorId: string) {
    const cfg = await this.prisma.marketingDistributionConfig.findFirst({
      where: { workspaceId },
    });
    // Switching strategy resets the round-robin cursor so the next
    // assignment starts cleanly from the top — otherwise switching
    // away and back would skip ahead in the rep list silently.
    const resetCursor = !!cfg && strategy !== cfg.strategy;
    return this.prisma.marketingDistributionConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, strategy, updatedById: actorId },
      update: {
        strategy,
        updatedById: actorId,
        ...(resetCursor ? { lastAssignedToId: null } : {}),
      },
    });
  }
}
