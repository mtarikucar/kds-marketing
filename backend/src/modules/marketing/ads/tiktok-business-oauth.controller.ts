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
import { IsArray, IsString, IsOptional, IsBoolean } from 'class-validator';
import type { Response } from 'express';
import { MarketingRoute, MarketingPublic } from '../decorators/marketing-public.decorator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { RequirePermission } from '../roles/require-permission.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TiktokBusinessOAuthService } from './tiktok-business-oauth.service';

class ConfirmTiktokBusinessDto {
  @IsArray()
  @IsString({ each: true })
  selected: string[];

  @IsOptional()
  @IsBoolean()
  enableMessaging?: boolean;
}

/**
 * TikTok-for-Business OAuth endpoints for the ads module.
 * CRITICAL BOUNDARY: completely separate from social-oauth.controller.
 * - POST tiktok/start             → returns authorizeUrl
 * - GET  tiktok/callback          → public; TikTok redirects here; we redirect to /ads?connect=<id>
 * - GET  tiktok/pending/:id       → list available advertisers (no token)
 * - POST tiktok/pending/:id/confirm → provision ad accounts + optional DM channel
 */
@MarketingRoute()
@Controller('marketing/ads/oauth')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class TiktokBusinessOAuthController {
  constructor(private readonly svc: TiktokBusinessOAuthService) {}

  @Post('tiktok/start')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  start(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId);
  }

  @Get('tiktok/callback')
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
      return res.redirect(302, `${appUrl}/ads?connect=${pendingId}`);
    } catch {
      return res.redirect(302, `${appUrl}/ads?connect_error=1`);
    }
  }

  @Get('tiktok/pending/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pending(
    @Param('id') id: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('tiktok/pending/:id/confirm')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmTiktokBusinessDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, {
      selected: dto.selected,
      enableMessaging: dto.enableMessaging,
    });
  }
}
