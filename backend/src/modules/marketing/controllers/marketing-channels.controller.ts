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
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { ChannelsService } from '../channels/channels.service';
import { CreateChannelDto, UpdateChannelDto } from '../dto/channel.dto';

/**
 * Channel configuration (web-chat / WhatsApp / SMS / Instagram / Messenger).
 * Workspace-shaping config, so MANAGER+ behind the `conversationAi` feature.
 * Secrets go in via `secrets` and never come back out — reads expose only
 * which credential keys are set.
 */
@MarketingRoute()
@Controller('marketing/channels')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('conversationAi')
export class MarketingChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.channels.list(actor.workspaceId);
  }

  @Get(':id')
  get(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.get(actor.workspaceId, id);
  }

  @Post()
  create(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CreateChannelDto) {
    return this.channels.create(actor.workspaceId, dto);
  }

  @Patch(':id')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.channels.update(actor.workspaceId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.remove(actor.workspaceId, id);
  }

  @Post(':id/verify')
  verify(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.verify(actor.workspaceId, id);
  }
}
