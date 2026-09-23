import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { mergeConfigPublic } from './config-public.merge';

/**
 * The one writer of `Channel.configPublic.health` — "is this mailbox working,
 * and if not, since when?".
 *
 * ## Why this exists
 *
 * A mailbox connected by consent can stop working without anybody doing
 * anything: the owner changes their Google password, removes the app, or the
 * tenant's IT revokes it. Today the refresh sweep records that as `oauthError`
 * INSIDE the AES-GCM box, which has no reader and nothing to filter on — so
 * the account center kept showing HEALTHY while every send failed forever and
 * the send path answered "try again shortly" (`oauth-revoked-invisible`).
 *
 * So the state that tells a human what to do lives in `configPublic`, in the
 * clear. It carries no secret: a timestamp, a boolean per lane, a machine
 * reason code and the provider's own error string. `oauthReauthRequiredAt` in
 * particular is the marker a plain Prisma query can find (`reauthRequiredWhere`),
 * which is what lets a digest, a readiness check or an alert cron reach it —
 * none of which can open the box.
 *
 * ## Two lanes, not one verdict
 *
 * Sending and receiving fail separately and for different reasons — an SMTP
 * password can be right while IMAP is blocked, and the verify button's `ok` is
 * SEND-truth (`channels.service.ts` stamps `lastVerifiedAt` on `health.ok`
 * alone). A single "healthy" flag would have to pick one and lie about the
 * other, so each lane keeps its own state and the card renders both.
 *
 * ## Every write re-reads, and touches one key
 *
 * Callers hold a Channel row across an IMAP connect or an SMTP send — seconds
 * to minutes, so the copy in hand is old. The re-read here is for the PATCH
 * (`since`, the failure count); the WRITE is a single `configPublic || {health}`
 * statement through `mergeConfigPublic`, because the column also carries both
 * IMAP cursors and the tenant's settings and nothing serializes those writers
 * against this one.
 *
 * ## It never throws
 *
 * Health is a description of what happened, never a reason for it to have gone
 * differently. A failed health write is a `warn`, never an exception into a
 * send path or a poll tick (PLAN G2).
 */

/** Which half of the mailbox this is about. */
export type MailboxLane = 'send' | 'receive';

/** The minimal channel identity every write needs: a workspace-scoped re-read
 *  is only possible with the workspace, so it is not optional. */
export interface MailboxRef {
  id: string;
  workspaceId: string;
}

export interface MailboxLaneHealth {
  ok: boolean;
  /** When this lane last CHANGED state — what answers "down for how long?".
   *  `lastErrorAt` moves on every repeat; this one does not. */
  since?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  /** The provider's own words, truncated. Never a paraphrase, never localised
   *  — the UI prints `reason`, this is for the operator. */
  lastError?: string;
  /** Machine code the UI maps to copy (`OAUTH_REAUTH_REQUIRED`, `AUTH_FAILED`,
   *  `CONNECT_FAILED`, …). Never printed raw (PLAN G8). */
  reason?: string;
}

export interface MailboxHealth {
  send?: MailboxLaneHealth;
  receive?: MailboxLaneHealth;
  /**
   * Consecutive FAILED HOLD attempts on the receive lane — PLAN A4.6's
   * `imapFailCount`, under the §A5 name. Only `recordBackoff` moves it: a
   * dropped IDLE socket is routine and must not earn a retry delay, and a send
   * failure must never silence inbound.
   */
  consecutiveFailures?: number;
  /** §A4.6's `imapBackoffUntil`: the poll path skips this mailbox until then. */
  backoffUntil?: string;
  /** Set when the stored consent is dead and only the owner can fix it.
   *  Deliberately OUTSIDE the sealed box — see the class docstring. */
  oauthReauthRequiredAt?: string;
  lastPolledAt?: string;
  lastMessageAt?: string;
}

/** The provider's error, kept short enough to sit in a JSON column and a card. */
const MAX_ERROR_CHARS = 300;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CEILING_MS = 60 * 60_000;
/** A classified credential failure waits longer — but it still waits, and then
 *  retries. "Stop forever on auth failure" would let one transient
 *  AUTHENTICATIONFAILED kill a mailbox's inbound permanently (§A4.6). */
const AUTH_BACKOFF_CEILING_MS = 6 * 60 * 60_000;

/** The ladder: 1, 2, 4, 8, 16, 32 minutes, then flat at the ceiling. */
export function nextBackoffMs(failCount: number, authFailure = false): number {
  const n = Math.max(1, Math.floor(failCount) || 1);
  const ceiling = authFailure ? AUTH_BACKOFF_CEILING_MS : BACKOFF_CEILING_MS;
  // Bounded exponent so a long-dead mailbox cannot overflow the arithmetic.
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20), ceiling);
}

/** Read the health block off a raw `configPublic`, tolerating anything. */
export function readMailboxHealth(configPublic: unknown): MailboxHealth {
  const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
  const health = pub?.health;
  return health && typeof health === 'object' ? (health as MailboxHealth) : {};
}

/** Should the poller leave this mailbox alone right now? An unparseable or
 *  absent marker means "go ahead" — health state must never be the thing that
 *  stops mail arriving. */
export function isMailboxBackedOff(configPublic: unknown, now: Date = new Date()): boolean {
  const until = Date.parse(readMailboxHealth(configPublic).backoffUntil ?? '');
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Prisma `where` fragment for "this mailbox needs the owner to reconnect".
 * The marker is plaintext precisely so this query can exist — the digest, the
 * readiness check and the alert cron are plain counts on columns and cannot
 * open the AES-GCM box.
 */
export function reauthRequiredWhere(): Prisma.ChannelWhereInput {
  return {
    configPublic: { path: ['health', 'oauthReauthRequiredAt'], not: Prisma.DbNull },
  };
}

@Injectable()
export class MailboxHealthService {
  private readonly logger = new Logger(MailboxHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** This lane just worked. Clears its error state; a good receive also ends
   *  any backoff the failures before it earned. */
  async recordOk(ref: MailboxRef, lane: MailboxLane, opts?: { polled?: boolean }): Promise<void> {
    const at = new Date().toISOString();
    await this.merge(ref, (health) => {
      const next: MailboxHealth = {
        ...health,
        [lane]: { ok: true, since: health[lane]?.ok ? health[lane]?.since ?? at : at, lastOkAt: at },
      };
      if (lane === 'receive') {
        next.consecutiveFailures = 0;
        delete next.backoffUntil;
        if (opts?.polled) next.lastPolledAt = at;
      }
      return next;
    });
  }

  /** This lane failed. Recorded, not retried and not backed off — see
   *  `recordBackoff` for the one caller that earns a delay. */
  async recordFailure(
    ref: MailboxRef,
    lane: MailboxLane,
    detail: { error?: string; reason?: string },
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.merge(ref, (health) => ({
      ...health,
      [lane]: this.failedLane(health[lane], detail, at),
    }));
  }

  /**
   * A mailbox HOLD attempt failed: record it and earn the next wait.
   *
   * Only failed holds count. A dropped IDLE socket is normal operation (the
   * reconcile picks it straight back up), and counting those would back a
   * perfectly healthy mailbox off to an hour.
   *
   * Returns the computed state even when the write could not land, so the
   * caller can honour the wait either way.
   */
  async recordBackoff(
    ref: MailboxRef,
    detail: { error?: string; reason?: string; authFailure?: boolean },
  ): Promise<{ failCount: number; backoffUntil: Date }> {
    const now = new Date();
    const at = now.toISOString();
    let state = { failCount: 1, backoffUntil: new Date(now.getTime() + nextBackoffMs(1)) };
    await this.merge(ref, (health) => {
      const failCount = (Number(health.consecutiveFailures) || 0) + 1;
      const backoffUntil = new Date(now.getTime() + nextBackoffMs(failCount, detail.authFailure));
      state = { failCount, backoffUntil };
      return {
        ...health,
        receive: this.failedLane(health.receive, detail, at),
        consecutiveFailures: failCount,
        backoffUntil: backoffUntil.toISOString(),
      };
    });
    return state;
  }

  /**
   * Forget the accumulated wait without claiming anything works yet.
   *
   * For `ChannelsService.verify`'s `health.ok` branch: that flag is SEND-truth,
   * but a credential the operator has just re-proven should let inbound try
   * again now rather than serve out an hour earned under the old password.
   */
  async clearBackoff(ref: MailboxRef): Promise<void> {
    await this.merge(ref, (health) => {
      const next = { ...health, consecutiveFailures: 0 };
      delete next.backoffUntil;
      return next;
    });
  }

  /**
   * The stored consent is dead and only the owner can fix it. Stamped in the
   * clear, and stamped ONCE — the hourly sweep meets the same dead token every
   * hour, and "since when" is the half of the answer that makes it actionable.
   */
  async recordOAuthReauthRequired(ref: MailboxRef, detail?: { error?: string }): Promise<void> {
    const at = new Date().toISOString();
    await this.merge(ref, (health) => ({
      ...health,
      oauthReauthRequiredAt: health.oauthReauthRequiredAt ?? at,
      send: this.failedLane(
        health.send,
        { error: detail?.error, reason: 'OAUTH_REAUTH_REQUIRED' },
        at,
      ),
    }));
  }

  /**
   * The owner reconnected. Clears the marker AND the send failure it caused —
   * without this a correctly reconnected mailbox keeps reading "Yeniden
   * bağlan" until something else happens to succeed. A send failure from any
   * other cause is left standing: it is still true.
   */
  async clearOAuthReauthRequired(ref: MailboxRef): Promise<void> {
    await this.merge(ref, (health) => {
      const next = { ...health };
      delete next.oauthReauthRequiredAt;
      if (next.send?.reason === 'OAUTH_REAUTH_REQUIRED') delete next.send;
      return next;
    });
  }

  /** A real message arrived in this mailbox. Nothing else moves — in
   *  particular never `aiPaused`, which on Gmail/Outlook would be tripped by
   *  the AI's own replies appearing in Sent. */
  async recordMessage(ref: MailboxRef, at: Date = new Date()): Promise<void> {
    await this.merge(ref, (health) => ({ ...health, lastMessageAt: at.toISOString() }));
  }

  private failedLane(
    previous: MailboxLaneHealth | undefined,
    detail: { error?: string; reason?: string },
    at: string,
  ): MailboxLaneHealth {
    return {
      ok: false,
      // Held across repeats: this is what answers "receive has been down for
      // over two hours", which `lastErrorAt` alone never could.
      since: previous && previous.ok === false ? previous.since ?? at : at,
      ...(previous?.lastOkAt ? { lastOkAt: previous.lastOkAt } : {}),
      lastErrorAt: at,
      ...(detail.error ? { lastError: detail.error.slice(0, MAX_ERROR_CHARS) } : {}),
      ...(detail.reason ? { reason: detail.reason } : {}),
    };
  }

  /**
   * Re-read the row inside its workspace, compute the new health block from
   * what is on it NOW, and write back THAT KEY ALONE.
   *
   * The read is for the patch (`since`, the failure count), never for the
   * write: `mergeConfigPublic` hands the database a `health` key and the
   * database merges it onto the row as it stands. The column also carries both
   * IMAP cursors and the tenant's own settings, and nothing serializes a send
   * settling against a sweep finishing — a whole-blob write would roll one of
   * them back whenever the two interleaved.
   */
  private async merge(
    ref: MailboxRef,
    patch: (health: MailboxHealth) => MailboxHealth,
  ): Promise<void> {
    try {
      const fresh = await this.prisma.channel.findFirst({
        where: { id: ref.id, workspaceId: ref.workspaceId },
        select: { configPublic: true },
      });
      // Deleted, or never this workspace's. Either way there is nothing to
      // describe, and re-creating the row would be worse than saying nothing.
      if (!fresh) return;
      await mergeConfigPublic(this.prisma, ref, { health: patch(readMailboxHealth(fresh.configPublic)) });
    } catch (e) {
      this.logger.warn(`mailbox health write failed for channel ${ref.id}: ${(e as Error).message}`);
    }
  }
}
