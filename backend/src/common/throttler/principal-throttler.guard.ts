import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit tracker that prefers the authenticated principal over the raw
 * client IP, so one workspace behind a shared NAT/VPN egress can't exhaust an
 * unrelated tenant's budget (and a single authenticated abuser is limited by
 * identity, not by hopping source IPs).
 *
 * IMPORTANT ordering note: the global APP_GUARD ThrottlerGuard runs BEFORE the
 * controller-scoped MarketingGuard/PlatformGuard that populate
 * `req.marketingUser` / `req.platformOperator`. On those routes the principal
 * is therefore not yet set at throttle time and we fall back to IP — which is
 * the correct, safe default. This subclass earns its keep on any route that is
 * later put behind a *global* auth guard, and is harmless everywhere else.
 */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const workspaceId = req.marketingUser?.workspaceId;
    if (workspaceId) return `ws:${workspaceId}`;

    const marketingUserId = req.marketingUser?.id;
    if (marketingUserId) return `mu:${marketingUserId}`;

    const operatorId = req.platformOperator?.id;
    if (operatorId) return `op:${operatorId}`;

    return req.ip ?? 'unknown';
  }
}
