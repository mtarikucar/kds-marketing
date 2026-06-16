import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingDistributionService } from '../services/marketing-distribution.service';
import { UpdateDistributionConfigDto } from '../dto/update-distribution-config.dto';
import { MarketingUserPayload } from '../types';

@Controller('marketing/distribution-config')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
@MarketingRoles('MANAGER')
export class MarketingDistributionController {
  constructor(private readonly service: MarketingDistributionService) {}

  @Get()
  get(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.service.get(actor.workspaceId);
  }

  @Patch()
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: UpdateDistributionConfigDto,
  ) {
    return this.service.update(actor.workspaceId, dto.strategy ?? 'DISABLED', actor.id);
  }
}
