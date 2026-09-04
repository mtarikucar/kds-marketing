import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { isEmailOAuthProvider } from './email-oauth.config';
import { EmailOAuthSecrets, refreshAccessToken } from './email-oauth.sender';

/**
 * Keeps consent-connected mailboxes sending.
 *
 * Access tokens last an hour. The whole promise of connecting a mailbox once is
 * that a channel connected on Monday still sends on Friday, and the send path
 * refuses to try with a dead token rather than failing on a customer — so
 * without this tick a mailbox goes quiet an hour after it is connected.
 *
 * WHY THIS SWEEPS EVERY ROW INSTEAD OF QUERYING THE DUE ONES: the expiry lives
 * inside the AES-GCM box, so there is no column to filter on. A `take(N)` over
 * an unfiltered set would pin this sweep to the same N rows forever and leave
 * every later mailbox unrefreshed — the failure mode is silent and permanent.
 * The set is bounded by "workspaces that connected a mailbox", one row each, so
 * reading all of them hourly is affordable; the guard is a log line if that
 * assumption ever stops holding, not a limit that would reintroduce the bug.
 *
 * Inert without MARKETING_SECRET_KEY, and per-row failures never throw: a
 * mailbox whose consent was revoked is stamped and left for the owner to
 * reconnect, rather than stopping the sweep for everyone behind it.
 */
@Injectable()
export class EmailOAuthRefreshService {
  private readonly logger = new Logger(EmailOAuthRefreshService.name);
  /** Refresh once the token is inside this window of expiry. Comfortably wider
   *  than the hourly tick, so a token is never first noticed already dead. */
  private static readonly WINDOW_MS = 15 * 60 * 1000;
  /** Not a cap — a tripwire. Crossing it means the "one row per workspace"
   *  assumption above is wrong and this needs a queryable expiry column. */
  private static readonly EXPECTED_MAX = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'email-oauth-refresh' })
  async refreshExpiring(): Promise<void> {
    if (!isSecretBoxConfigured()) return;
    await withAdvisoryLock(this.prisma, 'channels:email-oauth-refresh', async () => {
      // Cross-workspace by design: a system job, id-keyed on every write.
      const rows = await this.prisma.channel.findMany({
        where: { type: 'EMAIL', status: 'ACTIVE', configSealed: { not: null } },
        select: { id: true, configSealed: true },
      });
      if (rows.length > EmailOAuthRefreshService.EXPECTED_MAX) {
        this.logger.warn(
          `email-oauth-refresh scanned ${rows.length} channels; this sweep needs a queryable expiry column`,
        );
      }
      for (const row of rows) {
        await this.refreshOne(row);
      }
    });
  }

  private async refreshOne(row: { id: string; configSealed: string }): Promise<void> {
    try {
      let secrets: EmailOAuthSecrets & Record<string, string>;
      try {
        secrets = JSON.parse(openSecret(row.configSealed));
      } catch {
        return; // unreadable box (key rotated) — not this job's to fix
      }
      if (!isEmailOAuthProvider(secrets.oauthProvider) || !secrets.oauthRefreshToken) return;

      const expiresAt = Number(secrets.oauthExpiresAt);
      // An unrecorded expiry is treated as due, matching `needsRefresh`: the
      // token's age is unknown and one wasted refresh beats a dead send.
      const due = !Number.isFinite(expiresAt) || expiresAt - Date.now() < EmailOAuthRefreshService.WINDOW_MS;
      if (!due) return;

      const t = await refreshAccessToken(secrets.oauthProvider, secrets.oauthRefreshToken);
      if (t.error) {
        // Consent revoked, password changed, app removed. Recorded where the
        // owner can see it; the stored refresh token is LEFT ALONE, because a
        // transient provider outage must not cost a working connection.
        await this.stampError(row.id, secrets, t.error);
        return;
      }

      const next = {
        ...secrets,
        oauthAccessToken: t.accessToken,
        oauthExpiresAt: String(t.expiresAt),
        // Only when the provider actually rotated it — Google omits it and the
        // original stays valid, so writing null through would delete it.
        ...(t.refreshToken ? { oauthRefreshToken: t.refreshToken } : {}),
      };
      delete next.oauthError;
      await this.prisma.channel.update({
        where: { id: row.id },
        data: { configSealed: sealSecret(JSON.stringify(next)) },
      });
    } catch (e) {
      this.logger.warn(`email token refresh failed for channel ${row.id}: ${(e as Error).message}`);
    }
  }

  private async stampError(id: string, secrets: Record<string, string>, error: string): Promise<void> {
    await this.prisma.channel
      .update({
        where: { id },
        data: { configSealed: sealSecret(JSON.stringify({ ...secrets, oauthError: error })) },
      })
      .catch(() => undefined);
  }
}
