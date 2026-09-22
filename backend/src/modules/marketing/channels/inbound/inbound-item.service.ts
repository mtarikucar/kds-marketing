import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScheduledJobService } from '../../scheduling/scheduled-job.service';

/**
 * The inbound examine-ledger — one row per item the platform LOOKED AT on a
 * mailbox, whatever it then decided to do with it.
 *
 * It exists for one support question: *"my customer says they emailed us —
 * where did it go?"*. Before this row there were three possible answers and no
 * way to tell them apart: the mail was ingested and is in the inbox; the mail
 * was deliberately skipped (an auto-reply, a mailing list, a stranger under a
 * REPLIES_AND_KNOWN policy); or the ingest threw and the only trace was a
 * `logger.warn` on a box nobody can read. The first is visible in the product,
 * the other two were indistinguishable from "they never sent it".
 *
 * So every path writes here, including — especially — the paths that decide NOT
 * to ingest. A skip that records its reason is a product answer. A skip that
 * records nothing is a support ticket.
 *
 * ## Nothing here may break the poller
 *
 * Every method swallows its own failures and returns `null` (PLAN G2). A ledger
 * that can throw would take down the ingest it is supposed to be reporting on,
 * which is the defect inverted rather than fixed. The one exception is the
 * REPLAY path, which deliberately throws so the job runner can retry it — see
 * `inbound-retry.job.ts`.
 *
 * ## Bounded, then visible — never silently dropped
 *
 * A failure increments `attempts` and buys the item one `mail.inbound.retry`
 * job (dedupKey `inbound:<itemId>`, so repeated failures collapse onto one
 * queued row rather than piling up). After `INBOUND_MAX_ATTEMPTS` the item is
 * moved to `QUARANTINED` and the workspace owner is told once. Quarantine is a
 * PARK, not a delete: the row keeps the sender, the subject and the last error,
 * and `retry()` re-arms it behind the health card's "Tekrar dene" button.
 *
 * That bound is also what protects the poller from head-of-line blocking. A
 * poison item whose uid the cursor refuses to pass is re-examined on every
 * tick; each pass costs one attempt, so within three ticks it is parked and
 * named instead of blocking the mailbox forever.
 */

/** The ScheduledJob kind that re-fetches one failed item. */
export const INBOUND_RETRY_KIND = 'mail.inbound.retry';

/**
 * How many times one item may be examined-and-failed before it is parked.
 *
 * Three, not five: unlike a send, a failed ingest is re-attempted by the poller
 * itself on the next tick as well, so the effective number of tries is higher
 * than this number suggests. It is also the same N as the poller's poison-uid
 * escape, so the ledger parks the item in the same tick the cursor gives up on
 * it — two surfaces telling one story.
 */
export const INBOUND_MAX_ATTEMPTS = 3;

/** The `MarketingNotification.type` a parked item rings the bell with. */
export const INBOUND_STUCK_NOTIFICATION = 'EMAIL_INBOUND_STUCK';

export type InboundItemState = 'NEW' | 'DONE' | 'SKIPPED' | 'FAILED' | 'QUARANTINED';

/** Names one item on one mailbox. The unique key is (channelId, source, itemKey). */
export interface InboundItemKey {
  workspaceId: string;
  channelId: string;
  /** `imap` | `imap-sent` | `webhook` | `gmail` | `graph` | `platform-bounce` */
  source: string;
  /** `<uidValidity>:<uid>`, a provider historyId, a delivery id — whatever
   *  identifies the item ON THE SOURCE it came from, so a replay can ask for
   *  exactly it and nothing else. */
  itemKey: string;
}

/** What a human needs to recognise the mail in a list. All optional: an item
 *  that failed before it was parsed still deserves a row. */
export interface InboundItemFacts {
  messageId?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  receivedAt?: Date | null;
}

export interface InboundItemRef {
  id: string;
  state: InboundItemState;
  attempts: number;
}

/** Everything a source needs to fetch this one item back. */
export interface InboundReplayTarget extends InboundItemKey {
  id: string;
}

/**
 * A source's "fetch that one item again" function, registered by the service
 * that owns the connection (the IMAP poller, the Sent poller, …).
 *
 * Two obligations, both load-bearing:
 *  - It MUST settle the row (`done`/`skipped`/`failed`). A replay that returns
 *    without settling leaves the item at NEW with no further retry queued —
 *    visible in the ledger, but stuck.
 *  - It MUST throw on failure. The runner's backoff IS the retry schedule, and
 *    a replayer that swallows its error reports success for mail that never
 *    landed, which is the silence this whole package exists to remove.
 */
export type InboundReplayer = (target: InboundReplayTarget) => Promise<void>;

export type InboundRetryResult =
  | { ok: true; jobId: string | null }
  | { ok: false; reason: 'not-found' | 'no-replayer' | 'schedule-failed' };

/** Long enough to hold a real SMTP/IMAP diagnostic, short enough for a list row. */
const MAX_ERROR = 500;
const MAX_SUBJECT = 500;
const MAX_ADDRESS = 320;
const MAX_REASON = 120;

function trim(v: string | null | undefined, max: number): string | null {
  const s = (v ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
}

type ItemRow = {
  id: string;
  workspaceId: string;
  channelId: string;
  source: string;
  itemKey: string;
  state: string;
  attempts: number;
  fromAddress?: string | null;
  subject?: string | null;
};

const ROW_SELECT = {
  id: true,
  workspaceId: true,
  channelId: true,
  source: true,
  itemKey: true,
  state: true,
  attempts: true,
  fromAddress: true,
  subject: true,
} as const;

@Injectable()
export class InboundItemService {
  private readonly logger = new Logger(InboundItemService.name);
  private readonly replayers = new Map<string, InboundReplayer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: ScheduledJobService,
  ) {}

  /**
   * A source declares how to fetch one of its items back.
   *
   * Registered by the owning poller in `onModuleInit`, mirroring how features
   * register their ScheduledJob handlers. The ledger deliberately does NOT
   * reach into the pollers itself: it would have to know every transport, and
   * the import cycle (poller → ledger → poller) is the kind that only shows up
   * as an undefined dependency at boot.
   */
  registerReplayer(source: string, fn: InboundReplayer): void {
    this.replayers.set(source, fn);
  }

  replayerFor(source: string): InboundReplayer | undefined {
    return this.replayers.get(source);
  }

  /**
   * "I am about to process this item."
   *
   * Written BEFORE the work, so a crash mid-ingest leaves a visible NEW row
   * rather than nothing at all. On an item that already settled it refreshes
   * the facts and leaves the state alone — re-examining a uid the poller
   * already ingested must not un-ingest it.
   */
  async open(key: InboundItemKey, facts: InboundItemFacts = {}): Promise<InboundItemRef | null> {
    return this.write(key, { create: { state: 'NEW' }, update: {} }, facts);
  }

  /** The item was ingested. */
  /**
   * The item was ingested.
   *
   * `reason` is optional and describes HOW, not whether: the only value any
   * caller passes today is `'oversize-truncated'`, for a mail whose body was
   * too big to pull whole and was read selectively. It is what lets the health
   * card distinguish "we have all of this" from "we have the text and named
   * the attachments" — a DONE row with no marker cannot say that, and the byte
   * size only ever reached a `warn` line.
   */
  async done(
    key: InboundItemKey,
    facts: InboundItemFacts = {},
    reason?: string,
  ): Promise<InboundItemRef | null> {
    // `null` and not `undefined`: an ordinary second pass over a row that was
    // once truncated must CLEAR the marker, not silently keep it.
    const r = reason ? trim(reason, MAX_REASON) : null;
    return this.write(
      key,
      {
        create: { state: 'DONE', reason: r, lastError: null },
        update: { state: 'DONE', reason: r, lastError: null },
      },
      facts,
    );
  }

  /**
   * The item was examined and deliberately NOT ingested — and this is why.
   *
   * `reason` is a stable code (`'auto-reply'`, `'dsn'`, `'policy-not-a-lead'`,
   * `'oversize-truncated'`, …), never a sentence: the UI translates it (G8) and
   * support greps it.
   */
  async skipped(
    key: InboundItemKey,
    reason: string,
    facts: InboundItemFacts = {},
  ): Promise<InboundItemRef | null> {
    const r = trim(reason, MAX_REASON);
    return this.write(
      key,
      {
        create: { state: 'SKIPPED', reason: r, lastError: null },
        update: { state: 'SKIPPED', reason: r, lastError: null },
      },
      facts,
    );
  }

  /**
   * The item could not be ingested.
   *
   * Records the error, spends one attempt, and then either buys a retry or —
   * when the attempts are gone — parks the item and tells the owner. Returns
   * the settled state so the caller can log which of the two happened.
   */
  async failed(
    key: InboundItemKey,
    error: string,
    facts: InboundItemFacts = {},
  ): Promise<InboundItemRef | null> {
    const lastError = trim(error, MAX_ERROR) ?? 'unknown error';
    // The state is NOT set by the upsert: the decision below needs to see what
    // the row was BEFORE this failure (an item already quarantined must not be
    // re-parked and the owner must not be told twice).
    const row = await this.upsert(
      key,
      {
        create: { state: 'FAILED', attempts: 1, lastError },
        update: { attempts: { increment: 1 }, lastError },
      },
      facts,
    );
    if (!row) return null;

    if (row.state === 'QUARANTINED') {
      return { id: row.id, state: 'QUARANTINED', attempts: row.attempts };
    }
    if (row.attempts >= INBOUND_MAX_ATTEMPTS) {
      await this.park(row, lastError);
      return { id: row.id, state: 'QUARANTINED', attempts: row.attempts };
    }
    // The upsert leaves the state alone so the decision above can see what the
    // row WAS; a row created by this very call is already FAILED.
    if (row.state !== 'FAILED') await this.setState(row.id, key.workspaceId, 'FAILED');
    await this.scheduleRetry(row.workspaceId, row.id);
    return { id: row.id, state: 'FAILED', attempts: row.attempts };
  }

  /**
   * Park an item for a human. Called by `failed()` and by the retry job's
   * exhaustion hook, which is the path that catches a replayer that keeps
   * throwing after the poller has long moved on.
   *
   * Idempotent, and a no-op on an item that got through in the meantime — a
   * DONE row must never be re-opened as a problem by a late DLQ hook.
   */
  async quarantine(workspaceId: string, itemId: string, error: string): Promise<void> {
    try {
      const row = await this.prisma.emailInboundItem.findFirst({
        where: { id: itemId, workspaceId },
        select: ROW_SELECT,
      });
      if (!row) return;
      if (row.state === 'DONE' || row.state === 'SKIPPED' || row.state === 'QUARANTINED') return;
      await this.park(row, trim(error, MAX_ERROR) ?? 'unknown error');
    } catch (e: any) {
      this.logger.warn(
        `inbound quarantine failed (workspace=${workspaceId}, item=${itemId}): ${e?.message ?? e}`,
      );
    }
  }

  /** One mailbox's ledger, newest first — the health card's list. */
  async listForChannel(
    workspaceId: string,
    channelId: string,
    opts: { state?: InboundItemState; limit?: number } = {},
  ) {
    try {
      return await this.prisma.emailInboundItem.findMany({
        where: { workspaceId, channelId, ...(opts.state ? { state: opts.state } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: Math.min(Math.max(opts.limit ?? 50, 1), 100),
        select: {
          id: true,
          source: true,
          itemKey: true,
          state: true,
          reason: true,
          attempts: true,
          lastError: true,
          fromAddress: true,
          subject: true,
          receivedAt: true,
          messageId: true,
          updatedAt: true,
        },
      });
    } catch (e: any) {
      this.logger.warn(
        `inbound ledger read failed (workspace=${workspaceId}, channel=${channelId}): ${e?.message ?? e}`,
      );
      return [];
    }
  }

  /** One row, workspace-scoped. The retry job reads the item here rather than
   *  trusting its own payload, so a stale queued job can never replay a uid the
   *  row no longer names. */
  async get(workspaceId: string, itemId: string): Promise<ItemRow | null> {
    try {
      return await this.prisma.emailInboundItem.findFirst({
        where: { id: itemId, workspaceId },
        select: ROW_SELECT,
      });
    } catch (e: any) {
      this.logger.warn(
        `inbound ledger get failed (workspace=${workspaceId}, item=${itemId}): ${e?.message ?? e}`,
      );
      return null;
    }
  }

  /**
   * "Tekrar dene" — re-arm a parked item and queue its replay.
   *
   * Returns a discriminated result rather than throwing (G2), and refuses
   * up-front when no source can perform the replay: queueing a job that is
   * certain to DLQ would tell the user "retrying…" and then quietly park the
   * item again, which is the silence this whole package removes.
   */
  async retry(workspaceId: string, itemId: string): Promise<InboundRetryResult> {
    const row = await this.get(workspaceId, itemId);
    if (!row) return { ok: false, reason: 'not-found' };
    if (!this.replayers.has(row.source)) return { ok: false, reason: 'no-replayer' };
    try {
      await this.prisma.emailInboundItem.update({
        where: { id: row.id },
        data: { state: 'NEW', attempts: 0, lastError: null },
      });
    } catch (e: any) {
      this.logger.warn(`inbound retry re-arm failed (item=${itemId}): ${e?.message ?? e}`);
      return { ok: false, reason: 'not-found' };
    }
    const jobId = await this.scheduleRetry(row.workspaceId, row.id);
    return jobId === null ? { ok: false, reason: 'schedule-failed' } : { ok: true, jobId };
  }

  // ---------------------------------------------------------------- internals

  /** The shared upsert + the `null` contract the callers rely on. */
  private async write(
    key: InboundItemKey,
    states: { create: Record<string, unknown>; update: Record<string, unknown> },
    facts: InboundItemFacts,
  ): Promise<InboundItemRef | null> {
    const row = await this.upsert(key, states, facts);
    return row ? { id: row.id, state: row.state as InboundItemState, attempts: row.attempts } : null;
  }

  private async upsert(
    key: InboundItemKey,
    states: { create: Record<string, unknown>; update: Record<string, unknown> },
    facts: InboundItemFacts,
  ): Promise<ItemRow | null> {
    if (!key.workspaceId || !key.channelId || !key.source || !key.itemKey) return null;
    const f = factsData(facts);
    try {
      return await this.prisma.emailInboundItem.upsert({
        where: {
          channelId_source_itemKey: {
            channelId: key.channelId,
            source: key.source,
            itemKey: key.itemKey,
          },
        },
        create: {
          workspaceId: key.workspaceId,
          channelId: key.channelId,
          source: key.source,
          itemKey: key.itemKey,
          ...states.create,
          ...f,
        },
        // Only the facts this pass actually learned are written. A retry that
        // dies before it parses anything knows the uid and nothing else, and
        // blanking the sender/subject recorded on the first pass would make the
        // row unreadable exactly when someone is reading it.
        update: { ...states.update, ...f },
        select: ROW_SELECT,
      });
    } catch (e: any) {
      this.logger.warn(
        `inbound ledger write failed (workspace=${key.workspaceId}, channel=${key.channelId}, item=${key.itemKey}): ${e?.message ?? e}`,
      );
      return null;
    }
  }

  private async setState(
    itemId: string,
    workspaceId: string,
    state: InboundItemState,
  ): Promise<void> {
    try {
      await this.prisma.emailInboundItem.update({ where: { id: itemId }, data: { state } });
    } catch (e: any) {
      this.logger.warn(
        `inbound ledger state write failed (workspace=${workspaceId}, item=${itemId}): ${e?.message ?? e}`,
      );
    }
  }

  private async park(row: ItemRow, error: string): Promise<void> {
    await this.setState(row.id, row.workspaceId, 'QUARANTINED');
    await this.notifyOwner(row, error);
  }

  private async scheduleRetry(workspaceId: string, itemId: string): Promise<string | null> {
    try {
      return await this.jobs.schedule({
        workspaceId,
        kind: INBOUND_RETRY_KIND,
        runAt: new Date(),
        // Only the two ids: the handler re-reads the row, so a queued job can
        // never carry a stale channel/uid into a replay.
        payload: { itemId, workspaceId },
        dedupKey: `inbound:${itemId}`,
        maxAttempts: INBOUND_MAX_ATTEMPTS,
      });
    } catch (e: any) {
      // The FAILED row is already written and visible; a queue outage must not
      // turn a recorded failure into an unrecorded one.
      this.logger.warn(`inbound retry schedule failed (item=${itemId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Tell the owner, once, that a mail did not make it in.
   *
   * The notification is what makes the quarantine a product event instead of a
   * database state. Best-effort: a workspace with no active owner (an agency
   * child mid-setup) still gets the parked row, which the mailbox health card
   * reads.
   *
   * ONE unread notice per mailbox, not one per mail. The failure mode that
   * parks items is almost never a single bad mail — it is a mailbox-wide
   * outage, which would otherwise ring the bell once for every message in the
   * backlog and bury the very notice it is trying to deliver. The card lists
   * the individual rows; the bell only has to get the owner to the card.
   */
  private async notifyOwner(row: ItemRow, error: string): Promise<void> {
    try {
      const owner = await this.prisma.workspaceMembership.findFirst({
        where: { workspaceId: row.workspaceId, role: 'OWNER', status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { userId: true },
      });
      if (!owner) return;
      const pending = await this.prisma.marketingNotification.findFirst({
        where: {
          workspaceId: row.workspaceId,
          userId: owner.userId,
          type: INBOUND_STUCK_NOTIFICATION,
          isRead: false,
          metadata: { path: ['channelId'], equals: row.channelId } as never,
        },
        select: { id: true },
      });
      if (pending) return;
      const who = row.fromAddress ? ` (${row.fromAddress})` : '';
      await this.prisma.marketingNotification.create({
        data: {
          workspaceId: row.workspaceId,
          userId: owner.userId,
          type: INBOUND_STUCK_NOTIFICATION,
          title: 'Bir e-posta gelen kutusuna alınamadı',
          message: `${row.subject ?? 'Konusuz e-posta'}${who} — birkaç denemeden sonra alınamadı. Posta kutusu sağlık kartından tekrar deneyebilirsiniz.`.slice(
            0,
            500,
          ),
          // `copyKey` is the stable handle the panel translates (G8); the
          // literal title/message above are the fallback for a bell that
          // renders the row as written.
          metadata: {
            copyKey: 'inbound.quarantined',
            channelId: row.channelId,
            itemId: row.id,
            source: row.source,
            itemKey: row.itemKey,
            error,
          },
        },
      });
    } catch (e: any) {
      this.logger.warn(
        `inbound quarantine notification skipped (workspace=${row.workspaceId}, item=${row.id}): ${e?.message ?? e}`,
      );
    }
  }
}

/** Only the keys this pass actually learned — see the `update` comment above. */
function factsData(facts: InboundItemFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const messageId = trim(facts.messageId, MAX_ADDRESS);
  if (messageId) out.messageId = messageId;
  const fromAddress = trim(facts.fromAddress, MAX_ADDRESS);
  if (fromAddress) out.fromAddress = fromAddress;
  const subject = trim(facts.subject, MAX_SUBJECT);
  if (subject) out.subject = subject;
  if (facts.receivedAt instanceof Date && !Number.isNaN(facts.receivedAt.getTime())) {
    out.receivedAt = facts.receivedAt;
  }
  return out;
}
