import { Prisma, PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'workspace'>;

/**
 * Resolve the single workspace wired to a core product deployment
 * (Workspace.coreIntegration != null). Core-originated events
 * (payment.succeeded → commissions, hardware quotes) carry core tenant ids,
 * not workspace ids — they all belong to this one workspace by definition.
 * Returns null on a generic deployment with no core integration; callers
 * log and skip. If several workspaces ever claim a core integration the
 * oldest wins deterministically — ops keeps this at most one.
 */
export async function findCoreIntegratedWorkspaceId(
  db: Db,
): Promise<string | null> {
  const ws = await db.workspace.findFirst({
    where: {
      status: 'ACTIVE',
      NOT: { coreIntegration: { equals: Prisma.DbNull } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return ws?.id ?? null;
}
