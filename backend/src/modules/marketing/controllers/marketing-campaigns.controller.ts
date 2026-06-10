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
import { CampaignsService } from '../campaigns/campaigns.service';
import { CreateCampaignDto, UpdateCampaignDto } from '../dto/campaign.dto';

/**
 * Email/SMS/WhatsApp campaigns. MANAGER+ behind the `campaigns` feature.
 * Drafting/editing is free; `launch` freezes the audience and starts the
 * throttled send. Compose copy via the existing /marketing/ai/compose endpoint.
 */
@MarketingRoute()
@Controller('marketing/campaigns')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('campaigns')
export class MarketingCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.campaigns.list(a.workspaceId);
  }

  @Post()
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(a.workspaceId, dto);
  }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.get(a.workspaceId, id);
  }

  @Get(':id/recipients')
  recipients(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.recipients(a.workspaceId, id);
  }

  @Patch(':id')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(a.workspaceId, id, dto);
  }

  @Post(':id/launch')
  launch(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.launch(a.workspaceId, id);
  }

  @Post(':id/pause')
  pause(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.pause(a.workspaceId, id);
  }

  @Post(':id/resume')
  resume(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.resume(a.workspaceId, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.cancel(a.workspaceId, id);
  }

  @Delete(':id')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.remove(a.workspaceId, id);
  }
}
