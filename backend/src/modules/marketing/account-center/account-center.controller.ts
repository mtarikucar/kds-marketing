import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsOptional, IsString, ArrayMaxSize } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { AccountCenterService, Capability } from './account-center.service';

class DisconnectDto {
  /** Optional — remove only these capabilities from the identity (e.g. drop INBOX
   *  but keep PUBLISH). Omitted = disconnect the whole identity. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(8)
  capabilities?: string[];
}

/**
 * Account Center read-model. MANAGER/OWNER only. Intentionally NOT gated on
 * conversationAi — the hub must render for every plan (it reports the feature
 * flag so the UI can upsell); the entitlement gate lives only on the inbox
 * *actions* (channel provisioning), not on reading the connection list.
 */
@MarketingRoute()
@Controller('marketing/connections')
export class AccountCenterController {
  constructor(private readonly svc: AccountCenterService) {}

  @Get()
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.getConnections(u.workspaceId);
  }

  // identityKey is URL-encoded by the SPA; Express decodes the path param.
  @Delete(':identityKey')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  disconnect(
    @Param('identityKey') identityKey: string,
    @Body() dto: DisconnectDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.disconnect(u.workspaceId, identityKey, dto?.capabilities as Capability[] | undefined);
  }

  @Post(':identityKey/reauth')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  reauth(@Param('identityKey') identityKey: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.reauth(u.workspaceId, identityKey);
  }
}
