import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MembershipSummary } from '../types';
import { InviteMemberDto } from '../dto/invite-member.dto';

const INVITABLE_ROLES = ['MANAGER', 'REP'];

/** Base64url, no padding — mirrors sso.service.ts's local helper. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * The membership lifecycle + authorization-resolution seam. A MarketingUser
 * identity holds N WorkspaceMemberships; the active one supplies the request's
 * role. Reads keyed by `userId` are intentionally cross-workspace (a user spans
 * workspaces) and are exempt in the workspace-scoping fitness test.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

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

  /**
   * Phase 2 Task 11 — an admin invites someone (by email) into their
   * workspace as MANAGER/REP:
   *  - an existing MarketingUser identity gets a new INVITED membership for
   *    THIS workspace (they already have a login; they accept in-app);
   *  - a brand-new email gets a pending identity (unusable password — the
   *    MEMBERSHIP is what's INVITED, not the identity) + an INVITED
   *    membership + a signed accept token (Task 12 verifies it).
   * All three paths run in ONE $transaction so the identity-create (when
   * needed) and the membership-create commit atomically. A P2002 raised by
   * either the MarketingUser.email unique or the (userId, workspaceId)
   * membership unique (a concurrent duplicate invite) maps to the same 409
   * the pre-check throws.
   */
  async invite(
    workspaceId: string,
    actorUserId: string,
    dto: InviteMemberDto,
  ): Promise<{ membershipId: string; status: 'INVITED'; inviteToken?: string }> {
    if (!INVITABLE_ROLES.includes(dto.role)) {
      // OWNER exists once per workspace; SYSTEM is the research sentinel —
      // neither is invitable, mirroring marketing-users.service.create.
      throw new BadRequestException('Role must be MANAGER or REP');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.marketingUser.findUnique({
          where: { email: dto.email },
        });

        if (existing) {
          const dup = await tx.workspaceMembership.findFirst({
            where: { userId: existing.id, workspaceId, status: { in: ['ACTIVE', 'INVITED'] } },
            select: { id: true },
          });
          if (dup) {
            throw new ConflictException('This user is already a member or invited');
          }

          const membership = await tx.workspaceMembership.create({
            data: {
              userId: existing.id,
              workspaceId,
              role: dto.role,
              customRoleId: dto.customRoleId ?? null,
              status: 'INVITED',
              invitedByUserId: actorUserId,
            },
            select: { id: true },
          });
          return { membershipId: membership.id, status: 'INVITED' as const };
        }

        // New email: provision a pending identity. No password is usable —
        // store a random sealed-strength sentinel (same shape as
        // sso.service.ts's JIT provisioning) so the password-login path can
        // never authenticate this row until the invite is accepted.
        const pending = await tx.marketingUser.create({
          data: {
            workspaceId,
            email: dto.email,
            password: b64url(randomBytes(48)),
            firstName: dto.email.split('@')[0],
            lastName: '',
            role: dto.role,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        const membership = await tx.workspaceMembership.create({
          data: {
            userId: pending.id,
            workspaceId,
            role: dto.role,
            customRoleId: dto.customRoleId ?? null,
            status: 'INVITED',
            invitedByUserId: actorUserId,
          },
          select: { id: true },
        });

        // `typ` (not `type`) is deliberate: MarketingGuard only ever accepts
        // `type === 'marketing'`, so this token can NEVER be replayed as a
        // session — it is only ever verifiable by the accept endpoint (Task 12).
        const inviteToken = this.jwt.sign(
          { membershipId: membership.id, typ: 'marketing-invite' },
          {
            secret: this.config.get<string>('MARKETING_JWT_SECRET'),
            expiresIn: '7d',
            algorithm: 'HS256',
          },
        );

        return { membershipId: membership.id, status: 'INVITED' as const, inviteToken };
      });
    } catch (e) {
      // Lost a concurrent race on either unique index (email, or the
      // (userId, workspaceId) membership pair) — clean 409, not a raw 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This user is already a member or invited');
      }
      throw e;
    }
  }
}
