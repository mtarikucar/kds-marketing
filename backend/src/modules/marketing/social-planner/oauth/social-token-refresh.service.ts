import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../../common/crypto/secret-box.helper';
import { isOAuthNetwork } from './social-oauth.config';
import { providerFor } from './social-oauth.providers';

/**
 * Hourly refresh of OAuth-connected social tokens nearing expiry. Mirrors
 * AdsPullService: a single-replica advisory lock guards the tick, and the
 * DUE-ROW query is the one sanctioned cross-workspace read (a system job),
 * whitelisted in the workspace-scoping fitness test; every write it triggers is
 * id-keyed. refreshOne never throws — a failing refresh disables the account
 * and stamps lastError='reauth_required' so the UI prompts a reconnect.
 *
 * Meta page tokens are non-expiring and carry no refreshToken, so they're
 * filtered out (refreshToken NOT NULL) — only LinkedIn/TikTok actually refresh.
 * Inert when MARKETING_SECRET_KEY is absent.
 */
@Injectable()
export class SocialTokenRefreshService {
  private readonly logger = new Logger(SocialTokenRefreshService.name);
  private static readonly BATCH = 200;
  /** Refresh once the token is within this window of expiry. */
  private static readonly REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'social-token-refresh' })
  async refreshExpiring(): Promise<void> {
    if (!isSecretBoxConfigured()) return;
    await withAdvisoryLock(this.prisma, 'social:token-refresh', async () => {
      const dueBefore = new Date(Date.now() + SocialTokenRefreshService.REFRESH_WINDOW_MS);
      const due = await this.prisma.socialAccount.findMany({
        where: {
          connectedVia: 'OAUTH',
          enabled: true,
          refreshToken: { not: null },
          tokenExpiresAt: { not: null, lt: dueBefore },
        },
        orderBy: { tokenExpiresAt: 'asc' },
        take: SocialTokenRefreshService.BATCH,
        select: {
          id: true,
          workspaceId: true,
          network: true,
          refreshToken: true,
          // Needed to tell "this refresh failed but the token is still good"
          // from "we are out of runway" — see refreshOne's catch.
          tokenExpiresAt: true,
        },
      });
      for (const acc of due) {
        await this.refreshOne(acc);
      }
    });
  }

  private async refreshOne(acc: {
    id: string;
    workspaceId: string;
    network: string;
    refreshToken: string | null;
    tokenExpiresAt: Date | null;
  }): Promise<void> {
    try {
      if (!acc.refreshToken || !isOAuthNetwork(acc.network)) return;
      const provider = providerFor(acc.network);
      if (!provider.refresh) return; // non-refreshable (e.g. Meta page token)
      const result = await provider.refresh(openSecret(acc.refreshToken));
      // Compare-and-swap on the refreshToken snapshot: if the user RECONNECTED the
      // account during our (slow) provider round-trip, the stored sealed token has
      // changed and this updateMany matches 0 rows — so we never overwrite the
      // fresh reconnect with the result of refreshing the now-stale token.
      await this.prisma.socialAccount.updateMany({
        where: { id: acc.id, workspaceId: acc.workspaceId, refreshToken: acc.refreshToken },
        data: {
          accessToken: sealSecret(result.accessToken),
          refreshToken: result.refreshToken ? sealSecret(result.refreshToken) : acc.refreshToken,
          tokenExpiresAt: result.expiresAt ?? null,
          lastError: null,
        },
      });
    } catch (e) {
      this.logger.warn(`social token refresh failed for ${acc.id}: ${(e as Error).message}`);

      // A failure here is NOT proof that reauth is needed. Providers throw a
      // plain Error with a message, so a 401 invalid_grant and a 503 or a
      // socket timeout arrive identically — there is nothing to classify on.
      //
      // Disabling on the first failure was therefore a one-way door: the due
      // query filters `enabled: true`, so a disabled account is never picked up
      // again and a momentary network blip killed a healthy connection until a
      // human noticed. Accounts enter this query REFRESH_WINDOW_MS (7 days)
      // before expiry and the cron runs hourly, so first-failure disabling threw
      // away ~167 retries out of 168.
      //
      // While the token is still valid a failed refresh costs nothing: leave the
      // row completely untouched and let the next hourly tick retry. Deliberately
      // no `lastError` either — `needsReconnect` folds Boolean(lastError), so
      // writing one would tell the owner to reconnect an account that is working.
      const expired = acc.tokenExpiresAt != null && acc.tokenExpiresAt.getTime() <= Date.now();
      if (!expired) return;

      // Out of runway: the token has actually expired and refresh still fails.
      // Same CAS guard: only disable if the row STILL holds the stale token we
      // tried. A concurrent reconnect (new token) must not be disabled by a
      // failed refresh of the old one.
      await this.prisma.socialAccount
        .updateMany({ where: { id: acc.id, workspaceId: acc.workspaceId, refreshToken: acc.refreshToken }, data: { enabled: false, lastError: 'reauth_required' } })
        .catch(() => {});
    }
  }
}
