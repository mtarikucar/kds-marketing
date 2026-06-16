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
@UseGuards(MarketingGuard, MarketingRolesGuard)
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
  @Audit({ action: 'role.create', resourceType: 'role' })
  create(@Body() dto: RoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, dto);
  }

  @Post('assign')
  @Audit({ action: 'role.assign', resourceType: 'user', captureBody: ['userId', 'roleId'] })
  assign(@Body() dto: AssignRoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.assignToUser(u.workspaceId, dto.userId, dto.roleId ?? null);
  }

  @Patch(':id')
  @Audit({ action: 'role.update', resourceType: 'role', resourceIdParam: 'id' })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, dto);
  }

  @Delete(':id')
  @Audit({ action: 'role.delete', resourceType: 'role', resourceIdParam: 'id' })
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.remove(u.workspaceId, id);
  }
}
