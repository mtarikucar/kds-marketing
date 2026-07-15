import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { MembershipService } from './membership.service';
import { CreateMarketingUserDto } from '../dto/create-marketing-user.dto';
import { UpdateMarketingUserDto } from '../dto/update-marketing-user.dto';

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * Multi-workspace membership (Phase 2 Task 13) — this service now operates at
 * MEMBERSHIP granularity, not MarketingUser-row granularity. A MarketingUser
 * identity can hold N WorkspaceMemberships (one per workspace); "the users of
 * THIS workspace" is the set of non-SYSTEM memberships for workspaceId, and
 * "deactivating a user" suspends only the membership that ties them to this
 * workspace — never the shared identity, which may still be ACTIVE elsewhere.
 */
@Injectable()
export class MarketingUsersService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private entitlements: EntitlementsService,
    private membership: MembershipService,
  ) {}

  private bcryptCost(): number {
    const raw = this.configService.get<string>('BCRYPT_COST');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  }

  /**
   * Enforce the package's active-seat limit (maxUsers; -1 = unlimited). SYSTEM
   * sentinels don't occupy seats. Counts ACTIVE **and** INVITED memberships —
   * a pending invite already consumes a seat (spec §5: "invites are bounded
   * by the seat limit"), so accepting the invite later needs no re-check.
   * Used by update()'s SUSPENDED→ACTIVE reactivation path — a reactivation
   * consumes a seat exactly like an invite, so it must pass through the same
   * check, or a workspace at its cap could bypass the limit
   * (deactivate → invite → reactivate). create() does NOT call this anymore
   * (see create()'s docstring) — MembershipService.invite() enforces the
   * identical check itself now, for both this service's create() AND
   * POST /marketing/users/invite.
   */
  private async assertSeatAvailable(
    db: Prisma.TransactionClient,
    workspaceId: string,
    maxUsers: number,
  ) {
    if (maxUsers === -1) return;
    const seats = await db.workspaceMembership.count({
      where: { workspaceId, role: { not: 'SYSTEM' }, status: { in: ['ACTIVE', 'INVITED'] } },
    });
    if (seats >= maxUsers) {
      throw new BadRequestException(
        `Seat limit reached (${maxUsers}) — upgrade your package to add users`,
      );
    }
  }

  /** Advisory-lock the workspace's seat counter so the seat-check + the
   *  seat-consuming write (reactivate) is atomic — a bare count-then-write
   *  lets two concurrent requests at (cap-1) both pass and exceed maxUsers.
   *  Mirrors the research / knowledge / ai-credits quota lock, and the
   *  identical lock MembershipService.invite() takes on its own (separate)
   *  seat-consuming write. */
  private seatLock(tx: Prisma.TransactionClient, workspaceId: string) {
    return tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey('users:' + workspaceId)}))::text AS locked`,
    );
  }

  /**
   * "Create a user" is now "invite a membership" — the MANAGER/REP role
   * floor, the OWNER/SYSTEM exclusion, AND the seat cap are ALL enforced by
   * MembershipService.invite() itself (identical BadRequestException), so
   * this is a thin, unconditional delegate rather than duplicating any of
   * that. It used to open its OWN advisory-locked transaction around a seat
   * count before calling invite() — but invite() now takes the SAME
   * per-workspace pg_advisory_xact_lock on ITS OWN (separate, un-nested)
   * transaction, and two different connections contending for the identical
   * lock key — one held by this method's outer transaction while it awaits
   * invite(), the other opened BY that same invite() call — would
   * self-deadlock. Delegating outright makes invite() the single seat-cap
   * choke point for both this admin route and POST /marketing/users/invite,
   * with no lock nesting. `actorId` becomes the membership's
   * `invitedByUserId`; it's optional only so existing callers that don't
   * have an actor in scope keep compiling (the controller always has one).
   */
  async create(workspaceId: string, dto: CreateMarketingUserDto, actorId?: string) {
    return this.membership.invite(workspaceId, actorId ?? '', dto);
  }

  /**
   * This workspace's memberships (ACTIVE + INVITED + SUSPENDED — the admin
   * needs to see pending/suspended, not just active), joined to their
   * identity. SYSTEM sentinels are excluded — they're not a "user" the admin
   * manages. `id` is the userId (the identity), matching every other method
   * on this service which is keyed by userId, not membershipId.
   */
  async findAll(workspaceId: string) {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId, role: { not: 'SYSTEM' } },
      include: {
        user: {
          select: { email: true, firstName: true, lastName: true, phone: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return memberships.map((m) => ({
      id: m.userId,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      phone: m.user.phone,
      role: m.role,
      status: m.status,
      createdAt: m.createdAt,
    }));
  }

  /**
   * Mirrors findAll()'s join: role/status come from THIS workspace's
   * membership row, not the (frozen-at-creation, now-stale) MarketingUser
   * columns — a promoted/suspended-then-reactivated user must read back
   * their CURRENT membership state here, not what they were at signup.
   */
  async findOne(workspaceId: string, id: string) {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { userId: id, workspaceId, role: { not: 'SYSTEM' } },
      select: {
        role: true,
        status: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            avatar: true,
            lastLogin: true,
            createdAt: true,
            _count: {
              select: { leads: true, activities: true, commissions: true, tasks: true },
            },
          },
        },
      },
    });

    if (!membership) throw new NotFoundException('User not found');
    const { user, role, status } = membership;
    return { ...user, role, status };
  }

  /**
   * Authorization for DEACTIVATING (suspending) a member — shared by delete()
   * and update()'s `status: 'INACTIVE'` path so a PATCH can't be a backdoor
   * around the delete guards: the OWNER membership is never deactivatable, no
   * one may deactivate themselves (mid-session lockout, recoverable only by
   * another admin), and a MANAGER target requires an OWNER/MANAGER actor.
   * Operates on the MEMBERSHIP's role now, not the identity's — a target's
   * privilege in THIS workspace is what the guard must reason about, since
   * the same identity can hold a different role in another workspace.
   */
  private assertCanDeactivate(
    membership: { role: string },
    targetUserId: string,
    actorRole: string,
    actorId: string,
  ) {
    if (membership.role === 'OWNER') {
      throw new ForbiddenException('The owner account cannot be deactivated');
    }
    if (targetUserId === actorId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    if (membership.role === 'MANAGER' && actorRole !== 'OWNER' && actorRole !== 'MANAGER') {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateMarketingUserDto,
    actorRole: string,
    actorId?: string,
  ) {
    // One round trip for both halves: role/status live on the membership,
    // profile fields (name/email/phone/password) live on the shared identity.
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { userId: id, workspaceId },
      include: { user: true },
    });
    if (!membership || membership.role === 'SYSTEM') {
      throw new NotFoundException('User not found');
    }
    const user = membership.user;

    // Only the OWNER may touch the OWNER account, and nobody can promote
    // to OWNER through this surface (ownership transfer is an ops action).
    if (membership.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new ForbiddenException('Only the owner can modify the owner account');
    }
    if (dto.role && !['MANAGER', 'REP'].includes(dto.role)) {
      throw new BadRequestException('Role must be MANAGER or REP');
    }
    if (dto.role && membership.role === 'OWNER') {
      throw new BadRequestException('The owner role cannot be changed here');
    }

    // Deactivation via update() is a real state change — hold it to the SAME
    // guards delete() enforces (self-lockout, owner protection, role floor), or a
    // PATCH silently bypasses them.
    if (dto.status === 'INACTIVE' && membership.status === 'ACTIVE') {
      this.assertCanDeactivate(membership, id, actorRole, actorId ?? '');
    }

    // Reactivation via this admin path may only flip a SUSPENDED membership
    // back to ACTIVE. An INVITED membership must NEVER be flipped straight
    // to ACTIVE here — that would bypass MembershipService.accept(), which
    // is the only place a pending invite's REAL password gets set. Doing it
    // here would produce an ACTIVE member stuck with the unusable
    // invite-time sentinel password (can never log in) while still
    // consuming a real seat.
    if (dto.status === 'ACTIVE' && membership.status === 'INVITED') {
      throw new BadRequestException(
        'A pending invite must be accepted by the invitee, not reactivated',
      );
    }

    // Reactivating a SUSPENDED membership consumes a seat, exactly like
    // create()/invite() — so re-check the package limit (atomically, at the
    // write below). Without this, a workspace at its cap could exceed it via
    // deactivate → invite → reactivate.
    const reactivating = dto.status === 'ACTIVE' && membership.status === 'SUSPENDED';
    const effective = reactivating ? await this.entitlements.getEffective(workspaceId) : null;

    // Email is the global unique login identity. When it's being changed, reject
    // a collision with a clean 409 (mirrors create()/invite()) instead of letting
    // the DB unique constraint surface a raw 500. The P2002 catch below covers
    // the concurrent same-email race the pre-check can't.
    if (dto.email && dto.email !== user.email) {
      const clash = await this.prisma.marketingUser.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (clash && clash.id !== user.id) {
        throw new ConflictException('Email already exists');
      }
    }

    // Split the dto: role/status are membership-level; everything else
    // (firstName/lastName/phone/email/password) is identity-level.
    const { role, status, ...profileDto } = dto;
    const profileData: any = { ...profileDto };
    if (dto.password) {
      // Use the same configurable cost create() uses. Hard-coding 10
      // here meant operators raising BCRYPT_COST (e.g. to 12 or 14)
      // would silently get downgraded hashes on every password
      // rotation — a real regression in their hardening intent.
      profileData.password = await bcrypt.hash(dto.password, this.bcryptCost());
    }

    const membershipData: any = {};
    if (role) membershipData.role = role;
    if (status === 'INACTIVE') membershipData.status = 'SUSPENDED';
    if (status === 'ACTIVE') membershipData.status = 'ACTIVE';

    const profileSelect = { id: true, email: true, firstName: true, lastName: true, phone: true };
    const doUpdate = async (db: Prisma.TransactionClient) => {
      let out = {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        role: membership.role,
        status: membership.status,
      };
      if (Object.keys(profileData).length > 0) {
        const updated = await db.marketingUser.update({
          where: { id: user.id },
          data: profileData,
          select: profileSelect,
        });
        out = { ...out, ...updated };
      }
      if (Object.keys(membershipData).length > 0) {
        const updated = await db.workspaceMembership.update({
          where: { id: membership.id },
          data: membershipData,
          select: { role: true, status: true },
        });
        out = { ...out, ...updated };
      }
      return out;
    };
    try {
      // A reactivation consumes a seat — run the seat-check + the ACTIVE flip
      // atomically under the per-workspace lock so two concurrent reactivations
      // can't both pass the cap (mirrors create()).
      if (reactivating && effective!.maxUsers !== -1) {
        return await this.prisma.$transaction(async (tx) => {
          await this.seatLock(tx, workspaceId);
          await this.assertSeatAvailable(tx, workspaceId, effective!.maxUsers);
          return doUpdate(tx);
        });
      }
      // Not a reactivation — still run both halves (when both are present)
      // inside one transaction, so a profile edit + a role change either
      // both land or neither does.
      return await this.prisma.$transaction((tx) => doUpdate(tx));
    } catch (e) {
      // Lost the concurrent race on the email unique index — clean 409, not 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
      throw e;
    }
  }

  async delete(workspaceId: string, id: string, actorRole: string, actorId: string) {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { userId: id, workspaceId },
    });
    if (!membership || membership.role === 'SYSTEM') {
      throw new NotFoundException('User not found');
    }
    // Same authorization update()'s deactivation path uses (owner-protected, no
    // self-deactivation, MANAGER target needs an OWNER/MANAGER actor).
    this.assertCanDeactivate(membership, id, actorRole, actorId);

    // SUSPEND the membership, never the shared identity — the user may hold
    // OTHER workspaces' memberships that must stay untouched.
    await this.prisma.workspaceMembership.updateMany({
      where: { userId: id, workspaceId },
      data: { status: 'SUSPENDED' },
    });

    return { message: 'User deactivated successfully' };
  }
}
