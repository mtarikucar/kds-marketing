import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MembershipService } from '../services/membership.service';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';

/**
 * Multi-workspace membership (Phase 2 Task 12) — the LOGGED-IN accept path:
 * an identity that already has a session (scoped to some OTHER workspace)
 * accepting an invite to a second one. `@MarketingGuard` only (no
 * `@MarketingPublic()`): a valid session is required. Deliberately NO
 * `MarketingRolesGuard`/role gate at the controller level — accepting YOUR
 * OWN invite isn't a role-gated admin action, and the caller's session role
 * is scoped to a different workspace than the one being accepted into
 * anyway. `MembershipService.accept` itself enforces that the membership
 * belongs to THIS caller (403 otherwise).
 *
 * The public, no-session counterpart lives at
 * POST /marketing/auth/accept-invite (MarketingAuthController).
 */
@MarketingRoute()
@Controller('marketing/memberships')
@UseGuards(MarketingGuard)
export class MarketingMembershipsController {
  constructor(private readonly membershipService: MembershipService) {}

  @Post(':id/accept')
  @Audit({ action: 'membership.accept', resourceType: 'membership' })
  accept(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.membershipService.accept(id, { userId: actor.id });
  }
}
