import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsString, ArrayMaxSize } from 'class-validator';
import type { Response } from 'express';
import { MarketingGuard } from '../../guards/marketing.guard';
import { MarketingRolesGuard } from '../../guards/marketing-roles.guard';
import { MarketingRoles } from '../../decorators/marketing-roles.decorator';
import { MarketingRoute, MarketingPublic } from '../../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../../types';
import { SocialOAuthService } from './social-oauth.service';

class ConfirmDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  selected: string[];
}

/**
 * OAuth connect endpoints for the social planner. `start`/`pending`/`confirm`
 * are authenticated (MANAGER); `callback` is public because the provider
 * redirects the browser to it with no Authorization header — it does nothing
 * without a valid signed `state`. Never logs code/token/state.
 */
@MarketingRoute()
@Controller('marketing/social/oauth')
export class SocialOAuthController {
  constructor(private readonly svc: SocialOAuthService) {}

  @Post(':network/start')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  start(
    @Param('network') network: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.start(u.workspaceId, network.toUpperCase());
  }

  @Get(':network/callback')
  @MarketingPublic()
  async callback(
    @Param('network') network: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    // The marketing console (where /social lives) is FRONTEND_URL
    // (https://marketing.hummytummy.com) — NOT APP_URL, which is the core product.
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/social?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(network.toUpperCase(), code, state);
      return res.redirect(302, `${appUrl}/social?connect=${pendingId}`);
    } catch {
      return res.redirect(302, `${appUrl}/social?connect_error=1`);
    }
  }

  @Get('pending/:id')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('pending/:id/confirm')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, dto.selected);
  }
}
