import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  EntitlementsService,
  TOGGLEABLE_MODULE_KEYS,
} from '../../billing/entitlements.service';
import { isProspectingConfigured } from '../prospecting/prospecting.config';
import { isSendingDomainsConfigured } from '../sending-domains/sending-domains.config';
import { isCustomDomainsEnabled } from '../custom-domains/custom-domains.config';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute, MarketingPublic } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { BillingService } from '../../billing/billing.service';
import { MarketingUserPayload } from '../types';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

export class CheckoutDto {
  @IsOptional() @IsString() @MaxLength(40)
  packageCode?: string;

  @IsOptional() @IsString() @MaxLength(40)
  addOnCode?: string;

  @IsOptional() @IsIn(['MONTHLY', 'YEARLY'])
  billingCycle?: 'MONTHLY' | 'YEARLY';

  @IsIn(['paytr', 'stripe', 'manual'])
  provider: 'paytr' | 'stripe' | 'manual';
}

export class SetModulesDto {
  /** The full set of module keys the workspace wants ACTIVE. */
  @IsArray()
  @IsString({ each: true })
  activatedModules: string[];
}

export class WalletTopupDto {
  @IsNumber()
  @Min(1)
  @Max(1_000_000)
  amount: number;

  @IsIn(['paytr', 'stripe', 'manual'])
  provider: 'paytr' | 'stripe' | 'manual';

  @IsOptional() @IsIn(['TRY', 'USD'])
  currency?: string;
}

/**
 * Workspace-facing billing surface. Reading the summary is open to every
 * member (the SPA gates features off it); spending money is OWNER-only.
 */
@MarketingRoute()
@Controller('marketing/billing')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Public pricing table — the register page renders it pre-auth. */
  @Get('packages')
  @MarketingPublic()
  packages() {
    return this.billing.listPackages();
  }

  @Get('summary')
  async summary(@CurrentMarketingUser() actor: MarketingUserPayload) {
    const s = (await this.billing.summary(actor.workspaceId)) as any;
    // Merge platform-level inert-feature capabilities (env-gated, global) into the
    // SAME features map the nav reads — so a not-enabled Epic-13 feature hides its
    // menu item instead of surfacing a button that 503s on click.
    const platform = {
      prospecting: isProspectingConfigured(),
      sendingDomains: isSendingDomainsConfigured(),
      customDomains: isCustomDomainsEnabled(),
    };
    return { ...s, entitlements: { ...s?.entitlements, features: { ...s?.entitlements?.features, ...platform } } };
  }

  @Get('orders')
  @MarketingRoles('OWNER')
  orders(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.billing.orders(actor.workspaceId);
  }

  /**
   * Set which toggleable modules are ACTIVE for this workspace (progressive
   * disclosure). Persists only keys that are both toggleable AND entitled, then
   * invalidates the entitlements cache so the nav + API gates update at once.
   */
  @Patch('modules')
  @MarketingRoles('OWNER')
  @RequirePermission('billing.manage')
  async setModules(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: SetModulesDto,
  ) {
    const eff = await this.entitlements.getEffective(actor.workspaceId);
    const entitled = new Set<string>(eff.entitledModules);
    const toggleable = new Set<string>(TOGGLEABLE_MODULE_KEYS as readonly string[]);
    const next = [...new Set(dto.activatedModules)].filter(
      (k) => toggleable.has(k) && entitled.has(k),
    );
    await this.prisma.workspace.update({
      where: { id: actor.workspaceId },
      data: { activatedModules: next },
    });
    this.entitlements.invalidate(actor.workspaceId);
    return { activatedModules: next };
  }

  @Post('checkout')
  @MarketingRoles('OWNER')
  @RequirePermission('billing.manage')
  checkout(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CheckoutDto,
    @Req() req: Request,
  ) {
    return this.billing.checkout(actor.workspaceId, dto, {
      buyerEmail: actor.email,
      buyerIp: getClientIp(req) ?? '127.0.0.1',
    });
  }

  /** Growth-wallet top-up (spec D2) — same money guards as checkout. */
  @Post('wallet-topup')
  @MarketingRoles('OWNER')
  @RequirePermission('billing.manage')
  walletTopup(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: WalletTopupDto,
    @Req() req: Request,
  ) {
    return this.billing.walletTopup(actor.workspaceId, dto, {
      buyerEmail: actor.email,
      buyerIp: getClientIp(req) ?? '127.0.0.1',
    });
  }
}
