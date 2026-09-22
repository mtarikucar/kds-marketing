import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ResolvedChannelConfig } from './channel-adapter.interface';
import { isEmailOAuthProvider } from './email-oauth.config';
import { EmailOAuthSecrets, needsRefresh } from './email-oauth.sender';

export interface MailboxSendResult {
  ok: boolean;
  messageId: string | null;
  error?: string;
}

/** How a workspace's mailbox is connected. */
export type MailboxKind = 'SMTP' | 'CONSENT';

/**
 * One ACTIVE EMAIL channel of a workspace, already judged.
 *
 * `resolve()` answers "which mailbox may carry this send". This answers the
 * question behind it — what the workspace actually HAS — which is what the UI
 * and `SenderIdentityService` need in order to say WHY mail is still leaving
 * from the platform address instead of just letting it.
 */
export interface MailboxCandidate {
  channelId: string;
  config: ResolvedChannelConfig;
  kind: MailboxKind;
  /** An SMTP login has actually been accepted (`lastVerifiedAt` non-null). */
  verified: boolean;
  /** Complete enough to carry a send right now. */
  usable: boolean;
  /** CONSENT only: the owner has to reconnect (the provider refused, or there
   *  is no refresh token to renew with). A merely stale access token is not
   *  this — the refresh sweep renews those on its own. */
  needsReauth: boolean;
  /** Receive credentials are present too, so this mailbox is two-way. */
  canReceive: boolean;
  /** The address this mailbox sends as, lower-cased; null when unknown. */
  address: string | null;
}

/** The merit-ordered ACTIVE channel of one type, for a caller that needs an id. */
export interface BestChannel {
  id: string;
  type: string;
  name: string;
}

/** The channel columns both readers below need. */
const CANDIDATE_SELECT = {
  id: true,
  workspaceId: true,
  type: true,
  name: true,
  externalId: true,
  configSealed: true,
  configPublic: true,
  lastVerifiedAt: true,
  createdAt: true,
} as const;

/** All `byMerit` reads — so a narrower select can be ordered by it too. */
interface MeritRow {
  lastVerifiedAt: Date | null;
  createdAt: Date;
}

interface ChannelRow extends MeritRow {
  id: string;
  workspaceId: string;
  type: string;
  name: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/**
 * Proven first, then the freshest proof, then the newest row.
 *
 * NOT a `where lastVerifiedAt is not null` filter: verify is a manual button
 * and the consent connect path never stamps it, so a hard filter would zero out
 * a workspace whose mailbox works. Prefer-verified, fall back to newest.
 */
function byMerit(a: MeritRow, b: MeritRow): number {
  const av = a.lastVerifiedAt ? 1 : 0;
  const bv = b.lastVerifiedAt ? 1 : 0;
  if (av !== bv) return bv - av;
  if (a.lastVerifiedAt && b.lastVerifiedAt) {
    const d = b.lastVerifiedAt.getTime() - a.lastVerifiedAt.getTime();
    if (d !== 0) return d;
  }
  return b.createdAt.getTime() - a.createdAt.getTime();
}

/**
 * "Send this as the workspace, from its own address" — the one place that
 * decides whether a workspace has a usable mailbox, and sends through it.
 *
 * It exists because the decision was made TWICE and the copies drifted. The
 * campaign sender learned to use a connected mailbox; the workflow engine kept
 * calling the platform mailer, so an automation's mail still left from the
 * platform address while the same workspace's campaigns left from its own. One
 * caller was fixed, its sibling was not, and nothing in the code connected
 * them. A shared owner is what stops the next caller from picking the wrong
 * default by accident.
 *
 * Callers FALL BACK when this returns null: no mailbox is a normal state, not
 * an error, and mail must still go out on the platform transport.
 */
@Injectable()
export class WorkspaceMailboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
  ) {}

  /**
   * The workspace's own mailbox, resolved for sending — or null to fall through
   * to the platform transport.
   *
   * Two conditions, both deliberate:
   *
   * `lastVerifiedAt: { not: null }` — ChannelsService.verify writes it ONLY on
   * `health.ok`, so this is a mailbox whose SMTP login has actually been
   * accepted. Sending through credentials nobody has proved is how you get a
   * run of `535 Authentication Failed` with the send already recorded.
   *
   * SMTP only BY DEFAULT — a consent-connected (OAuth) mailbox falls through
   * unless the caller passes `allowConsent`. What that transport cannot carry
   * is `listUnsubscribeUrl`: Graph accepts `x-`-prefixed custom headers only,
   * and RFC 8058 headers are fail-closed on bulk, so bulk mail routed there
   * would go out without the one-click header it is required to have.
   * `campaign-sender.service.ts` calls this with NO options for exactly that
   * reason, and must keep doing so. (HTML is fine: `email-oauth.sender.ts`
   * builds a real multipart/alternative.)
   *
   * It SCANS the workspace's verified mailboxes rather than judging whichever
   * one the database happened to return first. `Channel` has no unique on
   * (workspaceId, type) — only @@unique([type, externalId]) — so a workspace can
   * legitimately hold a consent-connected mailbox next to an SMTP one. Taking
   * the first row and giving up on it sent the entire workspace's mail from the
   * platform address while its own verified mailbox sat one row away. Freshest
   * proven login wins, so the answer never depends on physical row order.
   */
  async resolve(
    workspaceId: string,
    opts?: { allowConsent?: boolean },
  ): Promise<ResolvedChannelConfig | null> {
    const candidates = await this.prisma.channel.findMany({
      where: { workspaceId, type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      orderBy: { lastVerifiedAt: 'desc' },
    });
    for (const ch of candidates) {
      const resolved = this.registry.resolveConfig(ch);
      const s = (resolved.secrets ?? {}) as Record<string, string | undefined>;
      if (s.oauthProvider) continue; // consent-connected — handled below
      if (s.smtpHost?.trim() && s.smtpUser?.trim() && s.smtpPass) return resolved;
    }
    if (!opts?.allowConsent) return null;
    // A consent mailbox is the SECOND choice, never a promotion over a proven
    // SMTP one — and it is looked for in its own read because `lastVerifiedAt`
    // is the wrong proof for it: the connect path never stamps that column, and
    // a live OAuth token is the stronger evidence anyway.
    const consent = (await this.candidates(workspaceId)).find(
      (c) => c.kind === 'CONSENT' && c.usable,
    );
    return consent?.config ?? null;
  }

  /**
   * Every ACTIVE mailbox the workspace has, merit-ordered and classified.
   *
   * `resolve()` answers a send's question and returns null when the answer is
   * "none". This answers the operator's: an unverified mailbox, a consent token
   * the provider refused and no mailbox at all are three different problems
   * with three different fixes, and mail that silently leaves from the platform
   * address tells the tenant none of them.
   */
  async candidates(workspaceId: string): Promise<MailboxCandidate[]> {
    const rows = (await this.prisma.channel.findMany({
      where: { workspaceId, type: 'EMAIL', status: 'ACTIVE' },
      select: CANDIDATE_SELECT,
    })) as unknown as ChannelRow[];
    return [...rows].sort(byMerit).map((ch) => this.classify(ch));
  }

  /**
   * The best ACTIVE channel per type, for a caller that needs a channel ID
   * rather than a send config.
   *
   * Content distribution used to take `orderBy: { createdAt: 'asc' }` — the
   * OLDEST row — so a workspace whose first mailbox died sent every outreach
   * through it while a working one sat next to it. Type stays type: the caller
   * passes the types it wants in ITS priority order, because merit ordering
   * that could move outreach from free email onto paid, İYS-governed SMS is a
   * different decision than picking the better mailbox.
   */
  async bestChannelIds(
    workspaceId: string,
    types: readonly string[],
  ): Promise<Map<string, BestChannel>> {
    const best = new Map<string, BestChannel>();
    if (!types.length) return best;
    const rows = (await this.prisma.channel.findMany({
      where: { workspaceId, status: 'ACTIVE', type: { in: [...types] } },
      select: { id: true, type: true, name: true, lastVerifiedAt: true, createdAt: true },
    })) as unknown as (BestChannel & MeritRow)[];
    for (const ch of [...rows].sort(byMerit)) {
      if (!best.has(ch.type)) best.set(ch.type, { id: ch.id, type: ch.type, name: ch.name });
    }
    return best;
  }

  /** What one channel row IS — the single reader of the sealed mail secrets. */
  private classify(ch: ChannelRow): MailboxCandidate {
    const config = this.registry.resolveConfig(ch);
    const s = (config.secrets ?? {}) as EmailOAuthSecrets & Record<string, string | undefined>;
    const verified = !!ch.lastVerifiedAt;
    if (isEmailOAuthProvider(s.oauthProvider)) {
      const address = (s.fromEmail ?? '').trim().toLowerCase() || null;
      // A consent reconnect no longer wipes a receive credential that is the
      // mailbox's only way in (`deadSmtpKeys`), and `imapTarget` now polls
      // with one — so a consent mailbox receives exactly when it holds a
      // password, whether that is the dedicated inbound pair or the SMTP one.
      const canReceive = !!(
        (s.imapUser?.trim() && s.imapPass) ||
        (s.smtpUser?.trim() && s.smtpPass)
      );
      return {
        channelId: ch.id,
        config,
        kind: 'CONSENT',
        verified,
        usable: !!address && !!s.oauthAccessToken && !s.oauthError && !needsRefresh(s),
        needsReauth: !!s.oauthError || !s.oauthRefreshToken,
        canReceive,
        address,
      };
    }
    const address =
      (s.fromEmail ?? s.smtpUser ?? ch.externalId ?? '').trim().toLowerCase() || null;
    return {
      channelId: ch.id,
      config,
      kind: 'SMTP',
      verified,
      usable: !!(s.smtpHost?.trim() && s.smtpUser?.trim() && s.smtpPass),
      needsReauth: false,
      // The IMAP services reuse these same credentials, so an SMTP mailbox is
      // two-way by construction.
      canReceive: !!(s.smtpUser?.trim() && s.smtpPass),
      address,
    };
  }

  /**
   * Send through the workspace's own mailbox, or return null when it has none —
   * which is the caller's signal to use the platform transport instead.
   *
   * `text` always rides along with `html`: multipart is what clients and spam
   * filters expect, and an HTML-only mail from a new sending identity is a
   * reputation problem by itself.
   *
   * A consent-connected mailbox is allowed here, HTML and all: the OAuth
   * branch of the adapter builds a real multipart/alternative. This entry
   * point carries no unsubscribe URL at all, so the one thing that transport
   * cannot do never arises — bulk goes through the campaign sender, which
   * resolves with no options.
   */
  async send(input: {
    workspaceId: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<MailboxSendResult | null> {
    const config = await this.resolve(input.workspaceId, { allowConsent: true });
    if (!config) return null;
    const r = await this.registry.get('EMAIL').send({
      config,
      to: input.to,
      text: input.text,
      subject: input.subject,
      html: input.html,
    });
    return {
      ok: r.status === 'SENT',
      messageId: r.externalMessageId,
      error: r.error,
    };
  }
}
