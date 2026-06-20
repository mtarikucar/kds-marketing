import {
  Controller,
  Get,
  Post,
  Patch,
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
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { ProductsService } from '../products/products.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ProductFilterDto,
} from '../dto/product.dto';

/**
 * Products catalog (GoHighLevel parity). Reads are leads.read (reps may pick
 * products when building deals/offers); catalog writes are leads.manage
 * (MANAGER+). Backend enforces both; the route is workspace-scoped via
 * MarketingGuard.
 */
@Controller('marketing/products')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload, @Query() filter: ProductFilterDto) {
    return this.products.list(a.workspaceId, filter);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.products.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('leads.manage')
  @Audit({ action: 'product.create', resourceType: 'product', captureBody: ['name'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateProductDto) {
    return this.products.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(a.workspaceId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission('leads.manage')
  archive(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.products.archive(a.workspaceId, id);
  }

  @Delete(':id')
  @RequirePermission('leads.manage')
  @Audit({ action: 'product.delete', resourceType: 'product' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.products.remove(a.workspaceId, id);
  }
}
