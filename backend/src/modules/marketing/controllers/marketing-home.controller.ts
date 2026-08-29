import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { HomeTimelineService } from '../analytics/home-timeline.service';

/** Width of the default window, applied from `start` — which is `now` only when
 *  the caller gave no `from`. Long enough that a weekly rhythm is visible, short
 *  enough that the panel is not a wall. */
const DEFAULT_DAYS = 7;

/**
 * The home screen's calendar panel.
 *
 * No @MarketingRoles: this is an ordinary workspace read of the caller's own
 * calendar — tasks, bookings and campaigns the panel already shows elsewhere —
 * so every role that can open the home screen must be able to fill it. That is
 * the opposite call from marketing-ai's `usage/*` routes, which are MANAGER-only
 * because they are SPEND views; nothing here is money. MarketingRolesGuard is
 * still in the chain to follow the convention (not universal — see
 * prospecting.controller.ts, which wires MarketingGuard alone), so a future
 * @MarketingRoles on a route added here is enforced rather than decorative.
 *
 * Both of the above are pinned in the spec's "wiring" block rather than left to
 * this comment: a class-level @MarketingRoles added here would lock REPs out of
 * their own home screen without failing anything.
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
   * The window itself is deliberately NOT clamped. Note what that does and does
   * not cost: HomeTimelineService's `take: CAP + 1` bounds the RESPONSE for each
   * QUERIED source (the `system` lane is an in-memory list and never passes
   * through the cap at all), but it does not bound the database work — a
   * `?from=1970-01-01&to=2999-01-01` still range-scans and orders the full
   * matching set per source before the take applies.
   *
   * It stays unclamped anyway, because a clamp would answer a different question
   * than the one asked while looking like an answer to it — the same silent
   * narrowing `truncated` exists to refuse. If a pathological window ever does
   * bite, the honest fixes are an index or a 400, not a quiet rewrite.
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
