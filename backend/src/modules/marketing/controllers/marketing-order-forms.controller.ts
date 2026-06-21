import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
import { OrderFormsService } from '../order-forms/order-forms.service';
import { CreateOrderFormDto, UpdateOrderFormDto } from '../dto/order-form.dto';

/**
 * Order forms config (GoHighLevel parity). Read is leads.read; create/edit/delete
 * are leads.manage (an order form takes payment — manager-gated). The buyer flow
 * is the separate public controller.
 */
@Controller('marketing/order-forms')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingOrderFormsController {
  constructor(private readonly orderForms: OrderFormsService) {}

  @Get()
  @RequirePermission('leads.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.orderForms.list(a.workspaceId);
  }

  @Get(':id')
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.orderForms.get(a.workspaceId, id);
  }

  @Post()
  @RequirePermission('leads.manage')
  @Audit({ action: 'order_form.create', resourceType: 'order_form', captureBody: ['name'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateOrderFormDto) {
    return this.orderForms.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @RequirePermission('leads.manage')
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOrderFormDto,
  ) {
    return this.orderForms.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('leads.manage')
  @Audit({ action: 'order_form.delete', resourceType: 'order_form' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.orderForms.remove(a.workspaceId, id);
  }
}
