import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';

/**
 * Resolves a workspace's daily lead quota (-1 = unlimited).
 *
 * Phase F: the answer comes from the entitlement engine (package + add-on
 * boosts). This thin adapter stays so the ingest path keeps one stable
 * dependency, plus the workspace-status floor: a SUSPENDED/CLOSED workspace
 * ingests nothing regardless of what its subscription would grant —
 * mirroring the login-time gate for a path that never sees a user token.
 */
@Injectable()
export class LeadQuotaResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getDailyLeadQuota(workspaceId: string): Promise<number> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') return 0;

    const effective = await this.entitlements.getEffective(workspaceId);
    return effective.dailyLeadQuota;
  }
}
