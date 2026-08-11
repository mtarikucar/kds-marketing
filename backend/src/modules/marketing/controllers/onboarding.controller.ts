import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { OnboardingService } from '../services/onboarding.service';

export class SetOnboardingDismissedDto {
  @IsBoolean()
  dismissed: boolean;
}

/**
 * The first-run setup guide's dismissal state.
 *
 * MANAGER-scoped because the guide itself is manager-only, and deliberately
 * NOT feature-gated: onboarding must work on every plan — a workspace that
 * cannot see how to set itself up is the one that most needs the guide.
 */
@MarketingRoute()
@Controller('marketing/onboarding')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  get(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.onboarding.get(a.workspaceId);
  }

  @Patch()
  set(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Body() dto: SetOnboardingDismissedDto,
  ) {
    return this.onboarding.setDismissed(a.workspaceId, dto.dismissed);
  }
}
