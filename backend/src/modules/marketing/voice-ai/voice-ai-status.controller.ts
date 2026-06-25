import { Controller, Get, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { voiceAiPublicStatus } from './voice-ai.config';

/**
 * Voice-AI settings status — read-only capability flags + the URL templates the
 * operator pastes into NetGSM / an AI voice partner (VAPI/Retell/ElevenLabs).
 * No secrets are returned; each flag is true only when its env is set, so the
 * settings UI can show exactly what is live vs. what still needs a purchase/key.
 */
@MarketingRoute()
@Controller('marketing/voice-ai')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class VoiceAiStatusController {
  @Get('status')
  @RequirePermission('settings.manage')
  status() {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    return {
      capabilities: voiceAiPublicStatus(),
      // {channelId} / {token} are placeholders the operator substitutes.
      urls: {
        // Custom-LLM bridge a partner (VAPI/Retell/ElevenLabs) points at as its LLM.
        bridge: `${base}/api/public/voice-ai/llm/{channelId}/chat/completions`,
        // NetGSM "Özel API (Custom)" inbound IVR webhook (TTS robot).
        netgsmIvr: `${base}/api/public/telephony/netgsm-ivr/{token}`,
        // REST copilot endpoint the webphone posts the live transcript to.
        copilotSuggest: `${base}/api/marketing/voice-ai/copilot/suggest`,
      },
    };
  }
}
