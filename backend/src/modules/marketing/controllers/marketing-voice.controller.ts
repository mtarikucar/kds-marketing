import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { VoiceAiService } from '../channels/voice-ai.service';

/** AI voice call log + transcripts. MANAGER+ behind the `voiceAi` feature. */
@MarketingRoute()
@Controller('marketing/voice')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('voiceAi')
export class MarketingVoiceController {
  constructor(private readonly voice: VoiceAiService) {}

  @Get('calls')
  calls(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.voice.listCalls(a.workspaceId);
  }

  @Get('calls/:id/transcript')
  transcript(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.voice.transcript(a.workspaceId, id);
  }
}
