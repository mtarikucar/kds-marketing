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
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { ChannelsService } from '../channels/channels.service';
import { CreateChannelDto, UpdateChannelDto, WhatsappEmbeddedSignupDto } from '../dto/channel.dto';

/**
 * Channel configuration (web-chat / WhatsApp / SMS / Instagram / Messenger).
 * Workspace-shaping config, so MANAGER+. Reading/managing the channel list in
 * general stays behind the `conversationAi` feature (method-level below), but
 * SMS save (create/update) + verify require `sms` specifically instead — the
 * NetGSM SMS v2 program split SMS off `conversationAi` into its own sellable
 * key. That split is type-conditional (one CRUD surface, many channel types),
 * which a static `@RequiresFeature` can't express, so create/update/verify
 * carry NO class/method-level feature decorator — ChannelsService resolves the
 * right key per channel type at runtime instead (see assertChannelFeature()).
 * Secrets go in via `secrets` and never come back out — reads expose only
 * which credential keys are set.
 */
@MarketingRoute()
@Controller('marketing/channels')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequiresFeature('conversationAi')
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.channels.list(actor.workspaceId);
  }

  /** Non-secret config the frontend needs to launch WhatsApp Embedded Signup.
   *  Declared BEFORE the `:id` route so the static path isn't captured by it. */
  @Get('whatsapp/embedded-signup/config')
  @RequiresFeature('conversationAi')
  whatsappSignupConfig() {
    return this.channels.whatsappSignupConfig();
  }

  /** Tenant self-serve WhatsApp connect — exchanges the Embedded Signup code and
   *  provisions (or rotates) the WHATSAPP channel. */
  @Post('whatsapp/embedded-signup')
  @RequiresFeature('conversationAi')
  @RequirePermission('settings.manage')
  whatsappSignup(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: WhatsappEmbeddedSignupDto,
  ) {
    return this.channels.completeWhatsappSignup(actor.workspaceId, dto);
  }

  @Get(':id')
  @RequiresFeature('conversationAi')
  get(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.get(actor.workspaceId, id);
  }

  /** No `@RequiresFeature` here — SMS vs. everything-else needs a different
   *  key, decided at runtime from `dto.type` (ChannelsService.create). */
  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CreateChannelDto) {
    return this.channels.create(actor.workspaceId, dto);
  }

  /** No `@RequiresFeature` here — see create() above; ChannelsService.update
   *  resolves the key from the existing channel's type. */
  @Patch(':id')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateChannelDto,
  ) {
    return this.channels.update(actor.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequiresFeature('conversationAi')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.remove(actor.workspaceId, id);
  }

  /** No `@RequiresFeature` here — see create() above; ChannelsService.verify
   *  resolves the key from the target channel's type. */
  @Post(':id/verify')
  @RequirePermission('settings.manage')
  verify(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.verify(actor.workspaceId, id);
  }

  /** İYS push-back registration (NetGSM Phase 2 Task 4) — SMS channel card
   *  action. No `@RequiresFeature` here — see create()/verify() above;
   *  ChannelsService.registerIysWebhook resolves the `sms` gate itself (İYS
   *  is bundled free with `campaigns` per the Phase 2 plan's Task 6, which
   *  lands the dedicated feature-gate wiring). */
  @Post(':id/iys/register-webhook')
  @RequirePermission('settings.manage')
  registerIysWebhook(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.registerIysWebhook(actor.workspaceId, id);
  }
}
