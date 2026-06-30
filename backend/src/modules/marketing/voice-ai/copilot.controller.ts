import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { CopilotService } from './copilot.service';
import { CopilotSuggestDto } from './copilot-suggest.dto';

/**
 * Voice-AI Phase 4 — live agent copilot (REST). The webphone captures the live
 * call transcript via the browser's own speech recognition and POSTs the running
 * transcript here; we return Claude-generated next-things-to-say + a one-line
 * summary for the HUMAN rep. Same auth surface as placing calls (`leads.write` +
 * the `telephony` feature) since it is a rep-on-a-call action.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/voice-ai/copilot')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Post('suggest')
  @RequirePermission('leads.write')
  suggest(
    @Body() dto: CopilotSuggestDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.copilot.suggest(user.workspaceId, dto.agentProfileId ?? null, dto.transcript);
  }
}
