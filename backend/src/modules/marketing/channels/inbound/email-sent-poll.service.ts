import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { normalizeAddress } from '../../../../common/util/email-address';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { ConversationIngressService } from '../conversation-ingress.service';
import {
  InboundItemFacts,
  InboundItemKey,
  InboundItemService,
  InboundReplayTarget,
} from './inbound-item.service';
import { InboundMessage } from '../channel-adapter.interface';
import { imapConnectOptions, imapTarget } from '../imap-target';
import { isMailboxBackedOff } from '../mailbox-health.service';
import { mergeConfigPublic } from '../config-public.merge';
import { stripQuotedReply, truncateHtmlQuote } from '../email-reply-text';
import { classifyMail, isDaemonSender } from './mail-classify';
import {
  InboundSkipReason,
  isOversize,
  primaryAddress,
  primaryName,
  rawMailFromParsed,
  RawMail,
} from './inbound-mail.types';

/** The ledger source this reconciler writes under. The INBOX poller uses
 *  `imap`, so the same uid in two folders is two rows and not a collision. */
const SENT_SOURCE = 'imap-sent';

/** The Channel-row shape this reconciler reads — an explicit `select`, mirroring
 *  EmailImapPollService so the two cannot drift on what a mailbox even is. */
interface ChannelRow {
  id: string;
  workspaceId: string;
  type: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/** Where the cursor stopped, and whether one item is refusing to go through. */
interface SentCursor {
  lastUid: number;
  uidValidity: string;
}

interface FailState {
  uid: number;
  uidValidity: string;
  count: number;
}

/** Blast-radius bounds, not correctness mechanisms. */
const MAX_PER_TICK = 50;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_ECHO_CHARS = 8000;

/**
 * How many ticks one item may block the cursor before it is parked.
 *
 * Three is a compromise between the two ways this goes wrong. Stopping forever
 * is head-of-line blocking: one unparseable mail from last Tuesday and no echo
 * has been recorded since. Advancing immediately is the loss this whole
 * programme exists to remove. Three ticks is ~30 minutes, long enough for a
 * database blip to pass and short enough that a genuinely poisonous item does
 * not hold the folder hostage.
 */
const MAX_ITEM_ATTEMPTS = 3;

/**
 * Folder names that mean "Sent" on a server that does not advertise SPECIAL-USE.
 *
 * Matched against the folder list the server itself returned, never guessed at
 * blindly: the worst case is that we open a folder the server really has and
 * find nothing in it, and the common case is an older cPanel/Plesk box whose
 * `Sent` is exactly this. Lower-cased comparison; the Turkish and German names
 * are here because the two mailbox providers this product actually meets are
 * localised.
 */
const SENT_FOLDER_NAMES = new Set([
  'sent',
  'sent items',
  'sent mail',
  'sent messages',
  'inbox.sent',
  'inbox/sent',
  '[gmail]/sent mail',
  'gönderilmiş öğeler',
  'gönderilenler',
  'gönderilmiş',
  'gesendet',
  'gesendete elemente',
  'éléments envoyés',
  'elementos enviados',
]);

/** The body stands in for content nobody read. It says so, in so many words. */
const UNREAD_BODY = '[büyük e-posta — içerik okunamadı]';

/**
 * Read back what the owner answered from Outlook, Gmail or their phone.
 *
 * ## Why this exists
 *
 * A workspace connects its mailbox and the panel starts showing the customer's
 * half of every thread. The owner's half is still written where it always was
 * — in Outlook, in the Gmail web client, in Mail on a phone — and none of that
 * reaches this product. So the Inbox shows a question nobody answered, the
 * daily digest lists it as waiting, `waiting-reply-leads` chases it, and the
 * AI, seeing an unanswered customer, answers it a second time and differently
 * (`sent-folder-unread`).
 *
 * Every one of those consumers compares `lastInboundAt` against
 * `lastMessageAt`. Putting the owner's own reply into the thread as what it is
 * — outbound, from the team, already sent — repairs all four at once, and it is
 * exactly what the Meta channels already do with `is_echo`.
 *
 * ## It is OFF until somebody turns it on
 *
 * `configPublic.readSentFolder` defaults to absent, which is off. A mailbox
 * that has been connected for months keeps behaving precisely as it did
 * yesterday; only a workspace that asks for this gets it. Reading a folder
 * nobody expected us to read is not the kind of surprise a mail product may
 * spring on a tenant.
 *
 * ## The four ways this goes wrong, and what stops each
 *
 * 1. **Our own sends are in Sent too.** Gmail and Outlook save an SMTP send
 *    server-side, so the mail this product just sent is sitting in the folder
 *    within seconds. Ingesting it would file a second OUTBOUND row beside the
 *    one the send already wrote. `alreadyOurs` asks the outbound ledger, the
 *    conversation messages and the campaign recipients — **in both Message-ID
 *    spellings**, because nodemailer persisted ids WITH angle brackets and
 *    every inbound path strips them, so a naive equality check matches nothing
 *    and silently doubles every thread.
 * 2. **Campaign mail is in Sent too.** A 400-recipient blast left the same
 *    mailbox, and 400 echoes is 400 conversations with 400 leads. Anything
 *    carrying RFC 8058 `List-Unsubscribe` is dropped on the header alone,
 *    before a single query is spent on it.
 * 3. **`aiPaused` would silence the AI forever.** The AI's own replies are in
 *    Sent as well, so "a message in Sent means a human took over" pauses the
 *    assistant permanently after its first answer — and it would make the same
 *    human action behave differently on email than on Instagram, where the
 *    sibling path deliberately does not set it. Bumping `lastMessageAt`, which
 *    `ConversationIngressService` already does for an echo, is the whole fix.
 * 4. **The envelope is inverted.** An echo's counterpart is the RECIPIENT.
 *    Keying it off `From` would resolve every message in the folder to the
 *    workspace's own address and collapse the entire Sent folder into one
 *    bogus self-thread.
 *
 * ## Never losing an item
 *
 * The cursor advances only over items that were actually examined to a
 * conclusion. A throw stops the folder where it stands rather than stepping
 * over unread mail; the same item is retried on the next tick, and after
 * `MAX_ITEM_ATTEMPTS` it is parked with a `logger.error` that names it, never
 * dropped in silence.
 */
@Injectable()
export class EmailSentPollService implements OnModuleInit {
  private readonly logger = new Logger(EmailSentPollService.name);

  onModuleInit(): void {
    // The retry job knows WHICH item to fetch again; only this service knows
    // how to fetch one uid out of one mailbox's Sent folder.
    this.items?.registerReplayer(SENT_SOURCE, (target) => this.replay(target));
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
    /** Optional so a unit test — or a deployment that has not wired the ledger
     *  — still reconciles. A missing ledger costs the audit trail, never mail. */
    @Optional() private readonly items?: InboundItemService,
  ) {}

  /** This item, as the ledger keys it. Its own `source`, so a Sent echo and an
   *  INBOX mail with the same uid are two rows and not one. */
  private itemKey(channel: ChannelRow, uidValidity: string, uid: number): InboundItemKey {
    return {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      source: SENT_SOURCE,
      itemKey: `${uidValidity}:${uid}`,
    };
  }

  /**
   * Every ledger write, swallowed.
   *
   * A bookkeeping failure must never take down the reconcile it is bookkeeping
   * for — and here it must especially not THROW, because a throw in this loop
   * holds the cursor and stops the folder where it stands.
   */
  private async ledger<T>(fn: (l: InboundItemService) => Promise<T>): Promise<T | null> {
    if (!this.items) return null;
    try {
      return await fn(this.items);
    } catch (e: any) {
      this.logger.debug(
        `email-sent-poll: inbound ledger write failed: ${String(e?.message ?? e).slice(0, 200)}`,
      );
      return null;
    }
  }

  /** A recorded non-echo. `false` to the caller, a row to whoever asks later. */
  private async skip(
    key: InboundItemKey,
    reason: InboundSkipReason,
    detail: string,
    facts?: InboundItemFacts,
  ): Promise<false> {
    this.logger.debug(`email-sent-poll: ${key.itemKey} skipped — ${reason}: ${detail}`);
    await this.ledger((l) => l.skipped(key, reason, facts));
    return false;
  }

  /**
   * Ten minutes, not five.
   *
   * This is reconciliation, not delivery. Nobody is waiting on it: the person
   * whose reply this is already knows they sent it, and the customer already
   * has it. The INBOX poller runs at five because a customer IS waiting there.
   * Halving the rate here halves the number of extra IMAP connections this
   * product opens against every mailbox on the platform, for no cost anyone
   * can see.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'email-sent-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'email-sent-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ ingested: number; mailboxes: number }> {
    if (!this.registry.has('EMAIL')) return { ingested: 0, mailboxes: 0 };
    const channels = (await this.prisma.channel.findMany({
      // `lastVerifiedAt` is written only when a health check PASSED — the same
      // bar the INBOX poller sets. Logging in every ten minutes with a password
      // nobody proved is how a mail host starts counting failures against us.
      where: { type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    })) as ChannelRow[];

    let ingested = 0;
    let mailboxes = 0;
    for (const channel of channels) {
      // The same wait the INBOX poller and the IDLE hold honour. This is the
      // third connection this module opens against every mailbox, and the one
      // nobody is waiting on — a credential that has already been refused must
      // not be retried from here either, or the tenant's account is locked out
      // by a reconciliation job.
      //
      // The skip only, no health WRITE: the INBOX poller owns the receive
      // lane's health block, and two writers on one JSON column is a
      // read-modify-write race for no gain.
      if (isMailboxBackedOff(channel.configPublic)) continue;
      try {
        const n = await this.pollChannel(channel);
        if (n !== null) {
          mailboxes++;
          ingested += n;
        }
      } catch (e: any) {
        // Per-channel, exactly like the INBOX poller: one unreachable mailbox
        // must not stop the other tenants' reconciliation.
        this.logger.warn(
          `email-sent-poll: channel=${channel.id} failed: ${String(e?.message ?? e).slice(0, 300)}`,
        );
      }
    }
    return { ingested, mailboxes };
  }

  /** Reconcile one mailbox NOW, by id. Scoped by workspace even though the
   *  caller holds a primary key — a read that carries the tenant is one fewer
   *  place where a wrong id becomes a cross-tenant one. */
  async pollOne(workspaceId: string, channelId: string): Promise<number | null> {
    const channel = (await this.prisma.channel.findFirst({
      where: { id: channelId, workspaceId, type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    })) as ChannelRow | null;
    if (!channel) return null;
    try {
      return await this.pollChannel(channel);
    } catch (e: any) {
      this.logger.warn(
        `email-sent-poll: on-demand reconcile failed for channel=${channelId}: ${String(e?.message ?? e).slice(0, 300)}`,
      );
      return null;
    }
  }

  /** Null means "not a Sent-readable mailbox" — the knob is off, there is no
   *  IMAP host, or the server has no Sent folder — as opposed to "read it and
   *  found nothing". */
  private async pollChannel(channel: ChannelRow): Promise<number | null> {
    // The opt-in gate comes FIRST, before credentials are opened and long
    // before a socket is created: a channel that never asked for this must not
    // even produce a login attempt.
    if (!this.readSentEnabled(channel.configPublic)) return null;

    const config = this.registry.resolveConfig(channel as any);
    // Host, port, TLS and credentials all through the SHARED resolver. This
    // file had its own copy with `secure: true` hard-coded — the very drift
    // `imapTarget()` exists to make impossible: on port 143 that fails the
    // handshake outright, so a mailbox whose INBOX polls happily could never
    // sync its Sent folder and nothing said why.
    const resolved = imapTarget((config.secrets ?? {}) as Record<string, string | undefined>);
    if (resolved.kind !== 'ok') {
      // Debug, not warn: an unrecognised provider or a send-only consent
      // mailbox is an expected state, not a fault to shout about every tick.
      this.logger.debug(
        `email-sent-poll: channel=${channel.id} is not IMAP-pollable (${resolved.reason}) — skipping`,
      );
      return null;
    }

    const client = new ImapFlow(
      imapConnectOptions(resolved.target, {
        timeoutMs: CONNECT_TIMEOUT_MS,
        socketTimeoutMs: CONNECT_TIMEOUT_MS,
      }) as any,
    );

    await client.connect();
    try {
      const path = await this.findSentFolder(client);
      if (!path) {
        this.logger.debug(`email-sent-poll: channel=${channel.id} has no Sent folder — skipping`);
        return null;
      }
      // READ-ONLY, for the same reason the INBOX poller is: a human reads this
      // mailbox, and polling must never change what their mail client shows.
      const lock = await client.getMailboxLock(path, { readOnly: true } as any);
      try {
        return await this.drain(client, channel, config);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * Fetch back exactly ONE item the ledger is still holding.
   *
   * Registered as the `imap-sent` replayer, so it honours that contract: it
   * settles the row itself (`ingestUid` writes DONE or SKIPPED) and it THROWS
   * when it cannot, because the job runner's backoff IS the retry schedule and
   * a replayer that swallows its error reports success for an echo that was
   * never filed.
   *
   * The stored `uidValidity` is re-checked against the live folder first:
   * after a renumbering that uid names somebody else's mail, and "that uid and
   * no other" is the whole contract.
   */
  async replay(target: InboundReplayTarget): Promise<void> {
    const [uidValidity, rawUid] = String(target.itemKey ?? '').split(':');
    const uid = Number(rawUid);
    if (!uidValidity || !Number.isFinite(uid) || uid <= 0) {
      throw new Error(`email-sent-poll: unusable item key "${target.itemKey}"`);
    }

    const channel = (await this.prisma.channel.findFirst({
      // Scoped by workspace even though the caller holds a primary key: the id
      // came from another service's row, and a read that carries the tenant is
      // one fewer place where a wrong id becomes a cross-tenant one.
      where: {
        id: target.channelId,
        workspaceId: target.workspaceId,
        type: 'EMAIL',
        status: 'ACTIVE',
        lastVerifiedAt: { not: null },
      },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    })) as ChannelRow | null;
    if (!channel) throw new Error(`email-sent-poll: channel=${target.channelId} is no longer pollable`);
    if (!this.readSentEnabled(channel.configPublic)) {
      throw new Error(`email-sent-poll: channel=${target.channelId} no longer reads its Sent folder`);
    }

    const config = this.registry.resolveConfig(channel as any);
    const resolved = imapTarget((config.secrets ?? {}) as Record<string, string | undefined>);
    if (resolved.kind !== 'ok') {
      throw new Error(`email-sent-poll: channel=${target.channelId} is not IMAP-readable (${resolved.reason})`);
    }
    const client = new ImapFlow(
      imapConnectOptions(resolved.target, {
        timeoutMs: CONNECT_TIMEOUT_MS,
        socketTimeoutMs: CONNECT_TIMEOUT_MS,
      }) as any,
    );
    await client.connect();
    try {
      const path = await this.findSentFolder(client);
      if (!path) throw new Error(`email-sent-poll: channel=${target.channelId} has no Sent folder`);
      const lock = await client.getMailboxLock(path, { readOnly: true } as any);
      try {
        const live = String((client as any).mailbox?.uidValidity ?? '');
        if (live !== uidValidity) {
          throw new Error(
            `email-sent-poll: folder renumbered (UIDVALIDITY ${uidValidity} → ${live}), uid ${uid} no longer names this mail`,
          );
        }
        await this.ingestUid(
          client,
          channel,
          config,
          uid,
          uidValidity,
          this.itemKey(channel, uidValidity, uid),
          {},
        );
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /** The `\Sent` special-use folder, else a name the server actually listed. */
  private async findSentFolder(client: ImapFlow): Promise<string | null> {
    const folders: any[] = (await (client as any).list()) ?? [];
    const special = folders.find((f) => String(f?.specialUse ?? '').toLowerCase() === '\\sent');
    if (special?.path) return String(special.path);
    const named = folders.find((f) => SENT_FOLDER_NAMES.has(String(f?.path ?? '').toLowerCase()));
    return named?.path ? String(named.path) : null;
  }

  private async drain(client: ImapFlow, channel: ChannelRow, config: any): Promise<number> {
    const mailbox: any = (client as any).mailbox;
    const uidValidity = String(mailbox?.uidValidity ?? '');
    const cursor = this.readCursor(channel.configPublic);
    const resume = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : null;

    // A renumbered mailbox invalidates the stored fail counter along with the
    // stored position — both name a uid that no longer means anything.
    const stored = this.readFail(channel.configPublic);
    let fail = stored && stored.uidValidity === uidValidity ? stored : null;

    let uids: number[];
    if (resume !== null) {
      uids = await this.searchUids(client, { uid: `${resume + 1}:*` });
      // `n:*` is never empty in IMAP — a server with nothing newer answers with
      // the highest UID it has, which we have already seen.
      uids = uids.filter((u) => u > resume);
    } else {
      // A first run does not swallow the folder's history: years of old sends
      // would open a conversation per correspondent, each one already finished.
      uids = await this.searchUids(client, { since: new Date(Date.now() - FIRST_RUN_LOOKBACK_MS) });
    }
    if (uids.length === 0) {
      await this.writeCursor(channel, uidValidity, resume ?? this.highestOf(mailbox), fail);
      return 0;
    }

    uids.sort((a, b) => a - b);
    const batch = uids.slice(0, MAX_PER_TICK);

    let ingested = 0;
    // On a FIRST run the baseline is the uid just below the oldest item the
    // lookback selected — never 0. Writing 0 because the very first item threw
    // would turn the next tick's resume into `uid: 1:*`, i.e. the entire
    // folder's history, which is the one thing the lookback exists to prevent.
    let highest = resume ?? batch[0] - 1;
    for (const uid of batch) {
      const key = this.itemKey(channel, uidValidity, uid);
      // Filled in as the examination learns things, so a throw halfway through
      // still leaves a row naming the recipient rather than a bare uid.
      const learned: InboundItemFacts = {};
      try {
        if (await this.ingestUid(client, channel, config, uid, uidValidity, key, learned)) ingested++;
        // Inside the try, and only once the item reached a conclusion. A
        // deliberate skip is a conclusion; a throw is not.
        highest = Math.max(highest, uid);
        if (fail?.uid === uid) fail = null;
      } catch (e: any) {
        const attempts = (fail?.uid === uid ? fail.count : 0) + 1;
        const detail = String(e?.message ?? e).slice(0, 200);
        await this.ledger((l) => l.failed(key, detail, learned));
        if (attempts >= MAX_ITEM_ATTEMPTS) {
          // Parked, loudly. The alternative is head-of-line blocking: one
          // unreadable item and this mailbox records no echoes ever again.
          this.logger.error(
            `email-sent-poll: channel=${channel.id} uid=${uid} parked after ${attempts} attempts: ${detail}`,
          );
          highest = Math.max(highest, uid);
          fail = null;
          continue;
        }
        this.logger.warn(
          `email-sent-poll: channel=${channel.id} uid=${uid} failed (attempt ${attempts}): ${detail}`,
        );
        fail = { uid, uidValidity, count: attempts };
        // Stop the folder where it stands rather than stepping over unread mail.
        break;
      }
    }
    await this.writeCursor(channel, uidValidity, highest, fail);
    return ingested;
  }

  /** True when this uid produced an echo. False means examined and skipped —
   *  which still advances the cursor. A throw means "not examined". */
  private async ingestUid(
    client: ImapFlow,
    channel: ChannelRow,
    config: any,
    uid: number,
    uidValidity: string,
    key: InboundItemKey,
    learned: InboundItemFacts,
  ): Promise<boolean> {
    const head: any = await (client as any).fetchOne(
      String(uid),
      { uid: true, size: true, internalDate: true },
      { uid: true },
    );
    if (!head) {
      return await this.skip(key, 'parse-failed', 'the server no longer has this uid');
    }

    const sizeBytes = typeof head.size === 'number' ? head.size : null;
    // Oversize mail is fetched HEADERS ONLY rather than skipped. A 6 MB mail
    // with a contract attached is precisely the reply an owner wants to see
    // recorded; dropping it because of its attachment is the loss this service
    // exists to stop.
    const oversize = isOversize(sizeBytes);
    const part: any = await (client as any).fetchOne(
      String(uid),
      oversize ? { uid: true, headers: true } : { uid: true, source: true },
      { uid: true },
    );
    const source = oversize ? part?.headers : part?.source;
    if (!source) {
      return await this.skip(key, 'parse-failed', 'the server returned no source');
    }

    const parsed = await simpleParser(source);
    const mail = rawMailFromParsed(parsed as any, {
      source: 'imap-sent',
      itemKey: `${uidValidity}:${uid}`,
      internalDate: head.internalDate instanceof Date ? head.internalDate : null,
      sizeBytes,
      bodyTruncated: oversize,
    });

    const facts: InboundItemFacts = {
      messageId: mail.messageId,
      // The RECIPIENT, not the sender: on this folder the sender is us, and
      // "who was this to" is the question anyone reading the row will have.
      fromAddress: primaryAddress(mail.to) || null,
      subject: mail.subject,
      receivedAt: head.internalDate instanceof Date ? head.internalDate : null,
    };
    Object.assign(learned, facts);
    await this.ledger((l) => l.open(key, facts));

    const own = this.ownAddresses(config, channel);
    const kind = classifyMail(mail, { platformFrom: this.platformFrom(), ownAddresses: [...own] }).kind;
    // OWN_ECHO is the expected verdict here (the From is this mailbox).
    // Everything else — a campaign's List-Unsubscribe, an Auto-Submitted AI
    // reply, a bounce the owner forwarded to themselves — is not somebody
    // typing an answer.
    //
    // HUMAN is accepted only from the mailbox's own DOMAIN, which covers the
    // workspace that sends under an alias the sealed config never mentioned
    // (`satis@` when the box is `destek@`). Without that bound, a folder this
    // service merely GUESSED was Sent — the name fallback below `\Sent` — would
    // file the customer's own mail into the thread as something the team sent,
    // which is worse than never reading the folder at all.
    if (kind !== 'OWN_ECHO' && !(kind === 'HUMAN' && this.sentByThisMailbox(mail, own))) {
      return await this.skip(key, 'policy-not-a-lead', `not a reply this mailbox typed (${kind})`, facts);
    }

    const recipient = this.echoRecipient(mail, own);
    if (!recipient) {
      return await this.skip(key, 'no-sender', 'no single recipient to file this echo under', facts);
    }

    const messageId = mail.messageId;
    if (!messageId) {
      // Without an id there is no dedup, and dedup — not the cursor — is what
      // makes a re-read harmless. An echo we cannot recognise again would be
      // filed a second time the next time this folder is re-read from a reset
      // cursor. Servers give every message an id; this is the safe answer to
      // the one that did not.
      this.logger.warn(`email-sent-poll: uid=${uid} has no Message-ID — skipped, cannot be deduped`);
      return await this.skip(key, 'parse-failed', 'no Message-ID, so it cannot be deduped', facts);
    }
    if (await this.alreadyOurs(channel.workspaceId, messageId)) {
      return await this.skip(key, 'own-echo', 'this send is already on file', facts);
    }

    const text = this.echoText(mail, parsed, oversize);
    if (!text) {
      return await this.skip(key, 'empty-body', 'nothing readable to file', facts);
    }

    const inbound: InboundMessage = {
      externalUserId: recipient.address,
      kind: 'EMAIL',
      externalMessageId: messageId,
      text,
      displayName: recipient.name || null,
      // The whole contract with ConversationIngressService: OUTBOUND, authored
      // by the team, already SENT, bumping `lastMessageAt` and nothing else —
      // no unread count, no `lastInboundAt`, no ConversationMessageReceived,
      // and no `aiPaused`.
      echo: true,
      raw: {
        source: 'imap-sent',
        uid,
        to: recipient.address,
        subject: mail.subject,
        messageId,
      },
    };
    await this.ingress.ingest(
      { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
      inbound,
    );
    await this.ledger((l) => l.done(key, facts));
    return true;
  }

  /** Did this mailbox write it? Its own address, or an alias on its domain. */
  private sentByThisMailbox(mail: RawMail, own: Set<string>): boolean {
    const from = primaryAddress(mail.from);
    if (!from) return false;
    if (own.has(from)) return true;
    const domain = from.split('@')[1] ?? '';
    if (!domain) return false;
    return [...own].some((a) => (a.split('@')[1] ?? '') === domain);
  }

  /**
   * Who this echo is a message TO.
   *
   * Exactly one `To`, or nothing. Two recipients is not a reply to a customer,
   * and it cannot become two echoes either: one Message-ID can only ever key
   * one conversation row, so the second would dedup onto the first and file the
   * mail into the wrong thread. `Cc` is ignored outright — a colleague on copy
   * is not the counterpart of the conversation.
   */
  private echoRecipient(mail: RawMail, own: Set<string>): { address: string; name: string } | null {
    if (mail.to.length !== 1) return null;
    const address = primaryAddress(mail.to);
    if (!address) return null;
    // Mail to ourselves (a note, a test, a forward to the shared box) is not a
    // conversation with anybody.
    if (own.has(address) || address === this.platformFrom()) return null;
    // A reply typed to `no-reply@` is a reply to machinery. It has no business
    // opening a lead, for the same reasons inbound mail from one does not.
    if (isDaemonSender(address)) return null;
    return { address, name: primaryName(mail.to) };
  }

  /**
   * Has this mail already been recorded by the send that produced it?
   *
   * Three homes, asked in the order they are likely to answer. `MailLog` covers
   * every mail the outbound gateway sent, including the ones with no lead and
   * no conversation. `Message` covers a conversation reply written before the
   * ledger existed. `CampaignRecipient` covers campaign mail whose
   * `List-Unsubscribe` was stripped by a relay on the way out.
   *
   * BOTH spellings on every lookup. The ledger stores an id with its brackets
   * removed; nodemailer's `info.messageId` was persisted with them. One
   * normaliser on one side only is the same as no normaliser at all — nothing
   * matches, nothing says so, and every send in the folder becomes a second row.
   */
  private async alreadyOurs(workspaceId: string, messageId: string): Promise<boolean> {
    const spellings = [messageId, `<${messageId}>`];
    const log = await this.prisma.mailLog.findFirst({
      where: { workspaceId, messageId: { in: spellings } },
      select: { id: true },
    });
    if (log) return true;
    const message = await this.prisma.message.findFirst({
      where: { workspaceId, externalMessageId: { in: spellings } },
      select: { id: true },
    });
    if (message) return true;
    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: { workspaceId, messageId: { in: spellings } },
      select: { id: true },
    });
    return Boolean(recipient);
  }

  /** The subject plus what the owner actually typed, quote removed. */
  private echoText(mail: RawMail, parsed: ParsedMail, oversize: boolean): string {
    const body = oversize ? UNREAD_BODY : stripQuotedReply(this.bodyOf(mail, parsed)).trim() || UNREAD_BODY;
    const subject = (mail.subject ?? '').trim();
    return (subject ? `${subject}\n\n${body}` : body).slice(0, MAX_ECHO_CHARS);
  }

  /** Plain text, falling back to a flattened HTML part for HTML-only mail. */
  private bodyOf(mail: RawMail, parsed: ParsedMail): string {
    if (mail.text && mail.text.trim()) return mail.text;
    const raw = typeof parsed.html === 'string' ? parsed.html : mail.html ?? '';
    if (!raw) return '';
    // Cut the quoted block off in HTML first: flattening it to text first would
    // leave the customer's whole previous mail inside the owner's reply.
    return truncateHtmlQuote(raw)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Every address this mailbox sends as — the same three the adapter's own
   *  echo guard checks, so the two agree on what "ours" means. */
  private ownAddresses(config: any, channel: ChannelRow): Set<string> {
    const raw = [config?.secrets?.fromEmail, config?.secrets?.smtpUser, channel.externalId];
    return new Set(raw.map((v) => normalizeAddress(v)).filter(Boolean) as string[]);
  }

  /** The address this deployment sends its own mail from. */
  private platformFrom(): string {
    const raw = process.env.EMAIL_FROM || process.env.EMAIL_USER || '';
    const m = /<([^>]+)>/.exec(raw);
    return (m ? m[1] : raw).trim().toLowerCase();
  }

  /** Opt-in, and only `true` counts: an absent knob is an existing channel. */
  private readSentEnabled(configPublic: unknown): boolean {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    return pub?.readSentFolder === true;
  }

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

  /** Its OWN keys. `imapLastUid` belongs to the INBOX poller and the two
   *  folders have independent UID spaces — sharing a cursor would have each
   *  poller skip whatever the other read. */
  private readCursor(configPublic: unknown): SentCursor | null {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    const lastUid = Number(pub?.imapSentLastUid);
    const uidValidity = pub?.imapSentUidValidity;
    if (!Number.isFinite(lastUid) || lastUid < 0 || typeof uidValidity !== 'string' || !uidValidity) {
      return null;
    }
    return { lastUid, uidValidity };
  }

  private readFail(configPublic: unknown): FailState | null {
    const pub = configPublic && typeof configPublic === 'object' ? (configPublic as any) : null;
    const uid = Number(pub?.imapSentFailUid);
    const count = Number(pub?.imapSentFailCount);
    const uidValidity = pub?.imapSentFailUidValidity;
    if (!Number.isFinite(uid) || uid <= 0 || typeof uidValidity !== 'string' || !uidValidity) return null;
    return { uid, uidValidity, count: Number.isFinite(count) && count > 0 ? count : 0 };
  }

  /** Writes ITS OWN KEYS, in one statement the database merges onto the row
   *  (`configPublic || $patch`, workspace-scoped as every channel write in
   *  this module is). The column is shared with the INBOX poller's cursor, the
   *  mailbox health block and the tenant's settings save, and nothing
   *  serializes those against this tick — so a read-modify-write of the whole
   *  blob would silently roll one of them back. */
  private async writeCursor(
    channel: ChannelRow,
    uidValidity: string,
    lastUid: number,
    fail: FailState | null,
  ): Promise<void> {
    if (!uidValidity) return;
    await mergeConfigPublic(this.prisma, channel, {
      imapSentLastUid: lastUid,
      imapSentUidValidity: uidValidity,
      // Written as explicit nulls/zero rather than deleted, so a cleared
      // counter is visible in the row instead of looking like a key nobody
      // ever wrote.
      imapSentFailUid: fail ? fail.uid : null,
      imapSentFailUidValidity: fail ? fail.uidValidity : null,
      imapSentFailCount: fail ? fail.count : 0,
    });
  }
}
