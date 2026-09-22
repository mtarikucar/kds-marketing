import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { EmailOAuthProvider, isEmailOAuthProvider } from './email-oauth.config';
import { EmailOAuthSecrets, needsRefresh, refreshAccessToken } from './email-oauth.sender';
import { MailboxHealthService, MailboxRef } from './mailbox-health.service';

/**
 * The sweep's tick and window, together — they are one decision, not two.
 *
 * Two invariants, and only one of them is about the window:
 *   (a) window >= tick, so a dying token is seen as due at the last sweep
 *       before it expires rather than first noticed already dead;
 *   (b) tick < the effective TTL (~59 min, see ACCESS_TOKEN_SLACK_SECONDS), so
 *       a token refreshed right after a sweep is revisited before it dies.
 * (b) is why the tick moved off the hour: no window can make an hourly sweep
 * revisit a token whose life is shorter than an hour, so the old shape left a
 * dead minute every hour, forever. The window stays far below the TTL, so each
 * mailbox still costs about one token request per hour.
 */
export const REFRESH_TICK = CronExpression.EVERY_10_MINUTES;
export const REFRESH_TICK_MS = 10 * 60 * 1000;
export const REFRESH_WINDOW_MS = 20 * 60 * 1000;

/** What the send path gets back when it asks for a usable token. Flat and
 *  never thrown, like the rest of this path: a throw inside a send fails a
 *  whole workflow run rather than one mail (G2). */
export interface OnDemandToken {
  accessToken: string | null;
  expiresAt: number | null;
  error: string | null;
}

type SealedSecrets = EmailOAuthSecrets & Record<string, string>;

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
 * reading all of them each tick is affordable; the guard is a log line if that
 * assumption ever stops holding, not a limit that would reintroduce the bug.
 *
 * Inert without MARKETING_SECRET_KEY, and per-row failures never throw: a
 * mailbox whose consent was revoked is stamped and left for the owner to
 * reconnect, rather than stopping the sweep for everyone behind it.
 */
@Injectable()
export class EmailOAuthRefreshService {
  private readonly logger = new Logger(EmailOAuthRefreshService.name);
  /** Not a cap — a tripwire. Crossing it means the "one row per workspace"
   *  assumption above is wrong and this needs a queryable expiry column. */
  private static readonly EXPECTED_MAX = 5_000;
  /** One refresh per mailbox at a time. Microsoft ROTATES the refresh token,
   *  so two sends racing on the same channel can leave the loser holding a
   *  credential the provider has already invalidated. */
  private readonly inFlight = new Map<string, Promise<OnDemandToken>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: MailboxHealthService,
  ) {}

  @Cron(REFRESH_TICK, { name: 'email-oauth-refresh' })
  async refreshExpiring(): Promise<void> {
    if (!isSecretBoxConfigured()) return;
    await withAdvisoryLock(this.prisma, 'channels:email-oauth-refresh', async () => {
      // Cross-workspace by design: a system job, id-keyed on every write.
      // The owning workspace is projected but NOT filtered on — every health
      // write this sweep makes is a scoped re-read (G5), and it cannot make one
      // from an id alone.
      const rows = await this.prisma.channel.findMany({
        where: { type: 'EMAIL', status: 'ACTIVE', configSealed: { not: null } },
        select: { id: true, workspaceId: true, configSealed: true },
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

  /**
   * A token the send path can use right now.
   *
   * The sweep is the floor, not the ceiling: a mailbox connected a minute after
   * the last tick still has to send. Answering "try again shortly" here was a
   * real failure on a real customer's mail, so the send asks for a token and
   * gets one — or gets the provider's own words about why it cannot have one.
   *
   * Scoped to the workspace that owns the channel: this is called per send, by
   * a tenant, and the sweep's cross-workspace exemption is for the sweep.
   */
  async refreshNow(workspaceId: string, channelId: string): Promise<OnDemandToken> {
    const key = `${workspaceId}:${channelId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const started = this.resolveToken(workspaceId, channelId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private async resolveToken(workspaceId: string, channelId: string): Promise<OnDemandToken> {
    const fail = (error: string): OnDemandToken => ({ accessToken: null, expiresAt: null, error });
    if (!isSecretBoxConfigured()) return fail('MARKETING_SECRET_KEY is not configured on this deployment');
    try {
      const row = await this.prisma.channel.findFirst({
        where: { id: channelId, workspaceId },
        select: { id: true, workspaceId: true, configSealed: true },
      });
      if (!row?.configSealed) return fail('this mailbox has no stored credentials');

      const secrets = this.open(row.configSealed);
      if (!secrets) return fail('this mailbox credential box could not be opened');
      if (!isEmailOAuthProvider(secrets.oauthProvider) || !secrets.oauthRefreshToken) {
        return fail('this mailbox is not connected by consent');
      }
      // The sweep may have refreshed it a moment ago; spending a token request
      // per send would be the price of not looking.
      if (!needsRefresh(secrets)) {
        return { accessToken: secrets.oauthAccessToken, expiresAt: Number(secrets.oauthExpiresAt) || null, error: null };
      }
      return await this.exchange(row, secrets, secrets.oauthProvider);
    } catch (e) {
      // Nothing new throws (G2): a database blip here must cost one mail, not
      // the whole run the send sits inside.
      this.logger.warn(`on-demand email token refresh failed for channel ${channelId}: ${(e as Error).message}`);
      return fail('the connected mailbox token could not be refreshed');
    }
  }

  private async refreshOne(row: MailboxRef & { configSealed: string }): Promise<void> {
    try {
      const secrets = this.open(row.configSealed);
      if (!secrets) return; // unreadable box (key rotated) — not this job's to fix
      if (!isEmailOAuthProvider(secrets.oauthProvider) || !secrets.oauthRefreshToken) return;

      const expiresAt = Number(secrets.oauthExpiresAt);
      // An unrecorded expiry is treated as due, matching `needsRefresh`: the
      // token's age is unknown and one wasted refresh beats a dead send.
      const due = !Number.isFinite(expiresAt) || expiresAt - Date.now() < REFRESH_WINDOW_MS;
      if (!due) return;

      await this.exchange(row, secrets, secrets.oauthProvider);
    } catch (e) {
      this.logger.warn(`email token refresh failed for channel ${row.id}: ${(e as Error).message}`);
    }
  }

  private open(configSealed: string): SealedSecrets | null {
    try {
      return JSON.parse(openSecret(configSealed));
    } catch {
      return null;
    }
  }

  /** Trade the refresh token and seal what came back. The one writer of these
   *  credentials, so the sweep and a send can never disagree about them. */
  private async exchange(
    row: MailboxRef & { configSealed?: string },
    secrets: SealedSecrets,
    provider: EmailOAuthProvider,
  ): Promise<OnDemandToken> {
    // Narrowed on purpose: the health service is handed an identity, never the
    // row that carries the sealed credentials.
    const ref: MailboxRef = { id: row.id, workspaceId: row.workspaceId };
    const id = ref.id;
    const t = await refreshAccessToken(provider, secrets.oauthRefreshToken);
    if (t.error) {
      // Consent revoked, password changed, app removed. Recorded where the
      // owner can see it; the stored refresh token is LEFT ALONE, because a
      // transient provider outage must not cost a working connection.
      await this.stampError(id, secrets, t.error);
      // …and again OUTSIDE the sealed box. Nothing that renders a mailbox can
      // open that box, so an error recorded only inside it is a channel that
      // looks connected and sends nothing (`oauth-revoked-invisible`).
      await this.health.recordOAuthReauthRequired(ref, { error: t.error }).catch(() => undefined);
      return { accessToken: null, expiresAt: null, error: t.error };
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
      where: { id },
      data: { configSealed: sealSecret(JSON.stringify(next)) },
    });
    // A token that healed itself must take the reconnect marker down with it,
    // or the card keeps asking for a reconnect nobody needs to do.
    await this.health.clearOAuthReauthRequired(ref).catch(() => undefined);
    return { accessToken: t.accessToken, expiresAt: t.expiresAt, error: null };
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
