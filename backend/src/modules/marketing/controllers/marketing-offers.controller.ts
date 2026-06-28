import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingOffersService } from '../services/marketing-offers.service';
import { CreateOfferDto } from '../dto/create-offer.dto';
import { UpdateOfferDto } from '../dto/update-offer.dto';
import { MarketingUserPayload } from '../types';

@Controller('marketing/offers')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingOffersController {
  constructor(private readonly offersService: MarketingOffersService) {}

  @Post()
  @RequirePermission('leads.write')
  create(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateOfferDto,
  ) {
    return this.offersService.create(actor.workspaceId, dto, actor.id, actor.role);
  }

  @Get()
  findAll(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.offersService.findAll(actor.workspaceId, actor.id, actor.role, page, limit, {
      status,
      dateFrom,
      dateTo,
    });
  }

  @Get(':id')
  findOne(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.findOne(actor.workspaceId, id, actor.id, actor.role);
  }

  @Patch(':id')
  @RequirePermission('leads.write')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOfferDto,
  ) {
    return this.offersService.update(actor.workspaceId, id, dto, actor.id, actor.role);
  }

  @Post(':id/send')
  @RequirePermission('leads.write')
  markSent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.markSent(actor.workspaceId, id, actor.id, actor.role);
  }

  @Post(':id/accept')
  @RequirePermission('leads.write')
  accept(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.markAccepted(actor.workspaceId, id, actor.id, actor.role);
  }

  @Post(':id/reject')
  @RequirePermission('leads.write')
  reject(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.markRejected(actor.workspaceId, id, actor.id, actor.role);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  @RequirePermission('leads.manage')
  delete(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.delete(actor.workspaceId, id);
  }
}
