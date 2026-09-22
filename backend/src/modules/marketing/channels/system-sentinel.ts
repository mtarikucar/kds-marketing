import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * "Which user does the system write as?"
 *
 * Every row that records something the PRODUCT did rather than something a
 * person did still needs an author: `LeadActivity.createdById` is NOT NULL and
 * `onDelete: Restrict`. Each workspace is provisioned with a `MarketingUser`
 * whose role is `SYSTEM` for exactly that, and the lookup used to live
 * privately inside `ConversationIngressService` — so the second writer that
 * needed it (the mail trace) would have had to grow its own copy, with its own
 * cache and its own answer to the null.
 *
 * The null matters. A workspace that was provisioned before the sentinel
 * existed, or one still mid-provision, has none. The right behaviour there is
 * to SKIP the row and warn: the alternative — inventing an id, or throwing —
 * either violates the foreign key or turns a bookkeeping failure into a failed
 * mail, and a throw after a dispatch would retry a message that already reached
 * the customer (PLAN G2).
 */
@Injectable()
export class SystemSentinelService {
  private readonly logger = new Logger(SystemSentinelService.name);
  private readonly cache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /** The workspace's SYSTEM user id, or null when it has none. Never throws. */
  async resolve(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    try {
      const row = await this.prisma.marketingUser.findFirst({
        where: { workspaceId, role: 'SYSTEM' },
        select: { id: true },
      });
      const id = row?.id ?? null;
      // Cache only a RESOLVED id, never a miss. A cached null would disable the
      // trace for the whole process lifetime for any workspace whose SYSTEM
      // user was created after its first send — a new or backfilled tenant.
      if (id) this.cache.set(workspaceId, id);
      return id;
    } catch (e: any) {
      this.logger.warn(`SYSTEM sentinel lookup failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }
}
