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
        select: { id: true, network: true, refreshToken: true },
      });
      for (const acc of due) {
        await this.refreshOne(acc);
      }
    });
  }

  private async refreshOne(acc: {
    id: string;
    network: string;
    refreshToken: string | null;
  }): Promise<void> {
    try {
      if (!acc.refreshToken || !isOAuthNetwork(acc.network)) return;
      const provider = providerFor(acc.network);
      if (!provider.refresh) return; // non-refreshable (e.g. Meta page token)
      const result = await provider.refresh(openSecret(acc.refreshToken));
      await this.prisma.socialAccount.update({
        where: { id: acc.id },
        data: {
          accessToken: sealSecret(result.accessToken),
          refreshToken: result.refreshToken ? sealSecret(result.refreshToken) : acc.refreshToken,
          tokenExpiresAt: result.expiresAt ?? null,
          lastError: null,
        },
      });
    } catch (e) {
      this.logger.warn(`social token refresh failed for ${acc.id}: ${(e as Error).message}`);
      await this.prisma.socialAccount
        .update({ where: { id: acc.id }, data: { enabled: false, lastError: 'reauth_required' } })
        .catch(() => {});
    }
  }
}
