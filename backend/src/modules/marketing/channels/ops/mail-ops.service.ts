import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { MailClass } from '../outbound/mail-class';
import { MailBudgetService } from '../outbound/mail-budget.service';
import {
  DegradedCode,
  DegradedFix,
  SenderIdentityService,
} from '../outbound/sender-identity.service';
import { MailboxHealth, readMailboxHealth } from '../mailbox-health.service';
import {
  SENDING_DOMAIN_ENV_KEYS,
  sendingDomainEspStatus,
} from '../../sending-domains/sending-domains.config';

/**
 * "What is this workspace's mail actually doing?" — the one reader of the
 * ledgers waves 1 and 3 laid down.
 *
 * ## Why there is no metrics store
 *
 * `no-email-observability` asked for Prometheus counters. A counter answers
 * "how many failed" and then leaves the operator with nowhere to go: the
 * question that actually gets asked is *"why did this customer never get the
 * invoice"*, and only a row with a reason on it answers that. `MailLog` and
 * `EmailInboundItem` are already written on every outcome, including the
 * refusals that used to leave no trace at all, so the snapshot is a handful of
 * scoped aggregates over tables that exist — no new store, no new migration,
 * no second source of truth to drift.
 *
 * ## Every read names the workspace
 *
 * `mailLog` and `emailInboundItem` are workspace-owned delegates
 * (`workspace-scoping.arch.spec.ts` lists them, with a comment naming this
 * service), so the snapshot is per tenant and `workspaceId` is a literal in
 * every `where`. The PLATFORM-wide view is deliberately NOT here — it lives in
 * the operator realm (`platform/services/mail-admin.service.ts`), which is the
 * only place a cross-tenant aggregate belongs, and which keeps G5's "no new
 * ALLOWED_GLOBAL entry" honest.
 *
 * ## Nothing here throws (G2)
 *
 * A dashboard that 500s during an outage is a dashboard that is unavailable
 * exactly when it is needed. Every sub-read is independently guarded; what
 * could not be read comes back as zero with `partial: true` set, so the card
 * can say "some numbers are missing" instead of showing a blank screen or an
 * error page.
 */

// ── the shapes the card, the console and the cron all read ──────────────────

export interface MailOpsWindow {
  since: Date;
  /** Exclusive. Absent means "up to now". */
  until?: Date;
}

export interface MailSendStats {
  total: number;
  sent: number;
  refused: number;
  failedPermanent: number;
  failedTransient: number;
  deduped: number;
  pending: number;
  /** Mails that reached a transport — the denominator a failure rate means. A
   *  refusal never touched a mail server and must not read as a failure. */
  attempted: number;
  bounced: number;
  complained: number;
  failureRate: number;
  bounceRate: number;
  complaintRate: number;
  /** Why mail did not go, busiest first — the half of the answer a rate is not. */
  topReasons: { reason: string; count: number }[];
}

export interface MailClassStats {
  sent: number;
  failed: number;
  refused: number;
}

export interface MailInboundStats {
  total: number;
  done: number;
  skipped: number;
  failed: number;
  /** Standing, not windowed — see `snapshot`. */
  quarantined: number;
}

export interface MailboxSnapshot {
  channelId: string;
  name: string;
  address: string | null;
  /** A mailbox whose credentials have actually been accepted. Everything else
   *  is skipped by the poller and by the send ladder. */
  verified: boolean;
  sendOk: boolean | null;
  sendReason?: string;
  sendError?: string;
  receiveOk: boolean | null;
  receiveReason?: string;
  receiveError?: string;
  /** When the receive lane last CHANGED state — what "down for how long" reads. */
  receiveSince?: string;
  backoffUntil?: string;
  reauthRequiredAt?: string;
  lastPolledAt?: string;
  lastMessageAt?: string;
  quarantined: number;
}

export interface MailSuppressionStats {
  total: number;
  byReason: Record<string, number>;
}

export interface MailSnapshot {
  workspaceId: string;
  since: string;
  until: string;
  send: MailSendStats;
  byClass: Record<string, MailClassStats>;
  inbound: MailInboundStats;
  suppression: MailSuppressionStats;
  mailboxes: MailboxSnapshot[];
  daily: { day: string; limit: number; used: number; remaining: number };
  /** `settings.email.paused` — the operator switch, not a failure. */
  paused: boolean;
  /** At least one sub-read could not be answered; the numbers understate. */
  partial: boolean;
}

export interface MailHealthReport extends MailSnapshot {
  identity: {
    transport: string;
    fromEmail: string;
    fromName: string;
    replyTo?: string;
    degraded?: { code: DegradedCode; fix: DegradedFix };
  } | null;
  inert: InertMailFeature[];
}

// ── the inert list: the cheapest possible answer to "why did nothing send" ──

export interface InertMailFeature {
  /** A stable code the UI translates (G8) — never printed raw. */
  key: string;
  /** Every env key the feature needs, so the operator can set them in one go. */
  env: string[];
  /** The subset that is currently unset. Only key NAMES, never values. */
  missing: string[];
}

interface InertSpec {
  key: string;
  env: string[];
}

/**
 * Every email capability that is switched on by the environment and is
 * therefore OFF — silently — until an operator sets a key.
 *
 * An EXPLICIT list, never a `process.env` sweep: the deployment inherits
 * unrelated keys from `.env.shared`, and a sweep would turn this into a
 * changing wall of noise that nobody reads. Adding a feature here is a
 * deliberate act, exactly like adding it to the deploy mapping.
 */
export const INERT_MAIL_FEATURES: readonly InertSpec[] = [
  /**
   * An ESP transport for custom sending domains. The flag alone arms nothing —
   * §A5/`sending-domain-esp-flag` — so this entry asks the GATE rather than the
   * environment (see `inertMailFeatures`). Its answer is stricter than "the key
   * is set": an unrecognised provider name arms nothing, and the SPF include
   * has to be a real host rather than the placeholder the feature shipped with.
   * Listed here so the key NAMES stay in one place with their siblings.
   */
  { key: 'SENDING_DOMAIN_ESP', env: [...SENDING_DOMAIN_ENV_KEYS] },
  /** Bounce/complaint webhooks from the ESP. Without it the only bounce source
   *  is a DSN landing in the tenant's own mailbox. */
  { key: 'ESP_FEEDBACK', env: ['ESP_FEEDBACK_SECRET'] },
  /** "Connect with Google" for a mailbox. */
  { key: 'MAILBOX_OAUTH_GOOGLE', env: ['GOOGLE_MAIL_CLIENT_ID', 'GOOGLE_MAIL_CLIENT_SECRET'] },
  /** "Connect with Microsoft" for a mailbox. */
  {
    key: 'MAILBOX_OAUTH_MICROSOFT',
    env: ['MICROSOFT_MAIL_CLIENT_ID', 'MICROSOFT_MAIL_CLIENT_SECRET'],
  },
  /** The tokenized per-channel inbound webhook — the path that does not need IMAP. */
  { key: 'INBOUND_WEBHOOK', env: ['EMAIL_INBOUND_SECRET'] },
  /** Platform DKIM signing. Unsigned platform mail still leaves; it just lands
   *  worse, which is exactly the kind of thing nobody notices without a list. */
  { key: 'PLATFORM_DKIM', env: ['EMAIL_DKIM_SELECTOR', 'EMAIL_DKIM_PRIVATE_KEY_B64'] },
  /** The AES-GCM box. Without it no mailbox credential can be sealed at all,
   *  and the suppression hash key cannot be derived. */
  { key: 'SECRET_BOX', env: ['MARKETING_SECRET_KEY'] },
] as const;

/** Set, and not the empty string a missing deploy Variable renders as. */
function isSet(env: Record<string, string | undefined>, key: string): boolean {
  return !!(env[key] ?? '').trim();
}

/** Which email features this environment leaves inert. Values never leave. */
export function inertMailFeatures(
  env: Record<string, string | undefined> = process.env,
): InertMailFeature[] {
  const out: InertMailFeature[] = [];
  for (const spec of INERT_MAIL_FEATURES) {
    // The sending-domain path has a gate of its own, and the entitlement, the
    // register endpoint and the From-override all obey it. Re-deriving a looser
    // "is the key set" answer here is how a panel ends up telling an operator
    // the path is armed while the product refuses it.
    const missing =
      spec.key === 'SENDING_DOMAIN_ESP'
        ? sendingDomainEspStatus(env).missing
        : spec.env.filter((k) => !isSet(env, k));
    if (missing.length) out.push({ key: spec.key, env: [...spec.env], missing });
  }
  return out;
}

// ── the honest IMAP heartbeat ───────────────────────────────────────────────

/** How many mailbox reasons fit in `CronHeartbeat.lastError` before it stops
 *  being readable. Two is enough to tell "one bad password" from "the network". */
const HEARTBEAT_REASONS = 2;

/**
 * Should the IMAP sweep report itself as FAILING?
 *
 * Only when every mailbox it actually attempted failed. **Never a percentage**:
 * `email-imap-poll` is one shared platform cron, so a threshold like "most
 * mailboxes" means one tenant's changed password reds the job for every
 * tenant — and a surface that is red for reasons the operator cannot act on
 * stops being looked at, which is the state this whole package exists to fix.
 * The partial case is carried per mailbox, in `Channel.configPublic.health`,
 * where the only person who can fix it can see it.
 *
 * Returns the line for `CronHeartbeat.lastError`, or null for "green".
 */
export function sweepHeartbeatError(
  counts: { ok: number; failed: number; skipped: number },
  reasons: string[],
): string | null {
  if (counts.failed <= 0 || counts.ok > 0) return null;
  const head = reasons.filter(Boolean).slice(0, HEARTBEAT_REASONS).join('; ');
  return `email-imap-poll: all ${counts.failed} pollable mailboxes failed${head ? `: ${head}` : ''}`;
}

// ── the alert thresholds ────────────────────────────────────────────────────

/**
 * The numbers Gmail and Yahoo publish for bulk senders, plus the two operational
 * ones. They are constants rather than settings on purpose: a tenant who can
 * raise their own bounce ceiling is a tenant who silences the alarm instead of
 * cleaning their list.
 */
export const MAIL_ALERT_THRESHOLDS = {
  failureRate: 0.2,
  bounceRate: 0.05,
  complaintRate: 0.001,
  /**
   * The sample below which a rate means nothing. One bounce out of two sends
   * is 50 % and is not a reputation problem; an alert that fires on it is an
   * alert nobody reads. §A5 names 50 for the failure rate; the same floor is
   * applied to bounce and complaint for the same reason.
   */
  minSends: 50,
  receiveDownMs: 2 * 60 * 60 * 1000,
} as const;

export type MailAlertKind =
  | 'SEND_FAILURE_RATE'
  | 'BOUNCE_RATE'
  | 'COMPLAINT_RATE'
  | 'RECEIVE_DOWN'
  | 'INBOUND_QUARANTINED';

export interface MailAlert {
  kind: MailAlertKind;
  /** Numbers only — the copy is the notification's job (G8). */
  detail: Record<string, string | number>;
}

/** What this snapshot is breaching, if anything. Pure, so the cron is a loop. */
export function breaches(
  snapshot: Pick<MailSnapshot, 'send' | 'inbound' | 'mailboxes'>,
  now: Date = new Date(),
): MailAlert[] {
  const out: MailAlert[] = [];
  const s = snapshot.send;
  const enough = s.attempted >= MAIL_ALERT_THRESHOLDS.minSends;

  if (enough && s.failureRate > MAIL_ALERT_THRESHOLDS.failureRate) {
    out.push({
      kind: 'SEND_FAILURE_RATE',
      detail: {
        attempted: s.attempted,
        failed: s.failedPermanent + s.failedTransient,
        rate: round(s.failureRate),
      },
    });
  }
  if (enough && s.bounceRate > MAIL_ALERT_THRESHOLDS.bounceRate) {
    out.push({
      kind: 'BOUNCE_RATE',
      detail: { sent: s.sent, bounced: s.bounced, rate: round(s.bounceRate) },
    });
  }
  if (enough && s.complaintRate > MAIL_ALERT_THRESHOLDS.complaintRate) {
    out.push({
      kind: 'COMPLAINT_RATE',
      detail: { sent: s.sent, complained: s.complained, rate: round(s.complaintRate) },
    });
  }

  // One alert for the whole workspace, naming the worst mailbox: an outage
  // that takes down three mailboxes is one thing to go and fix.
  const down = snapshot.mailboxes
    .filter((m) => m.receiveOk === false && downForMs(m.receiveSince, now) >= MAIL_ALERT_THRESHOLDS.receiveDownMs)
    .sort((a, b) => downForMs(b.receiveSince, now) - downForMs(a.receiveSince, now));
  if (down.length) {
    out.push({
      kind: 'RECEIVE_DOWN',
      detail: {
        mailboxes: down.length,
        channelId: down[0].channelId,
        name: down[0].name,
        hours: Math.floor(downForMs(down[0].receiveSince, now) / 3_600_000),
        ...(down[0].receiveReason ? { reason: down[0].receiveReason } : {}),
      },
    });
  }

  if (snapshot.inbound.quarantined > 0) {
    out.push({ kind: 'INBOUND_QUARANTINED', detail: { count: snapshot.inbound.quarantined } });
  }
  return out;
}

/** An absent `since` reads as "down since forever" only once the lane is
 *  actually false — a missing timestamp must not create an alert on its own,
 *  which is why this is called after the `receiveOk === false` filter. */
function downForMs(since: string | undefined, now: Date): number {
  const at = Date.parse(since ?? '');
  return Number.isFinite(at) ? now.getTime() - at : MAIL_ALERT_THRESHOLDS.receiveDownMs;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── the service ─────────────────────────────────────────────────────────────

/** Ledger statuses, spelled once. */
const SENT = 'SENT';
const REFUSED = 'REFUSED';
const FAILED_PERMANENT = 'FAILED_PERMANENT';
const FAILED_TRANSIENT = 'FAILED_TRANSIENT';
const DEDUPED = 'DEDUPED';
const PENDING = 'PENDING';

const TOP_REASONS = 8;
/** An operator console lists mailboxes; it does not page through them. */
const MAX_MAILBOXES = 50;

@Injectable()
export class MailOpsService {
  private readonly logger = new Logger(MailOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budget: MailBudgetService,
    private readonly identity: SenderIdentityService,
  ) {}

  /**
   * One workspace's mail over a window.
   *
   * The quarantine count is the one number that is NOT windowed. A mail parked
   * last Tuesday is still a customer who never reached anyone, so a window
   * that hid it would make "0 quarantined" mean "none this week" while the
   * card promised "none".
   */
  async snapshot(workspaceId: string, window: MailOpsWindow): Promise<MailSnapshot> {
    const until = window.until ?? new Date();
    const createdAt = { gte: window.since, lt: until };
    const failures: string[] = [];

    const [byStatus, reasons, bounced, complained, inboundStates, quarantined, suppression, channels, daily, paused] =
      await Promise.all([
        this.guard(failures, 'send', () =>
          this.prisma.mailLog.groupBy({
            by: ['mailClass', 'status'],
            where: { workspaceId, createdAt },
            _count: { _all: true },
          }),
        ),
        this.guard(failures, 'reasons', () =>
          this.prisma.mailLog.groupBy({
            by: ['reason'],
            where: {
              workspaceId,
              createdAt,
              reason: { not: null },
              status: { in: [REFUSED, FAILED_PERMANENT, FAILED_TRANSIENT] },
            },
            _count: { _all: true },
          }),
        ),
        this.guard(failures, 'bounced', () =>
          this.prisma.mailLog.count({ where: { workspaceId, createdAt, bouncedAt: { not: null } } }),
        ),
        this.guard(failures, 'complained', () =>
          this.prisma.mailLog.count({
            where: { workspaceId, createdAt, complainedAt: { not: null } },
          }),
        ),
        this.guard(failures, 'inbound', () =>
          this.prisma.emailInboundItem.groupBy({
            by: ['state'],
            where: { workspaceId, updatedAt: createdAt },
            _count: { _all: true },
          }),
        ),
        this.guard(failures, 'quarantined', () =>
          this.prisma.emailInboundItem.count({ where: { workspaceId, state: 'QUARANTINED' } }),
        ),
        this.guard(failures, 'suppression', () =>
          this.prisma.contactSuppression.groupBy({
            by: ['reason'],
            where: { workspaceId, kind: 'EMAIL', liftedAt: null },
            _count: { _all: true },
          }),
        ),
        this.guard(failures, 'mailboxes', () =>
          this.prisma.channel.findMany({
            where: { workspaceId, type: 'EMAIL' },
            orderBy: { createdAt: 'asc' },
            take: MAX_MAILBOXES,
            select: {
              id: true,
              name: true,
              externalId: true,
              lastVerifiedAt: true,
              configPublic: true,
            },
          }),
        ),
        this.guard(failures, 'daily', () => this.budget.usage(workspaceId, until)),
        this.guard(failures, 'paused', () => this.readPaused(workspaceId)),
      ]);

    const parked = await this.guard(failures, 'parked', () =>
      this.prisma.emailInboundItem.groupBy({
        by: ['channelId'],
        where: { workspaceId, state: 'QUARANTINED' },
        _count: { _all: true },
      }),
    );

    const send = this.sendStats(byStatus ?? [], reasons ?? [], bounced ?? 0, complained ?? 0);
    return {
      workspaceId,
      since: window.since.toISOString(),
      until: until.toISOString(),
      send,
      byClass: this.classStats(byStatus ?? []),
      inbound: this.inboundStats(inboundStates ?? [], quarantined ?? 0),
      suppression: this.suppressionStats(suppression ?? []),
      mailboxes: this.mailboxes(channels ?? [], parked ?? []),
      daily: daily ?? { day: '', limit: 0, used: 0, remaining: -1 },
      paused: paused ?? false,
      partial: failures.length > 0,
    };
  }

  /**
   * The Settings → "E-posta sağlığı" card, and the same payload the operator
   * console reads per tenant: the snapshot plus who the mail is from and which
   * features this deployment leaves switched off.
   */
  async health(
    workspaceId: string,
    opts: { env?: Record<string, string | undefined>; now?: Date; windowMs?: number } = {},
  ): Promise<MailHealthReport> {
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - (opts.windowMs ?? 7 * 24 * 60 * 60 * 1000));
    const snapshot = await this.snapshot(workspaceId, { since, until: now });

    let identity: MailHealthReport['identity'] = null;
    let partial = snapshot.partial;
    try {
      // BULK is asked for deliberately: it is the strictest rung of the ladder,
      // so its answer is the one that tells a tenant whether a campaign will go
      // out under their own name. `config` carries the mailbox SECRETS and is
      // projected away here rather than filtered out downstream.
      const resolved = await this.identity.resolve(workspaceId, 'BULK' as MailClass);
      identity = {
        transport: resolved.transport,
        fromEmail: resolved.fromEmail,
        fromName: resolved.fromName,
        ...(resolved.replyTo ? { replyTo: resolved.replyTo } : {}),
        ...(resolved.degraded ? { degraded: resolved.degraded } : {}),
      };
    } catch (e: any) {
      this.logger.warn(`mail health identity failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      partial = true;
    }

    return { ...snapshot, partial, identity, inert: inertMailFeatures(opts.env ?? process.env) };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** A sub-read that fails costs its own number and nothing else (G2). */
  private async guard<T>(failures: string[], what: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (e: any) {
      failures.push(what);
      this.logger.warn(`mail ops ${what} read failed: ${e?.message ?? e}`);
      return null;
    }
  }

  private sendStats(
    rows: any[],
    reasonRows: any[],
    bounced: number,
    complained: number,
  ): MailSendStats {
    const n = (status: string) =>
      rows.filter((r) => r.status === status).reduce((a, r) => a + count(r), 0);
    const sent = n(SENT);
    const failedPermanent = n(FAILED_PERMANENT);
    const failedTransient = n(FAILED_TRANSIENT);
    const refused = n(REFUSED);
    const deduped = n(DEDUPED);
    const pending = n(PENDING);
    const attempted = sent + failedPermanent + failedTransient;
    return {
      total: sent + failedPermanent + failedTransient + refused + deduped + pending,
      sent,
      refused,
      failedPermanent,
      failedTransient,
      deduped,
      pending,
      attempted,
      bounced,
      complained,
      failureRate: rate(failedPermanent + failedTransient, attempted),
      bounceRate: rate(bounced, sent),
      complaintRate: rate(complained, sent),
      topReasons: reasonRows
        .map((r) => ({ reason: String(r.reason), count: count(r) }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, TOP_REASONS),
    };
  }

  private classStats(rows: any[]): Record<string, MailClassStats> {
    const out: Record<string, MailClassStats> = {};
    for (const r of rows) {
      const k = String(r.mailClass);
      const cell = (out[k] ??= { sent: 0, failed: 0, refused: 0 });
      if (r.status === SENT) cell.sent += count(r);
      else if (r.status === FAILED_PERMANENT || r.status === FAILED_TRANSIENT) cell.failed += count(r);
      else if (r.status === REFUSED) cell.refused += count(r);
    }
    return out;
  }

  private inboundStats(rows: any[], quarantined: number): MailInboundStats {
    const n = (state: string) =>
      rows.filter((r) => r.state === state).reduce((a, r) => a + count(r), 0);
    const done = n('DONE');
    const skipped = n('SKIPPED');
    const failed = n('FAILED');
    return { total: done + skipped + failed + n('NEW'), done, skipped, failed, quarantined };
  }

  private suppressionStats(rows: any[]): MailSuppressionStats {
    const byReason: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byReason[String(r.reason)] = count(r);
      total += count(r);
    }
    return { total, byReason };
  }

  private mailboxes(channels: any[], parked: any[]): MailboxSnapshot[] {
    const quarantinedBy = new Map<string, number>(
      parked.map((p) => [String(p.channelId), count(p)]),
    );
    return channels.map((c) => {
      const h: MailboxHealth = readMailboxHealth(c.configPublic);
      return {
        channelId: c.id,
        name: c.name ?? '',
        address: c.externalId ?? null,
        verified: !!c.lastVerifiedAt,
        sendOk: h.send ? h.send.ok : null,
        ...(h.send?.reason ? { sendReason: h.send.reason } : {}),
        ...(h.send?.lastError ? { sendError: h.send.lastError } : {}),
        receiveOk: h.receive ? h.receive.ok : null,
        ...(h.receive?.reason ? { receiveReason: h.receive.reason } : {}),
        ...(h.receive?.lastError ? { receiveError: h.receive.lastError } : {}),
        ...(h.receive?.since ? { receiveSince: h.receive.since } : {}),
        ...(h.backoffUntil ? { backoffUntil: h.backoffUntil } : {}),
        ...(h.oauthReauthRequiredAt ? { reauthRequiredAt: h.oauthReauthRequiredAt } : {}),
        ...(h.lastPolledAt ? { lastPolledAt: h.lastPolledAt } : {}),
        ...(h.lastMessageAt ? { lastMessageAt: h.lastMessageAt } : {}),
        quarantined: quarantinedBy.get(String(c.id)) ?? 0,
      };
    });
  }

  /** `settings.email.paused` — absent means "not paused", for every existing
   *  row (G3). The same reading `MailGuardService` makes. */
  private async readPaused(workspaceId: string): Promise<boolean> {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const settings = ws?.settings;
    if (!settings || typeof settings !== 'object') return false;
    const email = (settings as Record<string, unknown>).email;
    if (!email || typeof email !== 'object') return false;
    return (email as Record<string, unknown>).paused === true;
  }
}

function count(row: any): number {
  return Number(row?._count?._all ?? row?._count ?? 0) || 0;
}

/** A rate with no denominator is 0, never NaN — a NaN on a card reads as a bug
 *  in the card rather than as "nothing happened yet". */
function rate(n: number, of: number): number {
  return of > 0 ? n / of : 0;
}
