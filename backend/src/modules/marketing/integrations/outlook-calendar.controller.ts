import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
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
import { OutlookCalendarSyncService } from './outlook-calendar-sync.service';

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
  constructor(
    private readonly svc: OutlookCalendarService,
    private readonly sync: OutlookCalendarSyncService,
  ) {}

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

  @Post('sync')
  @Audit({ action: 'outlook-calendar.sync', resourceType: 'outlook-calendar-connection' })
  @RequirePermission('settings.manage')
  syncNow(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.sync.pullWorkspace(u.workspaceId);
  }

  @Delete(':id')
  @Audit({ action: 'outlook-calendar.disconnect', resourceType: 'outlook-calendar-connection', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  async disconnect(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    // Stop the Graph subscription first (best-effort) so we don't leave an
    // orphaned notification stream pointing at our webhook after the row is gone.
    const row = await this.svc.owned(u.workspaceId, id);
    await this.sync.stopSubscription(row).catch(() => undefined);
    return this.svc.disconnect(u.workspaceId, id);
  }
}

const CALLBACK_THROTTLE = { default: { limit: 30, ttl: 60_000, blockDuration: 60_000 } };

/**
 * PUBLIC Outlook OAuth callback (no marketing token): Microsoft redirects the
 * BROWSER here with code+state. We finish the exchange and 302 back into the SPA
 * connections page with a coarse result flag — never raw JSON, never a token.
 */
const WEBHOOK_THROTTLE = { default: { limit: 240, ttl: 60_000, blockDuration: 60_000 } };

@MarketingRoute()
@Controller('marketing/integrations/outlook-calendar')
@UseGuards(MarketingGuard)
export class OutlookCalendarPublicController {
  private readonly logger = new Logger(OutlookCalendarPublicController.name);

  constructor(
    private readonly svc: OutlookCalendarService,
    private readonly sync: OutlookCalendarSyncService,
  ) {}

  @Get('callback')
  @MarketingPublic()
  @Throttle(CALLBACK_THROTTLE)
  async callback(
    @Query('state') state: string,
    @Query('code') code: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const conn = await this.svc.handleCallback(state, code);
      // Activate the real-time change-notification subscription on the
      // just-connected calendar (best-effort; manual sync still works if the
      // webhook isn't publicly reachable). Never block the redirect.
      await this.sync.ensureSubscription(conn.workspaceId, conn.id).catch(() => undefined);
      res.redirect(302, this.svc.panelUrl('/settings/connections?outlook=connected'));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      const reason = outlookCallbackReason(message);
      this.logger.warn(`Outlook Calendar callback failed (${reason}): ${message}`);
      res.redirect(302, this.svc.panelUrl(`/settings/connections?outlook=error&reason=${reason}`));
    }
  }

  /**
   * Graph change-notification receiver (public; no marketing token).
   *  - Subscription-validation handshake: Graph POSTs `?validationToken=…` on
   *    create and expects the raw token echoed back as text/plain 200 within 10s.
   *  - Change notifications: `{ value: [{ subscriptionId, clientState, … }] }`.
   *    We ACK 202 immediately, then run an idempotent delta pull per (validated)
   *    subscription. clientState is verified inside pullBySubscription, so a
   *    forged notification simply no-ops.
   */
  @Post('notifications')
  @MarketingPublic()
  @Throttle(WEBHOOK_THROTTLE)
  async notifications(
    @Query('validationToken') validationToken: string | undefined,
    @Body() body: { value?: Array<{ subscriptionId?: string; clientState?: string }> },
    @Res() res: Response,
  ): Promise<void> {
    if (validationToken) {
      // Echo the token verbatim — this is how Graph confirms the endpoint.
      res.status(200).type('text/plain').send(validationToken);
      return;
    }
    res.status(202).send();
    const notes = Array.isArray(body?.value) ? body.value : [];
    // De-dupe so a burst about one calendar triggers a single delta pull.
    const seen = new Set<string>();
    for (const n of notes) {
      const subId = n?.subscriptionId;
      if (!subId || seen.has(subId)) continue;
      seen.add(subId);
      this.sync.pullBySubscription(subId, n?.clientState).catch(() => undefined);
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
