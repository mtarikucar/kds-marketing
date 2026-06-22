import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { AffiliatePortalGuard, PortalAffiliate } from '../guards/affiliate-portal.guard';
import { AffiliateService } from '../services/affiliate.service';

type PortalReq = { affiliate?: PortalAffiliate };

/**
 * Public self-serve affiliate portal (Epic 11a). No marketing-user session — the
 * affiliate authenticates with a bearer portal token (AffiliatePortalGuard
 * resolves it to req.affiliate). Read-only: an affiliate sees only their OWN
 * profile, referrals and commissions, all workspace + affiliate scoped.
 */
@MarketingRoute()
@Controller('public/affiliate')
@UseGuards(AffiliatePortalGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class PublicAffiliatePortalController {
  constructor(private readonly affiliates: AffiliateService) {}

  @Get('me')
  me(@Req() req: PortalReq) {
    const a = req.affiliate!;
    return this.affiliates.portalSummary(a.workspaceId, a.id);
  }

  @Get('referrals')
  referrals(@Req() req: PortalReq, @Query('status') status?: string) {
    const a = req.affiliate!;
    return this.affiliates.listReferrals(a.workspaceId, a.id, status);
  }

  @Get('commissions')
  commissions(@Req() req: PortalReq, @Query('status') status?: string) {
    const a = req.affiliate!;
    return this.affiliates.listCommissions(a.workspaceId, a.id, status);
  }
}
