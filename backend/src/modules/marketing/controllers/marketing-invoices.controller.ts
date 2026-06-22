import { Controller, Get, Post, Patch, Put, Body, Param, UseGuards } from '@nestjs/common';
import { IsObject, IsOptional, IsIn } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { InvoicesService } from '../invoicing/invoices.service';
import { InvoiceTextService } from '../invoicing/invoice-text.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from '../dto/invoice.dto';

class PspConfigDto {
  @IsIn(['STRIPE', 'MANUAL']) provider: string;
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsObject() configPublic?: Record<string, unknown>;
}

class TextToPayDto {
  @IsIn(['SMS', 'WHATSAPP']) channel: 'SMS' | 'WHATSAPP';
}

/** End-customer invoicing. MANAGER+ behind the `invoicing` feature. */
@MarketingRoute()
@Controller('marketing/invoices')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('invoicing')
export class MarketingInvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly invoiceText: InvoiceTextService,
  ) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) { return this.invoices.list(a.workspaceId); }
  @Post()
  @RequirePermission('settings.manage')
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateInvoiceDto) { return this.invoices.create(a.workspaceId, dto); }

  @Get('psp')
  getPsp(@CurrentMarketingUser() a: MarketingUserPayload) { return this.invoices.getPspConfig(a.workspaceId); }
  @Put('psp')
  @RequirePermission('settings.manage')
  setPsp(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: PspConfigDto) { return this.invoices.setPspConfig(a.workspaceId, dto); }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.get(a.workspaceId, id); }
  @Patch(':id')
  @RequirePermission('settings.manage')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) { return this.invoices.update(a.workspaceId, id, dto); }
  @Post(':id/send')
  @RequirePermission('settings.manage')
  send(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.send(a.workspaceId, id); }
  @Post(':id/mark-paid')
  @RequirePermission('settings.manage')
  markPaid(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.markPaid(a.workspaceId, id, 'manual'); }
  @Post(':id/void')
  @RequirePermission('settings.manage')
  voidInvoice(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.voidInvoice(a.workspaceId, id); }

  /** Settle the invoice fully from the contact's store-credit wallet. Gated on
   *  leads.manage — it debits a contact wallet, the same money permission the
   *  direct wallet credit/debit endpoints require (not just invoice settings). */
  @Post(':id/pay-with-wallet')
  @RequirePermission('leads.manage')
  payWithWallet(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.payWithWallet(a.workspaceId, id); }

  /** Text-to-pay: send the public pay link to the contact via SMS or WhatsApp. */
  @Post(':id/text-to-pay')
  @RequirePermission('settings.manage')
  textToPay(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: TextToPayDto,
  ) {
    return this.invoiceText.sendByText(a.workspaceId, id, dto.channel);
  }
}
