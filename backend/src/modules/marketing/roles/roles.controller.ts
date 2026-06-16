import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { RolesService } from './roles.service';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermission } from './require-permission.decorator';

class RoleDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  name: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  permissions?: string[];
}

class UpdateRoleDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80)
  name?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  permissions?: string[];
}

class AssignRoleDto {
  @IsString() @IsNotEmpty()
  userId: string;

  @IsOptional() @IsString()
  roleId?: string | null;
}

@MarketingRoute()
@Controller('marketing/roles')
// PermissionsGuard runs after MarketingGuard populates request.marketingUser
// (incl. customRoleId). It is a no-op on handlers without @RequirePermission,
// so reads stay open to OWNER/MANAGER via the legacy MarketingRolesGuard while
// the mutating handlers below additionally require the `users.manage` grant.
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('OWNER', 'MANAGER')
export class RolesController {
  constructor(private readonly svc: RolesService) {}

  @Get('catalog')
  catalog() {
    return this.svc.catalog();
  }

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  @Audit({ action: 'role.create', resourceType: 'role' })
  create(@Body() dto: RoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Post('assign')
  @RequirePermission('settings.manage')
  @Audit({ action: 'role.assign', resourceType: 'user', captureBody: ['userId', 'roleId'] })
  assign(@Body() dto: AssignRoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.assignToUser(u.workspaceId, dto.userId, dto.roleId ?? null);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  @Audit({ action: 'role.update', resourceType: 'role', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  @Audit({ action: 'role.delete', resourceType: 'role', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }
}
