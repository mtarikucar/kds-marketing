import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentApiAuth } from '../decorators/current-api-auth.decorator';
import { Audit } from '../../audit/audit.decorator';
import { DevicesService } from './devices.service';

/**
 * The workspace half: a person pairing a phone and watching what it was asked
 * to do.
 *
 * MANAGER-gated throughout. A device is a thing that acts under the
 * workspace's name on somebody's real handset — with their WhatsApp, their
 * number, their contacts — so it belongs with the settings a manager owns, not
 * with the day-to-day surfaces every seat can reach.
 */
@MarketingRoute()
@Controller('marketing/devices')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingDevicesController {
  constructor(private readonly svc: DevicesService) {}

  @Get()
  list(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.svc.list(user.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  @Audit({ action: 'device.create', resourceType: 'device', captureBody: ['label', 'mode'] })
  create(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: { label: string; mode?: string; serial?: string },
  ) {
    return this.svc.create(user.workspaceId, dto, user.id);
  }

  /**
   * MANUAL → AUTO is the consequential one, which is why it is audited by name:
   * it is the moment a phone stops asking before it acts.
   */
  @Post(':id/mode')
  @RequirePermission('settings.manage')
  @Audit({ action: 'device.mode', resourceType: 'device', captureBody: ['mode'] })
  setMode(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: { mode: string },
  ) {
    return this.svc.setMode(user.workspaceId, id, dto.mode);
  }

  @Post(':id/status')
  @RequirePermission('settings.manage')
  @Audit({ action: 'device.status', resourceType: 'device', captureBody: ['status'] })
  setStatus(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: { status: string },
  ) {
    return this.svc.setStatus(user.workspaceId, id, dto.status);
  }

  @Post(':id/commands')
  @RequirePermission('settings.manage')
  @Audit({ action: 'device.command', resourceType: 'device', captureBody: ['kind'] })
  enqueue(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: { kind: string; args?: Record<string, unknown> },
  ) {
    return this.svc.enqueue(user.workspaceId, id, dto.kind, dto.args, {
      source: 'console',
      requestedBy: user.id,
    });
  }

  /** What this phone was asked to do, and what came of it. */
  @Get(':id/commands')
  history(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Param('id') id: string,
    @Query('take') take?: string,
  ) {
    return this.svc.history(user.workspaceId, id, take ? Number(take) : undefined);
  }
}

/**
 * The bridge half: the desktop app on somebody's laptop, with the cable.
 *
 * Authenticated by API KEY rather than a user session, deliberately. The bridge
 * runs unattended for hours next to a phone; asking it to hold a human's login
 * would mean either a session that never expires or a person re-authenticating
 * a background process all day. An API key is revocable from the console in one
 * click, which is the property that matters when the laptop is lost.
 *
 * Note what is NOT here: no endpoint that lists devices across workspaces, and
 * no endpoint that takes a device id without the key's workspace narrowing it.
 * A stolen key reaches exactly one workspace's phones.
 */
@MarketingRoute()
@Controller('marketing/device-bridge')
@UseGuards(ApiKeyGuard)
export class DeviceBridgeController {
  constructor(private readonly svc: DevicesService) {}

  /** "I am here, this is what is plugged into me." Also the liveness signal:
   *  a device with no recent beat is a cable that came out, and the console
   *  says so rather than leaving a command pending forever. */
  @Post(':id/heartbeat')
  heartbeat(
    @CurrentApiAuth() auth: { workspaceId: string },
    @Param('id') id: string,
    @Body() dto: { properties?: Record<string, unknown> },
  ) {
    return this.svc.heartbeat(auth.workspaceId, id, dto?.properties);
  }

  /** The next thing to do, or null. Claimed atomically — see the service. */
  @Post(':id/claim')
  claim(@CurrentApiAuth() auth: { workspaceId: string }, @Param('id') id: string) {
    return this.svc.claimNext(auth.workspaceId, id);
  }

  /** What happened. REFUSED is a first-class outcome: the person said no. */
  @Post('commands/:commandId/complete')
  complete(
    @CurrentApiAuth() auth: { workspaceId: string },
    @Param('commandId') commandId: string,
    @Body()
    dto: {
      status: 'DONE' | 'FAILED' | 'REFUSED';
      result?: Record<string, unknown>;
      error?: string;
      screenshotKey?: string;
    },
  ) {
    return this.svc.complete(auth.workspaceId, commandId, dto);
  }
}
