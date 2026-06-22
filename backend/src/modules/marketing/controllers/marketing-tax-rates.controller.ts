import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { CreateTaxRateDto, UpdateTaxRateDto } from '../dto/tax-rate.dto';

/**
 * Tax rates (GHL parity). Reading is leads.read (the invoice/estimate editors
 * need the list); managing is settings.manage — tax config is workspace setup.
 */
@MarketingRoute()
@Controller('marketing/tax-rates')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingTaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.taxRates.list(a.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateTaxRateDto) {
    return this.taxRates.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    return this.taxRates.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.taxRates.archive(a.workspaceId, id);
  }
}
