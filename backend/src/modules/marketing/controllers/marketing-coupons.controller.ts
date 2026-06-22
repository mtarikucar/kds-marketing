import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { CouponsService } from '../coupons/coupons.service';
import { CreateCouponDto, UpdateCouponDto } from '../dto/coupon.dto';

/** Discount coupons (GHL parity). MANAGER + settings.manage — checkout config. */
@MarketingRoute()
@Controller('marketing/coupons')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingCouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  @RequirePermission('campaigns.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.coupons.list(a.workspaceId);
  }

  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateCouponDto) {
    return this.coupons.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCouponDto,
  ) {
    return this.coupons.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('settings.manage')
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.coupons.remove(a.workspaceId, id);
  }
}
