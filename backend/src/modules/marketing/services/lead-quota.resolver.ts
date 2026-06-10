import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Resolves a workspace's daily lead quota (-1 = unlimited).
 *
 * Phase-F seam: this is THE point the entitlement engine replaces — packages
 * and add-on boosts will fold into one effective number here. Until then the
 * quota lives in Workspace.settings.dailyLeadQuota (operator-set via the
 * platform panel) with a conservative default for fresh signups.
 */
@Injectable()
export class LeadQuotaResolver {
  /** Trial-ish default until packages land (Phase F). */
  static readonly DEFAULT_DAILY_LEAD_QUOTA = 10;

  constructor(private readonly prisma: PrismaService) {}

  async getDailyLeadQuota(workspaceId: string): Promise<number> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true, settings: true },
    });
    // Non-active workspaces ingest nothing — same posture the auth layer
    // takes at login, mirrored here because ingest never sees a user token.
    if (!workspace || workspace.status !== 'ACTIVE') return 0;

    const raw = (workspace.settings as Record<string, unknown> | null)
      ?.dailyLeadQuota;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= -1) {
      return raw;
    }
    return LeadQuotaResolver.DEFAULT_DAILY_LEAD_QUOTA;
  }
}
