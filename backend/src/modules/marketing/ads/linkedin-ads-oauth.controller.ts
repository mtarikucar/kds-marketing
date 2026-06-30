import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import type { Response } from 'express';
import { MarketingRoute, MarketingPublic } from '../decorators/marketing-public.decorator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { RequirePermission } from '../roles/require-permission.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { LinkedinAdsOAuthService } from './linkedin-ads-oauth.service';

class ConfirmLinkedinAdsDto {
  @IsArray()
  @IsString({ each: true })
  selected: string[];
}

/**
 * LinkedIn-for-Business (ads) OAuth endpoints for the ads module.
 * CRITICAL BOUNDARY: completely separate from the social-planner connect.
 * - POST linkedin/start              → returns authorizeUrl
 * - GET  linkedin/callback           → public; LinkedIn redirects here; we redirect to /ads?connect=<id>
 * - GET  linkedin/pending/:id        → list connectable ad accounts (no token)
 * - POST linkedin/pending/:id/confirm → provision the selected ad accounts
 */
@MarketingRoute()
@Controller('marketing/ads/oauth')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class LinkedinAdsOAuthController {
  constructor(private readonly svc: LinkedinAdsOAuthService) {}

  @Post('linkedin/start')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  start(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId);
  }

  @Get('linkedin/callback')
  @MarketingPublic()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(code, state);
      return res.redirect(302, `${appUrl}/ads?connect=${pendingId}&connect_provider=linkedin`);
    } catch {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
  }

  @Get('linkedin/pending/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('linkedin/pending/:id/confirm')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmLinkedinAdsDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, dto.selected);
  }
}
