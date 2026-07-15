import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MembershipSummary } from '../types';

/**
 * The membership lifecycle + authorization-resolution seam. A MarketingUser
 * identity holds N WorkspaceMemberships; the active one supplies the request's
 * role. Reads keyed by `userId` are intentionally cross-workspace (a user spans
 * workspaces) and are exempt in the workspace-scoping fitness test.
 */
@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /** The ACTIVE membership binding a user to a workspace, or null. */
  getActiveMembership(userId: string, workspaceId: string) {
    return this.prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId, status: 'ACTIVE' },
      select: { id: true, workspaceId: true, role: true, customRoleId: true },
    });
  }

  /** Every ACTIVE membership the user holds, joined to workspace display names. */
  async listActiveMemberships(userId: string): Promise<MembershipSummary[]> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { workspaceId: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!memberships.length) return [];
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: memberships.map((m) => m.workspaceId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(workspaces.map((w) => [w.id, w.name]));
    return memberships.map((m) => ({
      workspaceId: m.workspaceId,
      workspaceName: nameById.get(m.workspaceId) ?? m.workspaceId,
      role: m.role,
    }));
  }

  /**
   * Which workspace a login lands in: the user's home pointer if they still hold
   * an ACTIVE membership for it, else their most-recently-created ACTIVE
   * membership, else null (no active membership → login should be refused).
   */
  async resolveDefaultWorkspaceId(userId: string, homeWorkspaceId: string): Promise<string | null> {
    const home = await this.prisma.workspaceMembership.findFirst({
      where: { userId, workspaceId: homeWorkspaceId, status: 'ACTIVE' },
      select: { workspaceId: true },
    });
    if (home) return home.workspaceId;
    const fallback = await this.prisma.workspaceMembership.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { workspaceId: true },
    });
    return fallback?.workspaceId ?? null;
  }
}
