import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingUsersService } from '../services/marketing-users.service';
import { MembershipService } from '../services/membership.service';
import { CreateMarketingUserDto } from '../dto/create-marketing-user.dto';
import { UpdateMarketingUserDto } from '../dto/update-marketing-user.dto';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/users')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingUsersController {
  constructor(
    private readonly usersService: MarketingUsersService,
    private readonly membershipService: MembershipService,
  ) {}

  // Multi-workspace membership (Phase 2 Task 11) — invite an existing or
  // brand-new identity into THIS workspace as MANAGER/REP. Listed before the
  // create()/:id routes so Nest resolves the literal /invite path first.
  @Post('invite')
  @RequirePermission('users.manage')
  @Audit({ action: 'user.invite', resourceType: 'user' })
  invite(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: InviteMemberDto,
  ) {
    return this.membershipService.invite(actor.workspaceId, actor.id, dto);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateMarketingUserDto,
  ) {
    return this.usersService.create(actor.workspaceId, dto);
  }

  @Get()
  findAll(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.usersService.findAll(actor.workspaceId);
  }

  @Get(':id')
  findOne(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.usersService.findOne(actor.workspaceId, id);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateMarketingUserDto,
  ) {
    return this.usersService.update(actor.workspaceId, id, dto, actor.role, actor.id);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  delete(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.usersService.delete(actor.workspaceId, id, actor.role, actor.id);
  }
}
