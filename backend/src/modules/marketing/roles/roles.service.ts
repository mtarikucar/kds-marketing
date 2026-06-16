import {
  BadRequestException,
  ConflictException,
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

  async create(workspaceId: string, dto: RoleInput) {
    const permissions = dto.permissions ?? [];
    this.validate(permissions);
    const dupe = await this.prisma.customRole.findUnique({
      where: { workspaceId_name: { workspaceId, name: dto.name } },
    });
    if (dupe) throw new ConflictException('A role with this name already exists');
    return this.prisma.customRole.create({
      data: { workspaceId, name: dto.name, permissions: permissions as Prisma.InputJsonValue },
    });
  }

  private async owned(workspaceId: string, id: string) {
    const r = await this.prisma.customRole.findFirst({ where: { id, workspaceId } });
    if (!r) throw new NotFoundException('Role not found');
    return r;
  }

  async update(workspaceId: string, id: string, dto: Partial<RoleInput>) {
    await this.owned(workspaceId, id);
    if (dto.permissions) this.validate(dto.permissions);
    return this.prisma.customRole.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.permissions !== undefined && { permissions: dto.permissions as Prisma.InputJsonValue }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    // unassign anyone holding this role, then delete
    await this.prisma.marketingUser.updateMany({
      where: { workspaceId, customRoleId: id },
      data: { customRoleId: null },
    });
    await this.prisma.customRole.delete({ where: { id } });
    return { id };
  }

  async assignToUser(workspaceId: string, userId: string, roleId: string | null) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id: userId, workspaceId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (roleId) await this.owned(workspaceId, roleId);
    await this.prisma.marketingUser.update({ where: { id: userId }, data: { customRoleId: roleId } });
    return { userId, customRoleId: roleId };
  }

  async resolvePermissions(user: { role: string; customRoleId?: string | null }) {
    if (user.customRoleId) {
      const r = await this.prisma.customRole.findUnique({ where: { id: user.customRoleId } });
      return ((r?.permissions as string[]) ?? []);
    }
    return LEGACY_ROLE_PERMISSIONS[user.role] ?? [];
  }

  async hasPermission(user: { role: string; customRoleId?: string | null }, permission: string) {
    return (await this.resolvePermissions(user)).includes(permission);
  }

  async userHasPermission(workspaceId: string, userId: string, permission: string) {
    const user = await this.prisma.marketingUser.findFirst({
      where: { id: userId, workspaceId },
      select: { role: true, customRoleId: true },
    });
    if (!user) return false;
    return this.hasPermission(user, permission);
  }
}
