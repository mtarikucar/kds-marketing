import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { WalletService } from '../wallet/wallet.service';
import { WalletAdjustDto } from '../dto/wallet.dto';

/**
 * Customer store-credit wallet (GHL parity). Reading a wallet is leads.read;
 * crediting/debiting is leads.manage (a money action — managers only). Scoped to
 * a workspace contact (leadId).
 */
@MarketingRoute()
@Controller('marketing/contacts/:leadId/wallet')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @RequirePermission('leads.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('leadId') leadId: string) {
    return this.wallet.getWallet(a.workspaceId, leadId);
  }

  @Post('credit')
  @RequirePermission('leads.manage')
  @Audit({ action: 'wallet.credit', resourceType: 'wallet' })
  credit(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('leadId') leadId: string,
    @Body() dto: WalletAdjustDto,
  ) {
    return this.wallet.credit(a.workspaceId, leadId, dto.amount, dto.note, 'MANUAL_ADJUST');
  }

  @Post('debit')
  @RequirePermission('leads.manage')
  @Audit({ action: 'wallet.debit', resourceType: 'wallet' })
  debit(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('leadId') leadId: string,
    @Body() dto: WalletAdjustDto,
  ) {
    return this.wallet.debit(a.workspaceId, leadId, dto.amount, dto.note, { reason: 'MANUAL_ADJUST' });
  }
}
