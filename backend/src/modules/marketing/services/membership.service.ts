import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
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

    if (dto.customRoleId) {
      // Mirrors RolesService.owned(): a workspace-scoped lookup guarantees a
      // stale or cross-workspace customRoleId can never be persisted onto a
      // new membership (would silently produce a permission-less invitee).
      const role = await this.prisma.customRole.findFirst({
        where: { id: dto.customRoleId, workspaceId },
        select: { id: true },
      });
      if (!role) throw new BadRequestException('Custom role not found in this workspace');
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

  /**
   * Phase 2 Task 12 — decode+validate an invite token minted by invite()
   * above down to its membershipId. Lives next to invite() since this is the
   * only place that knows the token's shape: `typ` (not `type`), so it can
   * NEVER be verified as a marketing SESSION (MarketingGuard only ever
   * accepts `type === 'marketing'`) — it is only ever meaningful here.
   */
  async verifyInviteToken(token: string): Promise<string> {
    let payload: { membershipId?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('MARKETING_JWT_SECRET'),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid invite token');
    }
    if (payload.typ !== 'marketing-invite' || !payload.membershipId) {
      throw new UnauthorizedException('Invalid invite token');
    }
    return payload.membershipId;
  }

  /**
   * Phase 2 Task 12 — flip an INVITED membership to ACTIVE. Two callers:
   *  - the public token-accept route (`opts.userId` absent) — the invite
   *    TOKEN itself (verified above) is the caller's only credential;
   *  - the logged-in accept route (`opts.userId` = the caller's own id) —
   *    accepts a second-workspace invite while already signed in elsewhere.
   *    `opts.userId` must match the membership's OWN userId, or this is
   *    someone else's invite (403).
   *
   * The claim is an atomic `updateMany` gated on `status: 'INVITED'` (plus a
   * literal `workspaceId`, satisfying the workspace-scoping fitness test even
   * though the id alone is already unique) so a concurrent double-accept —
   * two tabs, or a retried request — can only ever flip the row once; the
   * loser sees a clean 409 rather than a silent no-op.
   *
   * A brand-new invited identity (Task 11's pending MarketingUser: an
   * unusable random sentinel, NOT a bcrypt hash — a real hash is always 60
   * chars) must set its real password HERE, in the same accept step, inside
   * the SAME transaction as the claim so a rolled-back claim never leaves a
   * stray password change behind. An identity that already has a real
   * password (an existing user invited into a second workspace) never has
   * its password touched, even if `opts.password` is sent — the logged-in
   * accept path never sends one at all.
   */
  async accept(
    membershipId: string,
    opts: { userId?: string; password?: string } = {},
  ): Promise<{ status: 'ACTIVE'; workspaceId: string }> {
    const membership = await this.prisma.workspaceMembership.findUnique({
      where: { id: membershipId },
      include: { user: { select: { id: true, password: true } } },
    });
    if (!membership) {
      throw new NotFoundException('Invite not found');
    }

    if (opts.userId && membership.userId !== opts.userId) {
      throw new ForbiddenException('This invite belongs to a different account');
    }

    // A real bcrypt hash is always exactly 60 chars; the pending-identity
    // sentinel invite() stores (b64url of 48 random bytes) never is — that
    // length check is the whole distinction between "brand-new invited
    // identity, needs a real password now" and "existing identity, already
    // has one".
    const needsPassword = membership.user.password.length !== 60;
    if (needsPassword && !opts.password) {
      throw new BadRequestException('Password required to accept');
    }
    // Hash BEFORE opening the transaction (mirrors registerWorkspace) — the
    // CPU-bound bcrypt work has no business holding a DB transaction open.
    const passwordHash = needsPassword
      ? await bcrypt.hash(opts.password!, this.bcryptCost())
      : null;

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.workspaceMembership.updateMany({
        where: { id: membershipId, workspaceId: membership.workspaceId, status: 'INVITED' },
        data: { status: 'ACTIVE', acceptedAt: new Date() },
      });
      if (claim.count === 0) {
        // Already accepted/declined/gone by the time we got here — a
        // concurrent accept won the race. Report it rather than silently
        // no-op-ing.
        throw new ConflictException('Invite is no longer pending');
      }

      if (passwordHash) {
        await tx.marketingUser.update({
          where: { id: membership.userId },
          data: { password: passwordHash },
        });
      }

      return { status: 'ACTIVE' as const, workspaceId: membership.workspaceId };
    });
  }

  /** Same env-tunable bcrypt cost as MarketingAuthService (BCRYPT_COST, default 12). */
  private bcryptCost(): number {
    const raw = this.config.get<string>('BCRYPT_COST');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  }
}
