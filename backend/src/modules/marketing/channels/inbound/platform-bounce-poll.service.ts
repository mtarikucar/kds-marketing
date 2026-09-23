import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { SuppressionService } from '../../compliance/suppression.service';
import { normalizeMessageId } from '../email-message-id';
import { ImapTarget, ImapTargetRefusal, imapConnectOptions, imapTarget } from '../imap-target';
import {
  DeliveryReport,
  DeliveryReportSource,
  SuppressibleRecipient,
  parseDeliveryReport,
  suppressibleRecipients,
} from './delivery-report';
import { MAX_SOURCE_BYTES, rawMailFromParsed } from './inbound-mail.types';

const JOB_NAME = 'platform-bounce-poll';

/** Addresses for a log line — bounded, so one forged report cannot flood it. */
function addressList(targets: readonly SuppressibleRecipient[]): string {
  const shown = targets.slice(0, 5).map((t) => t.address);
  const rest = targets.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ');
}

/** Blast-radius bounds, not correctness mechanisms — every write below is
 *  idempotent, which is what makes a re-read harmless. */
const MAX_PER_TICK = 50;
const FIRST_RUN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_REPORT_PART_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;

/** Tries before an unreadable item is parked so the queue behind it moves. */
const MAX_ATTEMPTS = 3;

/** A MailLog id, which is what our own deterministic Message-ID's local part is. */
const MAIL_LOG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The report sub-parts worth pulling out of a mail too big to download whole. */
const REPORT_NODE_TYPES = new Set([
  'message/delivery-status',
  'message/feedback-report',
  'message/disposition-notification',
]);

/**
 * The returned-headers part of an oversize report, which has to come down with
 * it — it is where `Original-Message-ID` hides when the reporting MTA did not
 * write the field, and the id is now the AUTHORISATION for the suppression
 * rather than a bonus. Without this an oversize bounce could never be
 * attributed and would therefore never suppress. `message/rfc822` is excluded
 * on purpose: it is the whole returned mail, which is exactly the megabytes the
 * oversize path exists to avoid downloading.
 */
const RETURNED_HEADER_NODE_TYPES = new Set(['message/rfc822-headers', 'text/rfc822-headers']);

/** What one tick did — the shape the ops snapshot and the tests both read. */
export interface PlatformBounceTick {
  /** False when the platform mailbox is not configured: the cron is inert. */
  configured: boolean;
  /** Items examined, whatever they turned out to be. */
  examined: number;
  /** Delivery reports parsed. A read receipt is not one. */
  reports: number;
  /** Addresses handed to the suppression writer. */
  suppressed: number;
  /** Reports stamped back onto the ledger row they belong to. */
  attributed: number;
  /**
   * Reports that named an address but could not be proved to be about mail we
   * sent TO that address, so nothing was written. Never silent: each one is a
   * `warn`, because a genuine bounce landing here is the failure mode this
   * gate can cause and it has to be visible.
   */
  rejected: number;
  /** Items abandoned after `MAX_ATTEMPTS`, loudly. */
  parked: number;
}

/** The ledger row a report has to resolve to before it may suppress anything. */
interface OriginRow {
  id: string;
  workspaceId: string;
  toAddressNorm: string;
  campaignRecipientId: string | null;
}

/**
 * Read the PLATFORM's own mailbox for the bounces of the mail it sent.
 *
 * ## Why this exists
 *
 * Mail this deployment sends itself — an invoice, a quote, a workflow mail, a
 * campaign from a workspace with no mailbox of its own — leaves from
 * `EMAIL_USER` and its bounces come back to `EMAIL_USER`. Nobody read that
 * mailbox. So a hard-bounced invoice showed SENT forever, the dead address
 * stayed in every future audience, and the four `emailBouncedAt` guards that
 * already exist in this codebase (invoices, campaigns, distribution, outbound
 * conversations) had nothing to fire on (`platform-bounces-unobservable`).
 *
 * The tenant-mailbox path (`EmailImapPollService` → `delivery-report.ts`) covers
 * a workspace that connected its own mailbox. This covers everything sent
 * through the platform transport, which is what a workspace uses on its first
 * day. Between them, bounces work with **no ESP, no webhook secret, no DNS
 * change and no operator** — the ESP feed (`ESP_FEEDBACK_SECRET`) is an
 * optimisation on top, not the thing that makes suppression exist.
 *
 * ## It never writes to the mailbox
 *
 * READ-ONLY open, exactly as the tenant poller: a human reads `admin@`, and
 * marking their mail `\Seen` as a side effect of polling would quietly change
 * what their client shows them. `\Seen` is also useless as a cursor for the
 * same reason — the human gets there first.
 *
 * ## The cursor, and why a re-read is safe
 *
 * The position is held in this process, not in a row: there is no
 * workspace-less cursor store in the schema, and this package may not add a
 * table (the migration request is written up in the package handoff). That is
 * affordable ONLY because every write here is guarded to a no-op on a repeat:
 * `SuppressionService.suppress` upserts its `ContactSuppression` row on a
 * composite key and projects only onto leads that do not carry the flag yet,
 * and both attribution writes filter on the timestamp they are about to set. A
 * restart therefore re-reads at most `FIRST_RUN_LOOKBACK_MS` of mail and
 * changes nothing it already changed. (The one visible repeat is that a
 * re-asserted suppression un-lifts a suppression an operator cleared inside
 * that window — which is exactly what the previous writer's
 * `emailBouncedAt: null` guard did too, since a CLEAR_BOUNCE nulls it.)
 *
 * What the in-process cursor still guarantees is the rule that matters: it
 * never advances past an item that failed. A throw breaks the tick where it
 * stands, the item is retried on the next one, and after `MAX_ATTEMPTS` it is
 * parked with a loud `error` — head-of-line blocking is the real risk of
 * stopping, and silence is the failure mode this whole programme removes.
 *
 * ## A report is not a permission
 *
 * This mailbox is the publicly known `From` of every mail the platform sends,
 * so ANYONE can put a message in it. Nothing in SMTP authenticates a delivery
 * report: `From: MAILER-DAEMON@…` is free text, and an attacker sending from a
 * domain they own passes SPF and DKIM, so `assessAuth` cannot gate this lane
 * (it is recorded as a signal, never trusted as the answer).
 *
 * The one thing an outsider cannot fabricate is our own `MailLog.id`, which is
 * a v4 uuid and is the local part of the deterministic Message-ID on every mail
 * we send. So the gate is:
 *
 * 1. The report must carry an `Original-Message-ID` (or return our headers)
 *    that resolves to a real `MailLog` row. No row, no write.
 * 2. The address it asks us to suppress must equal that row's
 *    `toAddressNorm`. Every recipient of one of our mails holds a valid
 *    Message-ID, so attribution alone is not authorisation: without this check
 *    any lead who received a quote could forge a report quoting their own id
 *    and silence somebody else. `singleRecipient` is `always`, so one row is
 *    exactly one recipient and this is a one-to-one comparison — which also
 *    bounds one report to at most one suppressed address.
 *
 * The cost is stated rather than hidden: `Original-Message-ID` is optional in
 * RFC 3464, so the legacy prose-plus-`X-Failed-Recipients` NDRs that return
 * neither the field nor our headers are now DROPPED, and the dead address they
 * named stays mailable. That is the right trade against a writer with this
 * blast radius, but every drop is a `warn` and a `rejected` count — silence is
 * the failure mode this programme exists to remove.
 *
 * ## Who writes the suppression
 *
 * `SuppressionService`, scoped to the workspace of the resolved ledger row —
 * the same writer the two tenant lanes already use. It writes the
 * `ContactSuppression` audit row that tells the tenant WHY an address stopped
 * receiving mail and gives them a lift path, and it cannot reach another
 * tenant's leads. The global `EspFeedbackService` writer stays reachable only
 * from the HMAC-verified ESP webhook, which keeps its cross-workspace
 * arch-spec exemption pinned to one call site.
 *
 * ## Inert by default
 *
 * No `EMAIL_USER`/`EMAIL_PASSWORD`, or an `EMAIL_HOST` whose IMAP server we do
 * not know, and the cron no-ops after saying once what is missing. It does not
 * guess `imap.<whatever>`: a wrong host fails at login, every ten minutes,
 * against a server that counts the attempts.
 *
 * `PLATFORM_BOUNCE_POLL=off` stops it without a code deploy — an ops escape
 * hatch for the day this lane misbehaves against a live mailbox.
 */
@Injectable()
export class PlatformBouncePollService {
  private readonly logger = new Logger(PlatformBouncePollService.name);

  /** `uidValidity` + the highest uid this process has finished with. */
  private cursor: { uidValidity: string; lastUid: number } | null = null;
  /** Failed attempts per `uidValidity:uid`, for the poison-pill escape. */
  private readonly attempts = new Map<string, number>();
  /** So an inert deployment says what is missing once, not every ten minutes. */
  private inertAnnounced = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
  ) {}

  /**
   * Ten minutes: a bounce arrives within seconds of the send, and every tick
   * that does not happen is another mail to an address already known dead.
   * One mailbox on the whole platform, so the cost is one login.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: JOB_NAME })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      JOB_NAME,
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<PlatformBounceTick> {
    const tick: PlatformBounceTick = {
      configured: false,
      examined: 0,
      reports: 0,
      suppressed: 0,
      attributed: 0,
      rejected: 0,
      parked: 0,
    };

    const target = this.target();
    if (!target) return tick;
    tick.configured = true;
    // Armed again: if the credentials later disappear, that is a NEW fact and
    // has to be said out loud rather than swallowed by a flag set weeks ago.
    this.inertAnnounced = false;

    // The same resolver the tenant mailboxes connect through, so the TLS
    // decision cannot drift between the two pollers.
    const client = new ImapFlow(
      imapConnectOptions(target, {
        timeoutMs: CONNECT_TIMEOUT_MS,
        socketTimeoutMs: CONNECT_TIMEOUT_MS,
      }) as any,
    );

    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true } as any);
      try {
        await this.drain(client, tick);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return tick;
  }

  // ── the mailbox ───────────────────────────────────────────────────────────

  /**
   * Where the platform's bounces land, or null when nobody has configured one.
   *
   * The IMAP host is derived from the SMTP host we already send through, by the
   * same table the tenant mailboxes use. `EMAIL_IMAP_HOST`/`EMAIL_IMAP_PORT`
   * exist for a relay the table does not know; both are unset in this
   * deployment (GoDaddy is in the table) and nothing changes if they stay that
   * way.
   */
  private target(): ImapTarget | null {
    // The ops stop button. Reading a live human's mailbox on a ten-minute cron
    // is the kind of thing that has to be stoppable from the deploy settings,
    // not from a branch.
    if (/^(off|false|0|no)$/i.test(String(process.env.PLATFORM_BOUNCE_POLL ?? '').trim())) {
      this.announceInert('PLATFORM_BOUNCE_POLL is off');
      return null;
    }

    // Shaped as a channel's secrets so the platform mailbox resolves through
    // the SAME rules a tenant's does — host table, port, implicit TLS.
    const resolved = imapTarget({
      smtpUser: process.env.EMAIL_USER,
      smtpPass: process.env.EMAIL_PASSWORD,
      smtpHost: process.env.EMAIL_HOST,
      imapHost: process.env.EMAIL_IMAP_HOST,
      imapPort: process.env.EMAIL_IMAP_PORT,
    });
    if (resolved.kind === 'ok') return resolved.target;

    this.announceInert(
      resolved.reason === 'no-host'
        ? `no IMAP server is known for EMAIL_HOST=${process.env.EMAIL_HOST || 'unset'} — set EMAIL_IMAP_HOST`
        : 'EMAIL_USER / EMAIL_PASSWORD are not set',
    );
    return null;
  }

  private announceInert(what: string): void {
    if (this.inertAnnounced) return;
    this.inertAnnounced = true;
    this.logger.warn(
      `${JOB_NAME}: ${what} — bounces of platform mail are not being read (EMAIL_PASSWORD/EMAIL_USER gate this).`,
    );
  }

  // ── the tick ──────────────────────────────────────────────────────────────

  private async drain(client: ImapFlow, tick: PlatformBounceTick): Promise<void> {
    const mailbox: any = (client as any).mailbox;
    const uidValidity = String(mailbox?.uidValidity ?? '');

    // A renumbered mailbox makes every stored uid point at a different message,
    // or at none. Treat it as a first run rather than read from a meaningless
    // offset — and drop the attempt counters keyed on the old numbering.
    // Deliberately NOT cleared merely because there is no cursor yet: a first
    // run that keeps failing on its first item is exactly when the poison
    // counter has to survive into the next tick.
    if (this.cursor && this.cursor.uidValidity !== uidValidity) this.attempts.clear();
    const resume =
      this.cursor && this.cursor.uidValidity === uidValidity ? this.cursor.lastUid : null;

    let uids: number[];
    if (resume !== null) {
      uids = await this.searchUids(client, { uid: `${resume + 1}:*` });
      // `n:*` is never empty in IMAP — a server with nothing newer answers with
      // the highest uid it has, which we have already seen.
      uids = uids.filter((u) => u > resume);
    } else {
      uids = await this.searchUids(client, {
        since: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS),
      });
    }

    if (uids.length === 0) {
      this.cursor = { uidValidity, lastUid: resume ?? this.highestOf(mailbox) };
      return;
    }

    uids.sort((a, b) => a - b);
    let highest = resume ?? 0;

    for (const uid of uids.slice(0, MAX_PER_TICK)) {
      const key = `${uidValidity}:${uid}`;
      try {
        await this.examine(client, uid, uidValidity, tick);
        // INSIDE the try, after the work returned: a cursor that moves before
        // the item is settled is how mail disappears with nothing to show.
        highest = Math.max(highest, uid);
        tick.examined++;
        this.attempts.delete(key);
      } catch (e: any) {
        const failures = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, failures);
        const why = String(e?.message ?? e).slice(0, 300);
        if (failures >= MAX_ATTEMPTS) {
          // Parked, not dropped: the queue behind one unreadable report has to
          // move, and this line is the record that it was abandoned.
          this.logger.error(
            `${JOB_NAME}: uid=${uid} failed ${failures}× and is being skipped — ${why}`,
          );
          this.attempts.delete(key);
          highest = Math.max(highest, uid);
          tick.parked++;
          continue;
        }
        this.logger.warn(`${JOB_NAME}: uid=${uid} failed (attempt ${failures}) — ${why}`);
        break;
      }
    }

    // A first run whose very first item failed has nothing to remember: writing
    // `lastUid: 0` would drop the lookback window and put the next tick at the
    // top of the mailbox's whole history. Staying uncommitted re-reads the same
    // three days instead, which is the point of the window.
    if (highest > 0 || resume !== null) this.cursor = { uidValidity, lastUid: highest };
  }

  /** One item: read it, decide what it is, and act only on a report. */
  private async examine(
    client: ImapFlow,
    uid: number,
    uidValidity: string,
    tick: PlatformBounceTick,
  ): Promise<void> {
    // Size and structure BEFORE anything is downloaded — a bounce that returns
    // the original message can be megabytes, and the twenty lines we need are
    // in one small sub-part of it.
    const head: any = await (client as any).fetchOne(
      String(uid),
      { uid: true, size: true, internalDate: true, bodyStructure: true },
      { uid: true },
    );
    if (!head) return;

    const size = typeof head.size === 'number' ? head.size : null;
    const itemKey = `${uidValidity}:${uid}`;
    const source =
      size !== null && size > MAX_SOURCE_BYTES
        ? await this.oversizeSource(client, uid, head, itemKey)
        : await this.wholeSource(client, uid, head, itemKey);
    if (!source) return;

    const report = parseDeliveryReport(source);
    if (report.kind === 'NONE') return;
    if (report.kind === 'MDN') {
      // A read receipt means the customer OPENED it — the friendliest signal
      // there is, and the one thing that must never suppress an address.
      this.logger.debug(`${JOB_NAME}: uid=${uid} is a read receipt, not a bounce`);
      return;
    }

    const targets = suppressibleRecipients(report);
    tick.reports++;
    if (!targets.length) {
      // A 4.x.x, or a report with no status worth guessing at. Deliberately
      // nothing: suppressing a full mailbox kills a good customer's address.
      this.logger.debug(`${JOB_NAME}: uid=${uid} is a ${report.kind} with nothing to suppress`);
      return;
    }

    // THE GATE. Anyone can put a message in this mailbox, so the report has to
    // prove it is about a mail we sent, to the address it is asking us to
    // suppress, before a single row is written. See the class doc.
    const origin = await this.originOf(report);
    if (!origin) {
      tick.rejected++;
      this.logger.warn(
        `${JOB_NAME}: uid=${uid} is a ${report.kind} naming ${addressList(targets)} but does not ` +
          `resolve to any mail this deployment sent ` +
          `(Original-Message-ID=${(report.originalMessageId ?? 'absent').slice(0, 200)}) — nothing suppressed`,
      );
      return;
    }

    // One ledger row is exactly one recipient (`singleRecipient: 'always'`), so
    // this is a one-to-one match and caps the report at one address.
    const mine = targets.filter((t) => t.address === origin.toAddressNorm);
    const foreign = targets.filter((t) => t.address !== origin.toAddressNorm);
    if (foreign.length) {
      tick.rejected++;
      this.logger.warn(
        `${JOB_NAME}: uid=${uid} quotes mail ${origin.id} (sent to ${origin.toAddressNorm}) but reports ` +
          `${addressList(foreign)} — those addresses were NOT suppressed`,
      );
    }
    if (!mine.length) return;

    await this.suppress(origin, mine, uid);
    tick.suppressed += mine.length;
    if (await this.attribute(origin, mine)) tick.attributed++;
  }

  /** The whole message, for anything that fits under the source cap. */
  private async wholeSource(
    client: ImapFlow,
    uid: number,
    head: any,
    itemKey: string,
  ): Promise<DeliveryReportSource | null> {
    const full: any = await (client as any).fetchOne(
      String(uid),
      { uid: true, source: true },
      { uid: true },
    );
    if (!full?.source) return null;

    const parsed = await simpleParser(full.source);
    const mail = rawMailFromParsed(parsed, {
      source: 'imap',
      itemKey,
      // INTERNALDATE, never the sender-written `Date:` header.
      internalDate: head.internalDate ?? null,
      sizeBytes: typeof head.size === 'number' ? head.size : null,
    });
    return mail;
  }

  /**
   * A bounce too big to download: its headers and its report part only.
   *
   * This is the case the old poller dropped outright, and it is exactly the
   * wrong one to drop — a DSN that returns the original message is oversize
   * BECAUSE the mail that bounced had attachments.
   */
  private async oversizeSource(
    client: ImapFlow,
    uid: number,
    head: any,
    itemKey: string,
  ): Promise<DeliveryReportSource | null> {
    const node = this.findNode(head.bodyStructure, REPORT_NODE_TYPES);
    if (!node) {
      this.logger.debug(`${JOB_NAME}: uid=${uid} is oversize and carries no report part — skipped`);
      return null;
    }
    // Comes down in the SAME fetch: it is where `Original-Message-ID` hides,
    // and without the id an oversize bounce can no longer suppress anything.
    const returned = this.findNode(head.bodyStructure, RETURNED_HEADER_NODE_TYPES);

    const wanted = ['header', node.part, ...(returned ? [returned.part] : [])];
    const fetched: any = await (client as any).fetchOne(
      String(uid),
      { uid: true, bodyParts: wanted },
      { uid: true },
    );
    const reportText = this.bodyPart(fetched, node.part);
    if (!reportText) return null;

    const returnedText = returned ? this.bodyPart(fetched, returned.part) : null;

    const headerText = this.bodyPart(fetched, 'header') ?? '';
    const parsed = await simpleParser(headerText);
    const mail = rawMailFromParsed(parsed, {
      source: 'imap',
      itemKey,
      internalDate: head.internalDate ?? null,
      sizeBytes: typeof head.size === 'number' ? head.size : null,
      bodyTruncated: true,
    });
    return {
      ...mail,
      reportParts: [
        { contentType: node.type, text: reportText },
        ...(returned && returnedText ? [{ contentType: returned.type, text: returnedText }] : []),
      ],
      // The human preamble is not downloaded, so the `text` fallback the
      // parser uses for a folded delivery-status has nothing to offer here.
      text: null,
    };
  }

  /** Depth-first walk of a BODYSTRUCTURE for the first sub-part of a kind. */
  private findNode(node: any, types: ReadonlySet<string>): { part: string; type: string } | null {
    if (!node || typeof node !== 'object') return null;
    const type = String(node.type ?? '').toLowerCase();
    if (node.part && types.has(type)) return { part: String(node.part), type };
    for (const child of Array.isArray(node.childNodes) ? node.childNodes : []) {
      const hit = this.findNode(child, types);
      if (hit) return hit;
    }
    return null;
  }

  /** One fetched body part as text, bounded, however the client keys the map. */
  private bodyPart(fetched: any, part: string): string | null {
    const parts = fetched?.bodyParts;
    if (!parts || typeof parts.get !== 'function') return null;
    let value = parts.get(part);
    if (value === undefined) {
      const wanted = part.toLowerCase();
      for (const [key, candidate] of parts as Map<string, unknown>) {
        if (String(key).toLowerCase() === wanted) {
          value = candidate;
          break;
        }
      }
    }
    if (value === undefined || value === null) return null;
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    return text.slice(0, MAX_REPORT_PART_BYTES);
  }

  // ── the two writes ────────────────────────────────────────────────────────

  /**
   * Which mail this report is about — and therefore whether it may write.
   *
   * The hop is `Original-Message-ID` → `MailLog.id`, and it works because the
   * gateway's Message-ID is deterministic: its local part IS the ledger row's
   * id (`newMessageId(row.id, …)`), a v4 uuid nobody outside can guess. The
   * lookup is id-keyed rather than a cross-workspace scan, and the workspace
   * every write below is scoped by comes from OUR row, never from the report.
   */
  private async originOf(report: DeliveryReport): Promise<OriginRow | null> {
    const id = this.mailLogIdOf(report.originalMessageId);
    if (!id) return null;

    return this.prisma.mailLog.findUnique({
      where: { id },
      // `toAddressNorm` is the authorisation half: a report may only speak
      // about the address the mail it quotes was actually sent to.
      select: { id: true, workspaceId: true, toAddressNorm: true, campaignRecipientId: true },
    });
  }

  /**
   * Hand the address to the WORKSPACE-scoped suppression writer.
   *
   * `SuppressionService` also writes the `ContactSuppression` audit row, so the
   * tenant can see why the address stopped receiving mail and can lift it. A
   * write that failed THROWS, so the cursor does not move past this item and
   * the next tick reads it again. Losing a bounce is losing the only signal
   * that an address is dead.
   */
  private async suppress(
    origin: OriginRow,
    targets: SuppressibleRecipient[],
    uid: number,
  ): Promise<void> {
    for (const t of targets) {
      // A complaint is the PERSON refusing marketing; a hard bounce is an
      // address that does not exist. The two reasons ride different gates in
      // `GATE_MATRIX` on purpose (`esp-complaint-crosstenant`).
      await this.suppression.suppress(origin.workspaceId, t.address, 'EMAIL', t.reason, {
        source: 'dsn',
        note:
          [`platform bounce uid=${uid}`, t.status, t.diagnostic].filter(Boolean).join(' ').slice(0, 300) ||
          null,
      });
    }
  }

  /**
   * Stamp the bounce onto the ledger row it came from.
   *
   * Address-level suppression is what stops future sends; this is what makes
   * the one campaign row read BOUNCED.
   */
  private async attribute(row: OriginRow, targets: SuppressibleRecipient[]): Promise<boolean> {
    // One report is one fact: a hard bounce anywhere in it outranks a
    // complaint, because a dead address is the stronger statement.
    const complaint = targets.every((t) => t.reason === 'COMPLAINT');
    const at = new Date();
    const stamp = complaint ? { complainedAt: at } : { bouncedAt: at };
    // Guarded on the column being empty, which is what makes a re-read of the
    // same report a no-op rather than a second, later-dated event.
    const unset = complaint ? { complainedAt: null } : { bouncedAt: null };

    await this.prisma.mailLog.updateMany({
      where: { id: row.id, workspaceId: row.workspaceId, ...unset },
      data: stamp,
    });

    if (row.campaignRecipientId) {
      await this.prisma.campaignRecipient.updateMany({
        where: { id: row.campaignRecipientId, workspaceId: row.workspaceId, ...unset },
        // `status` stays the SEND outcome; these say what happened after it.
        data: { ...stamp, mailLogId: row.id },
      });
    }
    return true;
  }

  /** Our own ledger id out of a Message-ID, or null for anyone else's. */
  private mailLogIdOf(raw: string | null): string | null {
    // Normalised on BOTH sides of the lookup — ids arrive bracketed from a
    // header and bare from the ledger, and one unnormalised side means the
    // match simply never happens and nothing says so.
    const id = normalizeMessageId(raw);
    if (!id) return null;
    const at = id.lastIndexOf('@');
    const local = at > 0 ? id.slice(0, at) : id;
    return MAIL_LOG_ID_RE.test(local) ? local : null;
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  private async searchUids(client: ImapFlow, query: Record<string, unknown>): Promise<number[]> {
    const found = await (client as any).search(query, { uid: true });
    return Array.isArray(found)
      ? found.map((u: any) => Number(u)).filter((u: number) => Number.isFinite(u))
      : [];
  }

  private highestOf(mailbox: any): number {
    const next = Number(mailbox?.uidNext);
    return Number.isFinite(next) && next > 0 ? next - 1 : 0;
  }
}
