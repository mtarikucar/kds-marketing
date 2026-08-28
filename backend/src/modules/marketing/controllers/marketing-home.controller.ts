import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { HomeTimelineService } from '../analytics/home-timeline.service';

/** Default window: now → +7 days. Long enough that a weekly rhythm is visible,
 *  short enough that the panel is not a wall. */
const DEFAULT_DAYS = 7;

/**
 * The home screen's calendar panel.
 *
 * No @MarketingRoles: this is an ordinary workspace read of the caller's own
 * calendar — tasks, bookings and campaigns the panel already shows elsewhere —
 * so every role that can open the home screen must be able to fill it. That is
 * the opposite call from marketing-ai's `usage/*` routes, which are MANAGER-only
 * because they are SPEND views; nothing here is money. MarketingRolesGuard is
 * still in the chain to match every sibling workspace controller, so a future
 * @MarketingRoles on a route added here is enforced rather than decorative.
 */
@MarketingRoute()
@Controller('marketing/home')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingHomeController {
  constructor(private readonly svc: HomeTimelineService) {}

  /**
   * `from`/`to` are ISO instants; either may be omitted or malformed, and a
   * malformed one falls back rather than reaching the service — `new Date(x)`
   * on garbage is `Invalid Date`, which Prisma would either reject or, worse,
   * turn into an empty calendar that looks like "nothing is scheduled".
   *
   * The window itself is deliberately NOT clamped: HomeTimelineService caps
   * every source at CAP rows and names what it truncated, so a wide window
   * costs bounded work and says so.
   */
  @Get('timeline')
  timeline(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const start = from && !Number.isNaN(Date.parse(from)) ? new Date(from) : new Date();
    const end =
      to && !Number.isNaN(Date.parse(to))
        ? new Date(to)
        : new Date(start.getTime() + DEFAULT_DAYS * 86_400_000);
    return this.svc.timeline(actor.workspaceId, start, end);
  }
}
