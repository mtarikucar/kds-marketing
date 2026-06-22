import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { PageFunnelsService } from '../page-funnels/page-funnels.service';
import { CreateFunnelDto, UpdateFunnelDto } from '../dto/page-funnel.dto';

/**
 * Multi-step funnels (GHL parity). MANAGER+ behind the `funnels` feature, the
 * same gate as Sites. settings.manage to mutate, leads.read to view (mirrors the
 * sites surface). CRUD is workspace-scoped in the service.
 */
@MarketingRoute()
@Controller('marketing/funnels')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('funnels')
export class MarketingFunnelsController {
  constructor(private readonly funnels: PageFunnelsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.funnels.list(a.workspaceId);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.funnels.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateFunnelDto) {
    return this.funnels.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateFunnelDto) {
    return this.funnels.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.funnels.remove(a.workspaceId, id);
  }
}
