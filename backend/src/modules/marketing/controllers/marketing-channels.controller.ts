import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  NotFoundException,
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
import { MailOpsService } from '../channels/ops/mail-ops.service';
import {
  InboundItemService,
  InboundItemState,
} from '../channels/inbound/inbound-item.service';
import { CreateChannelDto, UpdateChannelDto, WhatsappEmbeddedSignupDto } from '../dto/channel.dto';

/** The ledger states a client may filter on. An unknown value is dropped
 *  rather than forwarded — a filter nobody can match would answer "nothing
 *  went wrong" for a mailbox full of parked mail. */
const INBOUND_STATES: readonly string[] = ['NEW', 'DONE', 'SKIPPED', 'FAILED', 'QUARANTINED'];

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
  constructor(
    private readonly channels: ChannelsService,
    private readonly mailOps: MailOpsService,
    private readonly inboundItems: InboundItemService,
  ) {}

  @Get()
  @RequiresFeature('conversationAi')
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.channels.list(actor.workspaceId);
  }

  /**
   * "Why did nothing send?" — the whole answer in one call.
   *
   * Sender identity and what is degrading it, the send/bounce/complaint
   * numbers, per-mailbox send and receive health, today's platform cap,
   * suppression counts, and **the list of env-gated features this deployment
   * currently leaves inert**. That last part is the cheapest thing in this
   * package and the one that most often ends the conversation: a mailbox
   * OAuth button that does nothing because `GOOGLE_MAIL_CLIENT_ID` was never
   * mapped looks identical to a bug until something names the key.
   *
   * No `@RequiresFeature`: a workspace whose plan does NOT include the
   * conversation features still sends campaign, booking and invoice mail, and
   * gating the explanation behind the feature that is switched off is exactly
   * how a tenant ends up with silence and no reason for it. `settings.manage`
   * is the floor because the payload names mailbox addresses and error strings.
   *
   * Declared BEFORE the `:id` route so the static path isn't captured by it.
   */
  @Get('email/health')
  @RequirePermission('settings.manage')
  emailHealth(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.mailOps.health(actor.workspaceId);
  }

  /** One mailbox's inbound ledger — what arrived, what was skipped and why,
   *  and what is parked waiting for a human. The card's list. */
  @Get(':id/inbound-items')
  @RequirePermission('settings.manage')
  listInboundItems(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Query('state') state?: string,
  ) {
    const wanted = INBOUND_STATES.includes(state ?? '') ? (state as InboundItemState) : undefined;
    return this.inboundItems.listForChannel(actor.workspaceId, id, {
      ...(wanted ? { state: wanted } : {}),
    });
  }

  /**
   * "Tekrar dene" — requeue one quarantined item.
   *
   * The channel in the path is checked against the row rather than trusted:
   * the ledger read is already workspace-scoped, so this is not an isolation
   * hole, but a card left open while a mailbox was reconnected would otherwise
   * silently retry a different mailbox's backlog. A refusal (`no-replayer`,
   * a row that vanished) becomes a 404 instead of an `{ok:false}` the UI would
   * render as success.
   */
  @Post(':id/inbound-items/:itemId/retry')
  @RequirePermission('settings.manage')
  async retryInboundItem(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    const row = await this.inboundItems.get(actor.workspaceId, itemId);
    if (!row || row.channelId !== id) throw new NotFoundException('Inbound item not found');
    const result = await this.inboundItems.retry(actor.workspaceId, itemId);
    if (!result.ok) throw new NotFoundException('That item cannot be retried');
    return result;
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

  /** İYS push-back registration (NetGSM Phase 2 Task 4, gate reconciled in
   *  Task 6) — SMS channel card action. No `@RequiresFeature` here — like
   *  create()/verify() above, ChannelsService.registerIysWebhook resolves its
   *  own gate; unlike those, it checks `campaigns` (not `sms`) since İYS is
   *  bundled free with `campaigns` per the Phase 2 plan's owner decision. */
  @Post(':id/iys/register-webhook')
  @RequirePermission('settings.manage')
  registerIysWebhook(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.channels.registerIysWebhook(actor.workspaceId, id);
  }
}
