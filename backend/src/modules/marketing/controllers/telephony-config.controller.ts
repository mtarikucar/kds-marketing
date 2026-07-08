import { Controller, Get, Put, Patch, Post, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { CallCdrSyncService } from '../telephony/call-cdr-sync.service';
import { UpsertTelephonyConfigDto, SetDahiliDto } from '../dto/telephony-config.dto';

@MarketingRoute()
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('telephony')
export class TelephonyConfigController {
  constructor(
    private readonly telephony: TelephonyConfigService,
    private readonly cdr: CallCdrSyncService,
  ) {}

  /** Diagnostic: run a raw NetGSM CDR fetch from prod (allow-listed IP) and
   *  return the raw response — confirms creds + reveals the real field shape. */
  @Post('cdr/test')
  @RequirePermission('settings.manage')
  cdrTest(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Body() dto: { startdate?: string; stopdate?: string },
  ) {
    return this.cdr.testFetch(a.workspaceId, dto?.startdate, dto?.stopdate);
  }

  /** Live verify: /balance auth probe (anywhere) + CDR fetch (prod IP only). */
  @Post('verify')
  @RequirePermission('settings.manage')
  async verify(@CurrentMarketingUser() a: MarketingUserPayload) {
    const creds = await this.telephony.verifyCreds(a.workspaceId);
    let cdr: unknown = { skipped: 'no active config' };
    if (creds.configured) {
      try {
        cdr = await this.cdr.testFetch(a.workspaceId);
      } catch (e: any) {
        cdr = { error: e?.message };
      }
    }
    return { ...creds, cdr };
  }

  @Get('config')
  get(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.telephony.get(a.workspaceId);
  }

  @Put('config')
  @RequirePermission('settings.manage')
  upsert(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: UpsertTelephonyConfigDto) {
    return this.telephony.upsert(a.workspaceId, dto);
  }

  @Patch('users/:id/dahili')
  @RequirePermission('settings.manage')
  setDahili(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: SetDahiliDto) {
    return this.telephony.setDahili(a.workspaceId, id, dto.dahili ?? null, dto.sipPassword, dto.phone);
  }
}

/** Rep-self webphone config: any authenticated telephony user reads their OWN dahili creds. */
@MarketingRoute()
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, FeatureGuard)
@RequiresFeature('telephony')
export class WebphoneConfigController {
  constructor(private readonly telephony: TelephonyConfigService) {}

  @Get('webphone-config')
  webphone(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.telephony.webphoneConfigFor(a.workspaceId, a.id);
  }
}
