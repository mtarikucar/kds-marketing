import { Controller, Get, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { NetgsmOnboardingService } from '../services/netgsm-onboarding.service';

/** GET /marketing/netgsm/onboarding — the Account Center setup checklist card. */
@MarketingRoute()
@Controller('marketing/netgsm')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('telephony')
export class NetgsmOnboardingController {
  constructor(private readonly onboarding: NetgsmOnboardingService) {}

  @Get('onboarding')
  checklist(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.onboarding.checklist(a.workspaceId);
  }
}
