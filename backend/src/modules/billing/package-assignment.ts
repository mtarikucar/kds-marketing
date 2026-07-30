import type { PrismaClient } from '@prisma/client';

/**
 * Internal (non-PSP) package assignment — the one code path that puts a
 * workspace on a package without a payment. Shared by:
 *
 *   - `prisma/seed-operator-workspace.ts` (deploy-time bootstrap, env-driven)
 *   - `PATCH /platform/workspaces/:id/subscription` (operator console)
 *
 * Deliberately Nest-free (plain functions + plain errors): the seed script is
 * compiled standalone into dist-seed/ and runs in the production image with
 * `node`, so it must not drag the framework in. The controller layer maps the
 * two error types below onto 404/400.
 */

/** The internal, unlimited, `isPublic: false` package (see seed-packages.ts). */
export const OPERATOR_PACKAGE_CODE = 'OPERATOR';

/**
 * Period end written for every internally-granted subscription.
 *
 * WHY the year 2999: BillingSchedulerService.sweepLifecycle() runs hourly and
 * flips every `status: 'ACTIVE'` row whose `currentPeriodEnd < now` to
 * PAST_DUE, then to EXPIRED 7 days later — at which point
 * EntitlementsService.compute() returns zeroEntitlements and the workspace
 * goes dark. WorkspaceSubscription has no "never expires" flag, so the only
 * representation of a perpetual internal grant is a period end that never
 * arrives. Combined with `status: 'ACTIVE'` (not TRIALING) and
 * `trialEndsAt: null`, none of the sweep's three branches can ever match the
 * row, and the read-side "TRIALING past trialEndsAt → zero" belt can't either.
 */
export const INTERNAL_GRANT_PERIOD_END = new Date('2999-12-31T00:00:00.000Z');

/** Marks the subscription as not owned by any PSP (schema: paytr|stripe|manual). */
const INTERNAL_GRANT_PROVIDER = 'manual';

/**
 * The Prisma surface this needs. Both PrismaService (Nest) and a bare
 * `new PrismaClient()` (the seed script) satisfy it.
 */
export type PackageAssignmentClient = Pick<
  PrismaClient,
  'workspace' | 'package' | 'workspaceSubscription'
>;

export class WorkspaceNotFoundError extends Error {
  readonly name = 'WorkspaceNotFoundError';
  constructor(readonly workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
  }
}

export class UnknownPackageCodeError extends Error {
  readonly name = 'UnknownPackageCodeError';
  constructor(
    readonly code: string,
    readonly validCodes: string[],
  ) {
    super(
      `Unknown package code "${code}". Valid codes: ${validCodes.join(', ')}`,
    );
  }
}

export interface PackageAssignmentResult {
  workspaceId: string;
  packageCode: string;
  packageName: string;
  status: 'ACTIVE';
  /** false = the workspace was already on exactly this grant (idempotent re-run). */
  changed: boolean;
  currentPeriodEnd: Date;
  trialEndsAt: null;
  /** Plan quotas + the package `limits` JSON, folded into one summary (-1 = unlimited). */
  limits: Record<string, number>;
}

/**
 * Puts `workspaceId` on the package with `packageCode`, idempotently.
 *
 * Re-running with the same code is a no-op: the row is only written when it
 * actually differs from the target grant, so a deploy-time seed doesn't churn
 * `updatedAt`/`currentPeriodStart` on every boot.
 */
export async function assignPackageToWorkspace(
  prisma: PackageAssignmentClient,
  workspaceId: string,
  packageCode: string,
): Promise<PackageAssignmentResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, defaultCurrency: true },
  });
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

  const pkg = await prisma.package.findUnique({ where: { code: packageCode } });
  if (!pkg) {
    const all = await prisma.package.findMany({
      select: { code: true },
      orderBy: { sortOrder: 'asc' },
    });
    throw new UnknownPackageCodeError(
      packageCode,
      all.map((p) => p.code),
    );
  }

  const existing = await prisma.workspaceSubscription.findUnique({
    where: { workspaceId },
  });

  const alreadyGranted =
    !!existing &&
    existing.packageId === pkg.id &&
    existing.status === 'ACTIVE' &&
    existing.trialEndsAt === null &&
    existing.cancelAtPeriodEnd === false &&
    existing.currentPeriodEnd?.getTime() ===
      INTERNAL_GRANT_PERIOD_END.getTime();

  if (!alreadyGranted) {
    // Subscription.currency is TRY|USD; a workspace may default to EUR.
    const currency = workspace.defaultCurrency === 'TRY' ? 'TRY' : 'USD';
    const now = new Date();
    const grant = {
      packageId: pkg.id,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currency,
      currentPeriodStart: now,
      currentPeriodEnd: INTERNAL_GRANT_PERIOD_END,
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      provider: INTERNAL_GRANT_PROVIDER,
      // No PSP reference: leaving this null keeps the row out of
      // extendSubscriptionByProviderRef's findFirst lookups entirely.
      providerRef: null,
    };
    await prisma.workspaceSubscription.upsert({
      where: { workspaceId },
      create: { workspaceId, ...grant },
      update: grant,
    });
  }

  return {
    workspaceId,
    packageCode: pkg.code,
    packageName: pkg.name,
    status: 'ACTIVE',
    changed: !alreadyGranted,
    currentPeriodEnd: INTERNAL_GRANT_PERIOD_END,
    trialEndsAt: null,
    limits: {
      dailyLeadQuota: pkg.dailyLeadQuota,
      maxUsers: pkg.maxUsers,
      maxResearchProfiles: pkg.maxResearchProfiles,
      ...((pkg.limits ?? {}) as Record<string, number>),
    },
  };
}
