/**
 * Put the platform-owner workspace on the internal OPERATOR package.
 * Idempotent — runs on every deploy, right after seed-packages.ts:
 *
 *   OPERATOR_WORKSPACE_ID=<workspace uuid> \
 *   npx ts-node prisma/seed-operator-workspace.ts
 *
 * OPERATOR (`isPublic: false`, everything -1/true) exists in the catalog but
 * nothing else in the codebase can grant it: the only WorkspaceSubscription
 * writers are PSP settlement (real payment), agency sub-account provisioning,
 * registration (TRIAL) and the expiry scheduler. This script — and the
 * operator console's PATCH /platform/workspaces/:id/subscription, which shares
 * the same helper — are the two ways in.
 *
 * Env contract: OPERATOR_WORKSPACE_ID unset/blank = NO-OP, exit 0. It is safe
 * to run in every environment. A set-but-wrong id is an error (exit 1); the
 * compose command wraps it in `|| echo … continuing`, so a bad id is loud in
 * the logs without blocking boot.
 */
import { PrismaClient } from '@prisma/client';
import {
  assignPackageToWorkspace,
  OPERATOR_PACKAGE_CODE,
  type PackageAssignmentClient,
} from '../src/modules/billing/package-assignment';

export type SeedOutcome = 'skipped' | 'assigned' | 'unchanged';

interface SeedLogger {
  log: (message: string) => void;
  error: (message: string) => void;
}

export async function seedOperatorWorkspace(
  prisma: PackageAssignmentClient,
  env: Record<string, string | undefined> = process.env,
  logger: SeedLogger = console,
): Promise<SeedOutcome> {
  const workspaceId = (env.OPERATOR_WORKSPACE_ID ?? '').trim();
  if (!workspaceId) {
    logger.log(
      'OPERATOR_WORKSPACE_ID not set — skipping the operator package grant.',
    );
    return 'skipped';
  }

  const result = await assignPackageToWorkspace(
    prisma,
    workspaceId,
    OPERATOR_PACKAGE_CODE,
  );

  logger.log(
    result.changed
      ? `workspace ${workspaceId} granted package ${result.packageCode} (ACTIVE until ${result.currentPeriodEnd.toISOString()})`
      : `workspace ${workspaceId} already on package ${result.packageCode} — no change`,
  );
  return result.changed ? 'assigned' : 'unchanged';
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedOperatorWorkspace(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
