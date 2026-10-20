import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { IsString, Matches } from 'class-validator';
import { MarketingGuard } from '../../guards/marketing.guard';
import { MarketingRolesGuard } from '../../guards/marketing-roles.guard';
import { PermissionsGuard } from '../../roles/permissions.guard';
import { RequirePermission } from '../../roles/require-permission.decorator';
import { MarketingPublic, MarketingRoute } from '../../decorators/marketing-public.decorator';
import { MarketingRoles } from '../../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../../types';
import { Audit } from '../../../audit/audit.decorator';
import { ga4SyncEnabled } from './ga4.flag';
import { GA4_ERR, Ga4OAuthService } from './ga4-oauth.service';
import { Ga4SyncService } from './ga4-sync.service';

/** With GA4_SYNC_ENABLED off every GA4 route answers like one that does not exist. */
@Injectable()
export class Ga4EnabledGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (ga4SyncEnabled()) return true;
    const req = context.switchToHttp().getRequest<Request>();
    throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
  }
}

class SelectPropertyDto {
  @IsString() @Matches(/^properties\/\d{1,20}$/) propertyId!: string;
}

/**
 * Workspace GA4 connection (contract §6.1). MANAGER+, like every other
 * workspace-level integration; changes need settings.manage.
 */
@MarketingRoute()
@Controller('marketing/integrations/ga4')
@UseGuards(Ga4EnabledGuard, MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class Ga4OAuthController {
  constructor(
    private readonly oauth: Ga4OAuthService,
    private readonly sync: Ga4SyncService,
  ) {}

  @Get('status')
  status(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.oauth.status(u.workspaceId);
  }

  /** The Google consent URL for the panel to open; the grant is tied to this user + workspace. */
  @Get('connect')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ga4.connect', resourceType: 'ga4-connection' })
  connect(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.oauth.connectUrl(u.workspaceId, u.id);
  }

  @Get('properties')
  properties(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.oauth.listProperties(u.workspaceId);
  }

  @Post('property')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ga4.select-property', resourceType: 'ga4-connection' })
  selectProperty(@CurrentMarketingUser() u: MarketingUserPayload, @Body() dto: SelectPropertyDto) {
    return this.oauth.selectProperty(u.workspaceId, dto.propertyId);
  }

  /** Pull now instead of waiting for the hourly sync. */
  @Post('sync')
  @RequirePermission('settings.manage')
  syncNow(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.sync.syncWorkspace(u.workspaceId);
  }

  @Delete()
  @RequirePermission('settings.manage')
  @Audit({ action: 'ga4.disconnect', resourceType: 'ga4-connection' })
  disconnect(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.oauth.disconnect(u.workspaceId);
  }
}

/**
 * Google redirects the BROWSER here after consent. The exchange is finished and
 * the browser sent back to the Integrations tab with a result flag and, on
 * failure, only a coarse `reason` — the precise message stays in our logs.
 */
@MarketingRoute()
@Controller('marketing/integrations/ga4')
@UseGuards(Ga4EnabledGuard, MarketingGuard)
export class Ga4PublicController {
  private readonly logger = new Logger(Ga4PublicController.name);

  constructor(private readonly oauth: Ga4OAuthService) {}

  @Get('callback')
  @MarketingPublic()
  @Throttle({ default: { limit: 30, ttl: 60_000, blockDuration: 60_000 } })
  async callback(
    @Query('state') state: string,
    @Query('code') code: string,
    @Query('error') error: string,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      // The user declined, or Google refused before any code was issued.
      const reason = /^[a-z_]{1,40}$/.test(error) ? error : 'denied';
      res.redirect(302, this.oauth.panelUrl(`/settings/connections?ga4=error&reason=${reason}`));
      return;
    }
    try {
      await this.oauth.handleCallback(state, code);
      res.redirect(302, this.oauth.panelUrl('/settings/connections?ga4=connected'));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      const reason = ga4CallbackReason(message);
      this.logger.warn(`GA4 callback failed (${reason}): ${message}`);
      res.redirect(302, this.oauth.panelUrl(`/settings/connections?ga4=error&reason=${reason}`));
    }
  }
}

/** A failure message → the coarse, non-sensitive reason the panel turns into a hint. */
export function ga4CallbackReason(message: string): string {
  if (message.startsWith(GA4_ERR.exchangeFailed)) {
    const detail = message.slice(GA4_ERR.exchangeFailed.length).replace(/^:\s*/, '');
    return detail ? `exchange_${detail}` : 'exchange_failed';
  }
  switch (message) {
    case GA4_ERR.invalidState:
      return 'state_invalid';
    case GA4_ERR.missingCode:
      return 'missing_code';
    case GA4_ERR.noRefreshToken:
      return 'no_refresh_token';
    case GA4_ERR.notConfigured:
      return 'not_configured';
    default:
      return 'failed';
  }
}
