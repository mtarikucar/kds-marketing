import {
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingPublic, MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { OutlookCalendarService, OUTLOOK_ERR } from './outlook-calendar.service';

class ConnectQueryDto {
  @IsOptional() @IsString() @MaxLength(256)
  calendarId?: string;
}

/**
 * Env-gated Outlook/O365 Calendar admin surface (Epic 12) — OWNER/MANAGER only;
 * mutations audited; OAuth tokens sealed at rest and NEVER echoed. Inert (env
 * OAuth client or secret-box missing) ⇒ `connect` returns a clean 400; `status`
 * still answers with `configured:false`. Mirrors the Google Calendar surface.
 */
@MarketingRoute()
@Controller('marketing/integrations/outlook-calendar')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class OutlookCalendarController {
  constructor(private readonly svc: OutlookCalendarService) {}

  @Get('status')
  status(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.status(u.workspaceId);
  }

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Get('connect')
  @Audit({ action: 'outlook-calendar.connect', resourceType: 'outlook-calendar-connection' })
  connect(@Query() q: ConnectQueryDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    const { url } = this.svc.getAuthUrl(u.workspaceId, u.id, q.calendarId);
    return { url };
  }

  @Delete(':id')
  @Audit({ action: 'outlook-calendar.disconnect', resourceType: 'outlook-calendar-connection', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  disconnect(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.disconnect(u.workspaceId, id);
  }
}

const CALLBACK_THROTTLE = { default: { limit: 30, ttl: 60_000, blockDuration: 60_000 } };

/**
 * PUBLIC Outlook OAuth callback (no marketing token): Microsoft redirects the
 * BROWSER here with code+state. We finish the exchange and 302 back into the SPA
 * connections page with a coarse result flag — never raw JSON, never a token.
 */
@MarketingRoute()
@Controller('marketing/integrations/outlook-calendar')
@UseGuards(MarketingGuard)
export class OutlookCalendarPublicController {
  private readonly logger = new Logger(OutlookCalendarPublicController.name);

  constructor(private readonly svc: OutlookCalendarService) {}

  @Get('callback')
  @MarketingPublic()
  @Throttle(CALLBACK_THROTTLE)
  async callback(
    @Query('state') state: string,
    @Query('code') code: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.svc.handleCallback(state, code);
      res.redirect(302, this.svc.panelUrl('/settings/connections?outlook=connected'));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      const reason = outlookCallbackReason(message);
      this.logger.warn(`Outlook Calendar callback failed (${reason}): ${message}`);
      res.redirect(302, this.svc.panelUrl(`/settings/connections?outlook=error&reason=${reason}`));
    }
  }
}

function outlookCallbackReason(message: string): string {
  if (message.startsWith(OUTLOOK_ERR.exchangeFailed)) {
    const detail = message.slice(OUTLOOK_ERR.exchangeFailed.length).replace(/^:\s*/, '');
    return detail ? `exchange_${detail}` : 'exchange_failed';
  }
  switch (message) {
    case OUTLOOK_ERR.notConfigured:
      return 'not_configured';
    case OUTLOOK_ERR.invalidState:
      return 'state_invalid';
    case OUTLOOK_ERR.missingCode:
      return 'missing_code';
    case OUTLOOK_ERR.noRefreshToken:
      return 'no_refresh_token';
    default:
      return 'unknown';
  }
}
