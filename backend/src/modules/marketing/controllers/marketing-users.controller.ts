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
import { MarketingUsersService } from '../services/marketing-users.service';
import { CreateMarketingUserDto } from '../dto/create-marketing-user.dto';
import { UpdateMarketingUserDto } from '../dto/update-marketing-user.dto';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/users')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingUsersController {
  constructor(private readonly usersService: MarketingUsersService) {}

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
