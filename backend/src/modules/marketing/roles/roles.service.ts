import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LEGACY_ROLE_PERMISSIONS, PERMISSIONS } from './permissions';

interface RoleInput {
  name: string;
  permissions?: string[];
}

/** The acting user — used to cap what permissions a role mutation may grant.
 *  Carries workspaceId so the actor's own permission set resolves correctly
 *  (resolvePermissions reads the custom role workspace-scoped). */
type Actor = { workspaceId: string; role: string; customRoleId?: string | null };

/**
 * Epic F — custom roles with granular permissions. When a user has a
 * `customRoleId`, its permission set applies; otherwise the legacy
 * OWNER/MANAGER/REP mapping does. Additive — existing role checks are untouched.
 */
@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  catalog() {
    return [...PERMISSIONS];
  }

  list(workspaceId: string) {
    return this.prisma.customRole.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
  }

  private validate(permissions: string[]) {
    const invalid = permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (invalid.length) throw new BadRequestException(`Unknown permission(s): ${invalid.join(', ')}`);
  }

  /**
   * Privilege-escalation guard: a user may only grant (or assign a role that
   * grants) permissions they themselves hold. Without this a MANAGER — who has
   * `settings.manage` but deliberately NOT `billing.manage`/`users.manage` —
   * could mint a custom role carrying those and assign it to themselves.
   */
  private async assertWithinActorGrant(permissions: string[], actor: Actor) {
    const held = new Set(await this.resolvePermissions(actor));
    const exceeding = permissions.filter((p) => !held.has(p));
    if (exceeding.length) {
      throw new ForbiddenException(`You cannot grant permission(s) you do not hold: ${exceeding.join(', ')}`);
    }
  }

  /**
   * Privilege-floor guard: an actor may only manage a target (user or role) that
   * holds permissions WITHIN their own set. assertWithinActorGrant caps what is
   * granted; this caps WHO/WHAT may be touched — without it a MANAGER could
   * assign a weak role to an OWNER (a custom role REPLACES legacy permissions, so
   * that downgrades + locks the OWNER out of settings) or strip an OWNER-level
   * custom role, neutering a superior. The actor must out-rank the target.
   */
  private async assertActorOutranks(targetPermissions: string[], actor: Actor, what: string) {
    const held = new Set(await this.resolvePermissions(actor));
    const exceeding = targetPermissions.filter((p) => !held.has(p));
    if (exceeding.length) {
      throw new ForbiddenException(
        `You cannot ${what}: it holds permission(s) you do not have (${exceeding.join(', ')})`,
      );
    }
  }

  async create(workspaceId: string, dto: RoleInput, actor: Actor) {
    const permissions = dto.permissions ?? [];
    this.validate(permissions);
    await this.assertWithinActorGrant(permissions, actor);
    const dupe = await this.prisma.customRole.findUnique({
      where: { workspaceId_name: { workspaceId, name: dto.name } },
    });
    if (dupe) throw new ConflictException('A role with this name already exists');
    try {
      return await this.prisma.customRole.create({
        data: { workspaceId, name: dto.name, permissions: permissions as Prisma.InputJsonValue },
      });
    } catch (e) {
      // Lost the unique (workspaceId,name) race to a concurrent create → 409, not 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A role with this name already exists');
      }
      throw e;
    }
  }

  private async owned(workspaceId: string, id: string) {
    const r = await this.prisma.customRole.findFirst({ where: { id, workspaceId } });
    if (!r) throw new NotFoundException('Role not found');
    return r;
  }

  async update(workspaceId: string, id: string, dto: Partial<RoleInput>, actor: Actor) {
    const existing = await this.owned(workspaceId, id);
    // Can't modify a role that already grants more than the actor holds (else a
    // MANAGER could strip an OWNER-level role, downgrading everyone who holds it).
    await this.assertActorOutranks((existing.permissions as string[]) ?? [], actor, 'modify this role');
    if (dto.permissions) {
      this.validate(dto.permissions);
      await this.assertWithinActorGrant(dto.permissions, actor);
    }
    try {
      return await this.prisma.customRole.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.permissions !== undefined && { permissions: dto.permissions as Prisma.InputJsonValue }),
        },
      });
    } catch (e) {
      // Renaming onto a taken (workspaceId,name) → 409 like create(), not a raw 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A role with this name already exists');
      }
      throw e;
    }
  }

  async remove(workspaceId: string, id: string, actor: Actor) {
    const existing = await this.owned(workspaceId, id);
    // Privilege-floor guard (parity with update/assignToUser): deleting a role
    // unassigns every holder (→ legacy permissions), so a MANAGER deleting an
    // OWNER-level role would downgrade users a superior elevated via that role.
    // The actor must out-rank what the role grants.
    await this.assertActorOutranks((existing.permissions as string[]) ?? [], actor, 'delete this role');
    // unassign anyone holding this role, then delete
    await this.prisma.marketingUser.updateMany({
      where: { workspaceId, customRoleId: id },
      data: { customRoleId: null },
    });
    await this.prisma.customRole.delete({ where: { id } });
    return { id };
  }

  async assignToUser(workspaceId: string, userId: string, roleId: string | null, actor: Actor) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id: userId, workspaceId },
      select: { id: true, role: true, customRoleId: true },
    });
    if (!user) throw new NotFoundException('User not found');
    // Can't touch a user who currently out-ranks the actor — assigning ANY role
    // (a custom role REPLACES legacy permissions) would downgrade + lock them out.
    const targetPerms = await this.resolvePermissions({
      workspaceId,
      role: user.role,
      customRoleId: user.customRoleId,
    });
    await this.assertActorOutranks(targetPerms, actor, 'modify this user');
    if (roleId) {
      const role = await this.owned(workspaceId, roleId);
      // Can't hand someone a role more powerful than what the actor holds.
      await this.assertWithinActorGrant((role.permissions as string[]) ?? [], actor);
    }
    await this.prisma.marketingUser.update({ where: { id: userId }, data: { customRoleId: roleId } });
    return { userId, customRoleId: roleId };
  }

  async resolvePermissions(user: { workspaceId: string; role: string; customRoleId?: string | null }) {
    if (user.customRoleId) {
      // Scope the custom-role read to the user's workspace (defence in depth: the
      // only writer of customRoleId already gates via owned(), but a workspace-
      // scoped read guarantees a stray customRoleId can never grant another
      // tenant's permission set).
      const r = await this.prisma.customRole.findFirst({
        where: { id: user.customRoleId, workspaceId: user.workspaceId },
      });
      return ((r?.permissions as string[]) ?? []);
    }
    return LEGACY_ROLE_PERMISSIONS[user.role] ?? [];
  }

  async hasPermission(
    user: { workspaceId: string; role: string; customRoleId?: string | null },
    permission: string,
  ) {
    return (await this.resolvePermissions(user)).includes(permission);
  }

  async userHasPermission(workspaceId: string, userId: string, permission: string) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id: userId, workspaceId },
      select: { role: true, customRoleId: true },
    });
    if (!user) return false;
    return this.hasPermission({ workspaceId, ...user }, permission);
  }
}
