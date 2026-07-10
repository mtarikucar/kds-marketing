import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { CampaignsService } from '../campaigns/campaigns.service';
import { VoiceAudioUploadService, UploadedWavFile } from '../campaigns/voice-audio-upload.service';
import { CreateCampaignDto, UpdateCampaignDto, SetVariantsDto } from '../dto/campaign.dto';
import { Audit } from '../../audit/audit.decorator';
import { SocialCampaignLinkService } from '../social-campaigns/social-campaign-link.service';

/**
 * Email/SMS/WhatsApp campaigns. MANAGER+ behind the `campaigns` feature.
 * Drafting/editing is free; `launch` freezes the audience and starts the
 * throttled send. Compose copy via the existing /marketing/ai/compose endpoint.
 */
@MarketingRoute()
@Controller('marketing/campaigns')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('campaigns')
export class MarketingCampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly socialLink: SocialCampaignLinkService,
    private readonly voiceAudio: VoiceAudioUploadService,
  ) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.campaigns.list(a.workspaceId);
  }

  /**
   * Upload a .wav to use as a VOICE campaign's `voiceConfig.audioid` (the
   * audio-blast alternative to the TTS `msg` text) — proxies to NetGSM's
   * `/voicesms/upload` via `VoicesmsSendClient`. Gated on `voiceCampaigns`
   * specifically (overriding the class's broader `campaigns` requirement —
   * see `FeatureGuard`'s `getAllAndOverride`), NOT the general `campaigns`
   * feature, since this is voice-specific. Non-wav / oversize (>4MB) files
   * are rejected inside `VoiceAudioUploadService` with a clean 400 BEFORE
   * NetGSM is ever called.
   */
  @Post('voice/audio')
  @RequiresFeature('voiceCampaigns')
  @RequirePermission('campaigns.send')
  @UseInterceptors(FileInterceptor('file'))
  uploadVoiceAudio(@UploadedFile() file: UploadedWavFile, @CurrentMarketingUser() a: MarketingUserPayload) {
    return this.voiceAudio.upload(a.workspaceId, file);
  }

  /** Cross-link (§6.3): provision a companion Social Campaign prefilled from this
   *  blast (subject/body/audience). Sets Campaign.socialCampaignId. */
  @Post(':id/social')
  @RequirePermission('campaigns.send')
  @Audit({ action: 'campaign.social.provision', resourceType: 'campaign', resourceIdParam: 'id' })
  createSocial(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.socialLink.provisionFromBlast(a.workspaceId, id, a.id);
  }

  @Post()
  @RequirePermission('campaigns.send')
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
  @RequirePermission('campaigns.send')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(a.workspaceId, id, dto);
  }

  /** Replace the campaign's A/B variants (draft/scheduled only). */
  @Put(':id/variants')
  @RequirePermission('campaigns.send')
  setVariants(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: SetVariantsDto) {
    return this.campaigns.setVariants(a.workspaceId, id, dto);
  }

  @Post(':id/launch')
  @RequirePermission('campaigns.send')
  launch(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.launch(a.workspaceId, id);
  }

  @Post(':id/pause')
  @RequirePermission('campaigns.send')
  pause(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.pause(a.workspaceId, id);
  }

  @Post(':id/resume')
  @RequirePermission('campaigns.send')
  resume(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.resume(a.workspaceId, id);
  }

  @Post(':id/cancel')
  @RequirePermission('campaigns.send')
  cancel(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.cancel(a.workspaceId, id);
  }

  @Delete(':id')
  @RequirePermission('campaigns.send')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.campaigns.remove(a.workspaceId, id);
  }
}
