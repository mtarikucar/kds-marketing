import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateWorkspaceAdminDto } from '../dto/platform.dto';
import { EntitlementsService } from '../../billing/entitlements.service';
import {
  assignPackageToWorkspace,
  PackageAssignmentResult,
  UnknownPackageCodeError,
  WorkspaceNotFoundError,
} from '../../billing/package-assignment';

/**
 * Operator-facing workspace administration. This is the one surface that
 * legitimately spans workspaces — it is guarded by the platform realm, not
 * the marketing one, and lives outside modules/marketing so the
 * workspace-scoping arch spec keeps its teeth there.
 */
@Injectable()
export class WorkspacesAdminService {
  constructor(
    private prisma: PrismaService,
    private entitlements: EntitlementsService,
  ) {}

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

    const [users, leads, openLeads, wonLeads, locationCount] = await Promise.all([
      this.prisma.marketingUser.count({
        where: { workspaceId: id, role: { not: 'SYSTEM' } },
      }),
      this.prisma.lead.count({ where: { workspaceId: id } }),
      this.prisma.lead.count({
        where: { workspaceId: id, status: { notIn: ['WON', 'LOST'] } },
      }),
      this.prisma.lead.count({ where: { workspaceId: id, status: 'WON' } }),
      // Child sub-accounts — lets the admin UI show "N sub-accounts" and pre-empt
      // the demote orphan-guard (an AGENCY with children can't revert to STANDALONE).
      this.prisma.workspace.count({ where: { parentWorkspaceId: id, kind: 'LOCATION' } }),
    ]);

    const owner = await this.prisma.marketingUser.findFirst({
      where: { workspaceId: id, role: 'OWNER' },
      select: { id: true, email: true, firstName: true, lastName: true, lastLogin: true },
    });

    // Current package/subscription, so the console can show what a workspace is
    // on before an operator changes it. WorkspaceSubscription→Package is a soft
    // ref (no Prisma relation), hydrated in a second query like the payments
    // queue does. Null when the workspace has never been subscribed.
    const subscription = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId: id },
      select: {
        status: true,
        billingCycle: true,
        currency: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        trialEndsAt: true,
        provider: true,
        packageId: true,
      },
    });
    const pkg = subscription
      ? await this.prisma.package.findUnique({
          where: { id: subscription.packageId },
          select: { code: true, name: true, isPublic: true },
        })
      : null;

    return {
      ...workspace,
      owner,
      counts: { users, leads, openLeads, wonLeads },
      locationCount,
      subscription: subscription
        ? { ...subscription, package: pkg }
        : null,
    };
  }

  async updateStatus(id: string, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') {
    const existing = await this.prisma.workspace.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Workspace not found');

    const updated = await this.prisma.workspace.update({
      where: { id },
      data: { status },
      select: { id: true, slug: true, name: true, status: true },
    });

    if (status !== 'ACTIVE') {
      // Suspend/close must take effect NOW, not at token expiry: login and
      // refresh check workspace status (assertWorkspaceActive), but an
      // in-flight ACCESS token would otherwise keep full tenant access for up
      // to 8h — contradicting the operator UI's "users will lose access".
      // Bumping tokenVersion invalidates every outstanding access token on the
      // next request (the guard's ver check), and refresh is already blocked
      // by the workspace-status gate.
      await this.prisma.marketingUser.updateMany({
        where: { workspaceId: id },
        data: { tokenVersion: { increment: 1 } },
      });
    }

    // The outbound floor (MessageQuotaService.reserve) reads the status
    // through the 30s entitlement cache, so without this a suspension takes up
    // to half a minute to stop the tenant's mail — and a REACTIVATION takes up
    // to half a minute to release it, which is the operator pressing a button
    // and watching nothing happen. Both directions, on purpose
    // (`suspension-doesnt-stop`).
    this.entitlements.invalidate(id);

    return updated;
  }

  /**
   * Stop (or resume) this tenant's outbound mail without suspending the whole
   * workspace.
   *
   * When the shared relay throttles, suspending the tenant is a sledgehammer:
   * it revokes every login too. `settings.email.paused` is the narrow lever —
   * the console keeps working, the mail stops. The gate
   * (`MailGuardService`) and the campaign sender both already read this flag;
   * this is the only thing that writes it (`no-per-tenant-control`).
   *
   * Resuming DELETES the key rather than writing `false`, so a workspace that
   * was paused once and released is indistinguishable from one that was never
   * touched — nothing has to know that `false` and absent mean the same thing.
   */
  async setEmailSendingPaused(id: string, paused: boolean) {
    const existing = await this.prisma.workspace.findUnique({
      where: { id },
      select: { id: true, settings: true },
    });
    if (!existing) throw new NotFoundException('Workspace not found');

    // Spread-first merge: an operator toggling mail must not drop the İYS
    // credentials, the reply-to or anything else a tenant has set.
    const settings =
      existing.settings && typeof existing.settings === 'object' && !Array.isArray(existing.settings)
        ? { ...(existing.settings as Record<string, unknown>) }
        : {};
    const email =
      settings.email && typeof settings.email === 'object' && !Array.isArray(settings.email)
        ? { ...(settings.email as Record<string, unknown>) }
        : {};
    if (paused) email.paused = true;
    else delete email.paused;
    // An `email` block that now holds nothing goes away with the flag, so a
    // released workspace's settings look exactly like an untouched one's.
    if (Object.keys(email).length) settings.email = email;
    else delete settings.email;

    return this.prisma.workspace.update({
      where: { id },
      data: { settings: settings as Prisma.InputJsonValue },
      select: { id: true, settings: true },
    });
  }

  /**
   * Put a workspace on a package WITHOUT a payment — the operator-side twin of
   * PSP settlement. Shares `assignPackageToWorkspace` with the deploy-time
   * seed (prisma/seed-operator-workspace.ts) so both write byte-identical
   * subscription rows; this method only adds the HTTP error mapping and the
   * entitlement-cache invalidation.
   *
   * This is the only surface that can hand out the internal OPERATOR package,
   * and it lives behind PlatformGuard on purpose — no customer-facing route
   * may ever reach it (OPERATOR is isPublic:false and unmetered).
   */
  async assignPackage(
    id: string,
    packageCode: string,
  ): Promise<PackageAssignmentResult> {
    try {
      const result = await assignPackageToWorkspace(this.prisma, id, packageCode);
      // The effective-entitlement cache holds for 30s; a grant the operator
      // just made must be visible on the very next request.
      this.entitlements.invalidate(id);
      return result;
    } catch (e) {
      if (e instanceof WorkspaceNotFoundError) {
        throw new NotFoundException('Workspace not found');
      }
      if (e instanceof UnknownPackageCodeError) {
        throw new BadRequestException(e.message);
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateWorkspaceAdminDto) {
    const existing = await this.prisma.workspace.findUnique({
      where: { id },
      select: { id: true, kind: true },
    });
    if (!existing) throw new NotFoundException('Workspace not found');

    // A LOCATION sub-account's tier is managed by its parent agency's
    // lifecycle, not this dial: flipping it to AGENCY/STANDALONE here would
    // detach it from every kind='LOCATION'-scoped agency query while its
    // parentWorkspaceId keeps dangling.
    if (dto.kind !== undefined && existing.kind === 'LOCATION') {
      throw new BadRequestException(
        'Sub-accounts cannot change tier here — detach the location from its agency first',
      );
    }

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
