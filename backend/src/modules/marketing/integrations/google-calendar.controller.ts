import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
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
import {
  MarketingPublic,
  MarketingRoute,
} from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { GoogleCalendarService, GCAL_ERR } from './google-calendar.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';

class ConnectQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  calendarId?: string;
}

/**
 * Env-gated Google Calendar admin surface — OWNER/MANAGER only; mutations are
 * audited; OAuth tokens are sealed at rest and NEVER echoed (responses carry
 * only `tokenSet`/`syncEnabled` flags). When the feature is inert (env OAuth
 * client or secret-box missing) `connect` returns a clean 400 ("Google Calendar
 * not configured"); `status` still answers with `configured:false`.
 */
@MarketingRoute()
@Controller('marketing/integrations/google-calendar')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
// 'MANAGER' is the floor — the hierarchical guard admits MANAGER and OWNER and
// rejects REP (co-listing OWNER would raise the bar to OWNER-only).
@MarketingRoles('MANAGER')
export class GoogleCalendarController {
  constructor(
    private readonly svc: GoogleCalendarService,
    private readonly sync: GoogleCalendarSyncService,
  ) {}

  /** Feature + connection status for the admin UI. */
  @Get('status')
  status(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.status(u.workspaceId);
  }

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  /**
   * Begin the OAuth round-trip: returns the Google consent URL (JSON) for the
   * SPA to open. The grant is attributed to THIS user + workspace via state.
   */
  @Get('connect')
  @Audit({ action: 'google-calendar.connect', resourceType: 'google-calendar-connection' })
  connect(
    @Query() q: ConnectQueryDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    const { url } = this.svc.getAuthUrl(u.workspaceId, u.id, q.calendarId);
    return { url };
  }

  /** Manually trigger an incremental pull for the workspace (admin button). */
  @Post('sync')
  @Audit({ action: 'google-calendar.sync', resourceType: 'google-calendar-connection' })
  @RequirePermission('settings.manage')
  syncNow(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.sync.pullWorkspace(u.workspaceId);
  }

  @Delete(':id')
  @Audit({ action: 'google-calendar.disconnect', resourceType: 'google-calendar-connection', resourceIdParam: 'id' })
  @RequirePermission('settings.manage')
  disconnect(
    @Param('id') id: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.disconnect(u.workspaceId, id);
  }
}

const CALLBACK_THROTTLE = {
  default: { limit: 30, ttl: 60_000, blockDuration: 60_000 },
};
const WEBHOOK_THROTTLE = {
  default: { limit: 120, ttl: 60_000, blockDuration: 60_000 },
};

/**
 * PUBLIC Google endpoints (no marketing token):
 *  - the OAuth callback (Google redirects the browser here with code+state),
 *  - the push-webhook receiver (Google POSTs change notifications here with
 *    X-Goog-Channel-Id / X-Goog-Resource-Id headers).
 *
 * The webhook validates the channel/resource against the stored connection and
 * answers 200 regardless (Google retries on non-2xx) — an unknown channel is
 * simply ignored, never surfaced.
 */
@MarketingRoute()
@Controller('marketing/integrations/google-calendar')
@UseGuards(MarketingGuard)
export class GoogleCalendarPublicController {
  private readonly logger = new Logger(GoogleCalendarPublicController.name);

  constructor(
    private readonly svc: GoogleCalendarService,
    private readonly sync: GoogleCalendarSyncService,
  ) {}

  /**
   * Google redirects the BROWSER here after consent. We finish the exchange and
   * 302 back into the SPA connections page with a result flag — never raw JSON
   * in the user's face. On failure we log the exact step server-side (no tokens
   * in those messages) and pass only a coarse `reason` code to the SPA, so the
   * user gets an actionable toast and the operator can diagnose from logs.
   */
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
      res.redirect(
        302,
        this.svc.panelUrl('/settings/connections?gcal=connected'),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      const reason = gcalCallbackReason(message);
      this.logger.warn(`Google Calendar callback failed (${reason}): ${message}`);
      res.redirect(
        302,
        this.svc.panelUrl(`/settings/connections?gcal=error&reason=${reason}`),
      );
    }
  }

  @Post('notifications')
  @MarketingPublic()
  @HttpCode(200)
  @Throttle(WEBHOOK_THROTTLE)
  async notifications(
    @Headers('x-goog-channel-id') channelId: string,
    @Headers('x-goog-resource-id') resourceId: string,
    @Headers('x-goog-resource-state') resourceState: string,
  ): Promise<{ ok: boolean }> {
    // Google's initial "sync" ping after watch creation carries no changes.
    if (resourceState === 'sync') return { ok: true };
    await this.sync
      .pullByChannel(channelId, resourceId)
      .catch(() => undefined);
    return { ok: true };
  }
}

/**
 * Map an OAuth-flow failure message to a coarse, non-sensitive `reason` code the
 * SPA can turn into an actionable toast. Driven off the shared GCAL_ERR strings
 * (single source of truth) so the thrower and this mapper can't drift.
 */
function gcalCallbackReason(message: string): string {
  // Token-exchange failures may carry Google's precise OAuth error code
  // ("Google code exchange failed: invalid_client") — forward it as
  // `exchange_<code>` so the SPA can show an actionable hint. The code is a
  // clean [a-z_] token (sanitised at the source), never a secret.
  if (message.startsWith(GCAL_ERR.exchangeFailed)) {
    const detail = message.slice(GCAL_ERR.exchangeFailed.length).replace(/^:\s*/, '');
    return detail ? `exchange_${detail}` : 'exchange_failed';
  }
  switch (message) {
    case GCAL_ERR.notConfigured:
      return 'not_configured';
    case GCAL_ERR.invalidState:
      return 'state_invalid';
    case GCAL_ERR.missingCode:
      return 'missing_code';
    case GCAL_ERR.noRefreshToken:
      return 'no_refresh_token';
    default:
      return 'unknown';
  }
}
