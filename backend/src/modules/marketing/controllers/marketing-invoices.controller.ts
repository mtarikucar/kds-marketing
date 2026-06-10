import { Controller, Get, Post, Patch, Put, Body, Param, UseGuards } from '@nestjs/common';
import { IsArray, IsObject, IsOptional, IsString, IsIn, IsInt, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { InvoicesService } from '../invoicing/invoices.service';

class CreateInvoiceDto {
  @IsOptional() @IsString() @MaxLength(64) leadId?: string;
  @IsArray() items: { description: string; qty: number; unitPrice: number }[];
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() dueDate?: string;
}
class UpdateInvoiceDto {
  @IsOptional() @IsArray() items?: unknown[];
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsString() dueDate?: string;
}
class PspConfigDto {
  @IsIn(['STRIPE', 'MANUAL']) provider: string;
  @IsOptional() @IsObject() secrets?: Record<string, string>;
  @IsOptional() @IsObject() configPublic?: Record<string, unknown>;
}

/** End-customer invoicing. MANAGER+ behind the `invoicing` feature. */
@MarketingRoute()
@Controller('marketing/invoices')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('invoicing')
export class MarketingInvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  list(@CurrentMarketingUser() a: MarketingUserPayload) { return this.invoices.list(a.workspaceId); }
  @Post()
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateInvoiceDto) { return this.invoices.create(a.workspaceId, dto); }

  @Get('psp')
  getPsp(@CurrentMarketingUser() a: MarketingUserPayload) { return this.invoices.getPspConfig(a.workspaceId); }
  @Put('psp')
  setPsp(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: PspConfigDto) { return this.invoices.setPspConfig(a.workspaceId, dto); }

  @Get(':id')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.get(a.workspaceId, id); }
  @Patch(':id')
  update(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpdateInvoiceDto) { return this.invoices.update(a.workspaceId, id, dto); }
  @Post(':id/send')
  send(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.send(a.workspaceId, id); }
  @Post(':id/mark-paid')
  markPaid(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.markPaid(a.workspaceId, id, 'manual'); }
  @Post(':id/void')
  voidInvoice(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) { return this.invoices.voidInvoice(a.workspaceId, id); }
}
