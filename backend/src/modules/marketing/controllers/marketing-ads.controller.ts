import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { AdAccountService } from '../ads/ad-account.service';
import {
  ConnectAdAccountDto,
  AdMetricsQueryDto,
  PullAdAccountDto,
} from '../dto/ad-account.dto';

/**
 * Ad reporting (GoHighLevel parity): each workspace connects its OWN Meta/TikTok
 * ad account (per-tenant sealed token) and reads aggregated spend/impressions/
 * clicks/leads. Connecting/removing/pulling is workspace config → MANAGER+ via
 * `settings.manage`, mirroring channel settings. Reading metrics is reporting →
 * `reports.read` (REP-capable, like the other reports). The sealed token is
 * never echoed back. `/status` reports which provider apps the platform has
 * configured (env-gated) so the UI can disable unavailable providers.
 */
@MarketingRoute()
@Controller('marketing/ads')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingAdsController {
  constructor(private readonly adAccounts: AdAccountService) {}

  /** Which provider apps the platform has configured (global app creds). */
  @Get('status')
  @RequirePermission('reports.read')
  status() {
    return this.adAccounts.status();
  }

  /** Connected accounts for this workspace (no sealed token in the response). */
  @Get('accounts')
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.adAccounts.list(a.workspaceId);
  }

  /** Aggregated metrics over a date range (defaults to the trailing 30 days). */
  @Get('metrics')
  @RequirePermission('reports.read')
  metrics(@CurrentMarketingUser() a: MarketingUserPayload, @Query() q: AdMetricsQueryDto) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from =
      q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    return this.adAccounts.getMetrics(a.workspaceId, from, to, q.provider);
  }

  @Post('accounts')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_account.connect', resourceType: 'ad_account' })
  connect(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: ConnectAdAccountDto) {
    return this.adAccounts.connect(a.workspaceId, dto);
  }

  @Delete('accounts/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_account.disconnect', resourceType: 'ad_account' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.adAccounts.remove(a.workspaceId, id);
  }

  /** Manual on-demand refresh for one account (trailing `days`, default 7). */
  @Post('accounts/:id/pull')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pull(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: PullAdAccountDto,
  ) {
    return this.adAccounts.pullNow(a.workspaceId, id, dto.days ?? 7);
  }
}
