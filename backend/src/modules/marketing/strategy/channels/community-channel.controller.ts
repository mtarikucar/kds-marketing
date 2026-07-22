import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { MarketingGuard } from '../../guards/marketing.guard';
import { MarketingRolesGuard } from '../../guards/marketing-roles.guard';
import { PermissionsGuard } from '../../roles/permissions.guard';
import { RequirePermission } from '../../roles/require-permission.decorator';
import { MarketingRoles } from '../../decorators/marketing-roles.decorator';
import { MarketingRoute, MarketingPublic } from '../../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../../types';
import { Audit } from '../../../audit/audit.decorator';
import { signState, verifyState } from '../../social-planner/oauth/social-oauth-state.util';
import { CommunityChannelService } from './community-channel.service';

class ConnectDiscordDto {
  @IsString()
  webhookUrl: string;

  @IsOptional()
  @IsString()
  channelName?: string;
}

/**
 * Community channel connect surface for the Strategy Engine — a workspace connects
 * ITS OWN Discord server (Incoming Webhook) + Reddit account (OAuth) so the
 * COMMUNITY_ENGAGE executor posts to OWNED channels only. `discord`/`authorize`/
 * `list`/`disconnect` carry the same MANAGER + settings.manage/reports.read
 * audited stack as the strategy console. `reddit/callback` is PUBLIC because Reddit
 * redirects the browser to it with no Authorization header — it is bound to the
 * right tenant by the signed `state` (verified below), never logs code/token.
 */
@MarketingRoute()
@Controller('marketing/strategy/channels')
export class CommunityChannelController {
  constructor(private readonly svc: CommunityChannelService) {}

  @Get()
  @UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.svc.listConnections(a.workspaceId);
  }

  @Post('discord')
  @UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.channel.discord.connect', resourceType: 'community_channel' })
  connectDiscord(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: ConnectDiscordDto) {
    return this.svc.connectDiscord(a.workspaceId, dto.webhookUrl, dto.channelName);
  }

  @Get('reddit/authorize')
  @UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  redditAuthorize(@CurrentMarketingUser() a: MarketingUserPayload) {
    // Sign a short-lived, tamper-proof state carrying the tenant so the public
    // callback can bind the returned token to this workspace without a session.
    const state = signState({ workspaceId: a.workspaceId, network: 'REDDIT' });
    return this.svc.redditAuthorizeUrl(a.workspaceId, state);
  }

  @Get('reddit/callback')
  @MarketingPublic()
  async redditCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    const land = (q: string) => res.redirect(302, `${appUrl}/studio/strategy?${q}`);
    const payload = state ? verifyState(state) : null;
    if (error || !code || !payload || payload.network !== 'REDDIT') {
      return land('reddit=error');
    }
    try {
      await this.svc.handleRedditCallback(payload.workspaceId, code);
      return land('reddit=connected');
    } catch {
      return land('reddit=error');
    }
  }

  @Delete(':provider')
  @UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.channel.disconnect', resourceType: 'community_channel', resourceIdParam: 'provider' })
  disconnect(@CurrentMarketingUser() a: MarketingUserPayload, @Param('provider') provider: string) {
    return this.svc.disconnect(a.workspaceId, provider);
  }
}
