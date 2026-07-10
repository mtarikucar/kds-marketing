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
import { GoogleAdsOAuthService } from './google-ads-oauth.service';

class ConfirmGoogleAdsDto {
  @IsArray()
  @IsString({ each: true })
  selected: string[];
}

/**
 * Google-Ads OAuth endpoints for the ads module (mirrors the LinkedIn trio).
 * - POST google/start               → returns authorizeUrl
 * - GET  google/callback            → public; Google redirects here → /ads?connect=<id>
 * - GET  google/pending/:id         → list connectable customers (no token)
 * - POST google/pending/:id/confirm → provision the selected customers
 */
@MarketingRoute()
@Controller('marketing/ads/oauth')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class GoogleAdsOAuthController {
  constructor(private readonly svc: GoogleAdsOAuthService) {}

  @Post('google/start')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  start(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId);
  }

  @Get('google/callback')
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
      return res.redirect(302, `${appUrl}/ads?connect=${pendingId}&connect_provider=google`);
    } catch {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
  }

  @Get('google/pending/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('google/pending/:id/confirm')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmGoogleAdsDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, dto.selected);
  }
}
