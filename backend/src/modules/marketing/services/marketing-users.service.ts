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
import { CreateMarketingUserDto } from '../dto/create-marketing-user.dto';
import { UpdateMarketingUserDto } from '../dto/update-marketing-user.dto';

@Injectable()
export class MarketingUsersService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private entitlements: EntitlementsService,
  ) {}

  private bcryptCost(): number {
    const raw = this.configService.get<string>('BCRYPT_COST');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  }

  /**
   * Enforce the package's active-seat limit (maxUsers; -1 = unlimited). SYSTEM
   * sentinels don't occupy seats. Shared by create() AND update()'s reactivation
   * path — both consume a seat, so both must pass through here or a workspace at
   * its cap could bypass the limit (deactivate → create → reactivate).
   */
  private async assertSeatAvailable(workspaceId: string) {
    const effective = await this.entitlements.getEffective(workspaceId);
    if (effective.maxUsers === -1) return;
    const seats = await this.prisma.marketingUser.count({
      where: { workspaceId, role: { not: 'SYSTEM' }, status: 'ACTIVE' },
    });
    if (seats >= effective.maxUsers) {
      throw new BadRequestException(
        `Seat limit reached (${effective.maxUsers}) — upgrade your package to add users`,
      );
    }
  }

  async create(workspaceId: string, dto: CreateMarketingUserDto) {
    // Email is the global login identity (unique across workspaces), so the
    // existence check is intentionally unscoped — but the row is born scoped.
    const existing = await this.prisma.marketingUser.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already exists');
    }

    await this.assertSeatAvailable(workspaceId);

    if (!['MANAGER', 'REP'].includes(dto.role)) {
      // OWNER exists once per workspace (created at signup); SYSTEM is the
      // research sentinel — neither is creatable through user management.
      throw new BadRequestException('Role must be MANAGER or REP');
    }

    const hashedPassword = await bcrypt.hash(dto.password, this.bcryptCost());

    return this.prisma.marketingUser.create({
      data: {
        ...dto,
        workspaceId,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async findAll(workspaceId: string) {
    return this.prisma.marketingUser.findMany({
      where: { workspaceId, role: { not: 'SYSTEM' } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        _count: {
          select: { leads: true, activities: true, commissions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(workspaceId: string, id: string) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id, workspaceId, role: { not: 'SYSTEM' } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatar: true,
        role: true,
        status: true,
        lastLogin: true,
        createdAt: true,
        _count: {
          select: { leads: true, activities: true, commissions: true, tasks: true },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Authorization for DEACTIVATING a user — shared by delete() and update()'s
   * `status: 'INACTIVE'` path so a PATCH can't be a backdoor around the delete
   * guards: the OWNER account is never deactivatable, no one may deactivate
   * themselves (mid-session lockout, recoverable only by another admin), and a
   * MANAGER target requires an OWNER/MANAGER actor.
   */
  private assertCanDeactivate(
    user: { id: string; role: string },
    actorRole: string,
    actorId: string,
  ) {
    if (user.role === 'OWNER') {
      throw new ForbiddenException('The owner account cannot be deactivated');
    }
    if (user.id === actorId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    if (user.role === 'MANAGER' && actorRole !== 'OWNER' && actorRole !== 'MANAGER') {
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
    const user = await this.prisma.marketingUser.findFirst({
      where: { id, workspaceId },
    });
    if (!user || user.role === 'SYSTEM') throw new NotFoundException('User not found');

    // Only the OWNER may touch the OWNER account, and nobody can promote
    // to OWNER through this surface (ownership transfer is an ops action).
    if (user.role === 'OWNER' && actorRole !== 'OWNER') {
      throw new ForbiddenException('Only the owner can modify the owner account');
    }
    if (dto.role && !['MANAGER', 'REP'].includes(dto.role)) {
      throw new BadRequestException('Role must be MANAGER or REP');
    }
    if (dto.role && user.role === 'OWNER') {
      throw new BadRequestException('The owner role cannot be changed here');
    }

    // Deactivation via update() is a real state change — hold it to the SAME
    // guards delete() enforces (self-lockout, owner protection, role floor), or a
    // PATCH silently bypasses them.
    if (dto.status === 'INACTIVE' && user.status === 'ACTIVE') {
      this.assertCanDeactivate(user, actorRole, actorId ?? '');
    }

    // Reactivating an INACTIVE user consumes a seat, exactly like create() — so
    // re-check the package limit. Without this, a workspace at its cap could
    // exceed it via deactivate → create new → reactivate the old one.
    if (dto.status === 'ACTIVE' && user.status !== 'ACTIVE') {
      await this.assertSeatAvailable(workspaceId);
    }

    // Email is the global unique login identity. When it's being changed, reject
    // a collision with a clean 409 (mirrors create()) instead of letting the DB
    // unique constraint surface a raw 500. The P2002 catch below covers the
    // concurrent same-email race the pre-check can't.
    if (dto.email && dto.email !== user.email) {
      const clash = await this.prisma.marketingUser.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (clash && clash.id !== user.id) {
        throw new ConflictException('Email already exists');
      }
    }

    const data: any = { ...dto };
    if (dto.password) {
      // Use the same configurable cost create() uses. Hard-coding 10
      // here meant operators raising BCRYPT_COST (e.g. to 12 or 14)
      // would silently get downgraded hashes on every password
      // rotation — a real regression in their hardening intent.
      data.password = await bcrypt.hash(dto.password, this.bcryptCost());
    }

    try {
      return await this.prisma.marketingUser.update({
        where: { id: user.id },
        data,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          status: true,
        },
      });
    } catch (e) {
      // Lost the concurrent race on the email unique index — clean 409, not 500.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
      throw e;
    }
  }

  async delete(workspaceId: string, id: string, actorRole: string, actorId: string) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id, workspaceId },
    });
    if (!user || user.role === 'SYSTEM') throw new NotFoundException('User not found');
    // Same authorization update()'s deactivation path uses (owner-protected, no
    // self-deactivation, MANAGER target needs an OWNER/MANAGER actor).
    this.assertCanDeactivate(user, actorRole, actorId);

    await this.prisma.marketingUser.update({
      where: { id: user.id },
      data: { status: 'INACTIVE' },
    });

    return { message: 'User deactivated successfully' };
  }
}
