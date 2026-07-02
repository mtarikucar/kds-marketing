import { Controller, Get, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { AccountCenterService } from './account-center.service';

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
}
