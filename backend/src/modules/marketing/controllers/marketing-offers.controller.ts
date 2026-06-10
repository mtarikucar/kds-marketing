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
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingOffersService } from '../services/marketing-offers.service';
import { CreateOfferDto } from '../dto/create-offer.dto';
import { UpdateOfferDto } from '../dto/update-offer.dto';
import { MarketingUserPayload } from '../types';

@Controller('marketing/offers')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoute()
export class MarketingOffersController {
  constructor(private readonly offersService: MarketingOffersService) {}

  @Post()
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
  ) {
    return this.offersService.findAll(actor.workspaceId, actor.id, actor.role, page, limit);
  }

  @Get(':id')
  findOne(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.findOne(actor.workspaceId, id, actor.id, actor.role);
  }

  @Patch(':id')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOfferDto,
  ) {
    return this.offersService.update(actor.workspaceId, id, dto, actor.id, actor.role);
  }

  @Post(':id/send')
  markSent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.markSent(actor.workspaceId, id, actor.id, actor.role);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  delete(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.offersService.delete(actor.workspaceId, id);
  }
}
