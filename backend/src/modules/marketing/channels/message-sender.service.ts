import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { MessageQuotaService } from './message-quota.service';
import { ConversationStreamService } from './conversation-stream.service';
import { OutboundMedia, OutboundTemplate } from './channel-adapter.interface';
import { ConversationSpendService } from '../budget/conversation-spend.service';
import { SuppressionReason, SuppressionService } from '../compliance/suppression.service';
import { normalizeMessageId } from './email-message-id';

export interface SendMessageInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  /** AI = engine reply, AGENT = human reply, SYSTEM = workflow/campaign send. */
  authorType: 'AI' | 'AGENT' | 'SYSTEM';
  /** MarketingUser id for AGENT sends; null for AI/SYSTEM. */
  authorId?: string | null;
  /** Optional richer payloads forwarded to the adapter (WhatsApp template /
   *  by-URL media). Text-only callers are unaffected. */
  template?: OutboundTemplate;
  media?: OutboundMedia;
  /**
   * EMAIL only, and only a FALLBACK. The thread the customer opened always
   * wins: a caller's own subject on a reply would start a second thread in
   * their mail client. This is for the first mail of a thread, where the
   * alternative is the adapter's "Re: your message" placeholder.
   */
  subject?: string;
}

/**
 * What an EMAIL reply has to carry to land inside the thread it answers,
 * read in ONE place off the last inbound message.
 *
 * It used to be only the subject, resolved by `emailSubjectFor`. A subject
 * beginning "Re:" with no `In-Reply-To` is precisely what rspamd scores as
 * FAKE_REPLY, and what makes a customer's client file our answer as a new
 * conversation — so the id and the chain are read at the same time, from the
 * same row, and passed together (`no-threading-headers`).
 */
interface EmailReplyContext {
  subject?: string;
  inReplyTo?: string;
  references?: string[];
}

/**
 * An already-prefixed subject, in the spellings this product actually meets.
 *
 * DETECT, never rewrite. Turning "YNT:" into "Re:" mutates the customer's own
 * subject, and for every mail already sitting in their client — sent before we
 * emitted any threading header at all — that subject is the only handle their
 * client has on the thread (`reply-subject-prefix`).
 */
const REPLY_PREFIX_RE = /^\s*(re|aw|sv|vs|vb|ynt|yan[ıi]t|rif|res|odp|antw)\s*(\[\d+\])?\s*:/i;

/** A long `References` chain is a header some receivers reject outright. The
 *  root anchors the thread and the recent ids are what clients match on, so
 *  the middle is what gets dropped. */
const MAX_REFERENCES = 20;

/** Where the inbound Message-ID could be, across the paths that write it: the
 *  column ingress fills, then the provider body stored verbatim under
 *  `meta.raw` (Mailgun / SendGrid / Postmark / the IMAP poller's own shape). */
const RAW_MESSAGE_ID_KEYS = ['message-id', 'messageId', 'MessageID', 'Message-Id', 'Message-ID'] as const;
const RAW_REFERENCES_KEYS = ['references', 'References', 'In-Reply-To-References'] as const;

/**
 * Why a 1:1 mail was not sent, in the agent's language.
 *
 * This lands on `Message.error`, which the inbox renders beside the message —
 * the same field that already carries a provider's verbatim refusal. A machine
 * reason code printed raw would tell the rep nothing (PLAN G8).
 */
const SUPPRESSION_MESSAGE: Record<SuppressionReason, string> = {
  ERASURE: 'This contact asked to be erased, so nothing can be sent to this address.',
  HARD_BOUNCE: 'This email address has hard-bounced, so the message was not sent.',
  INVALID: 'This email address failed verification, so the message was not sent.',
  COMPLAINT: 'This recipient reported an earlier message as spam, so the message was not sent.',
  OPT_OUT: 'This lead opted out of email messages, so the message was not sent.',
  MANUAL: 'This address is on the suppression list, so the message was not sent.',
};

/**
 * Outbound send pipeline: ask the consent gate → reserve message quota →
 * open the Message row PENDING → resolve channel config → adapter.send →
 * settle the row + bump the conversation → emit MessageSent + push it over
 * SSE. Quota is refunded if the adapter reports FAILED, and a failed send is
 * still persisted (status=FAILED) so the agent sees it in the thread. The
 * adapter contract is "never throw on provider errors", but we defend against
 * it anyway.
 *
 * ## The row comes before the provider call
 *
 * `adapter.send` used to run before any durable write. A bookkeeping failure in
 * that gap left a mail that had reached the customer with nothing on file — and
 * the AI retry, finding no message, generated and sent a SECOND, different one
 * (`pending-row`). The row is opened PENDING first, so the worst case is a row
 * that says "we do not know how this ended" instead of a mail nobody can
 * account for.
 *
 * ## Consent comes before the meter
 *
 * The Inbox composer, `jeeta.send_message` and the AI's queued follow-up all
 * arrive here directly, and this was the one outbound path that asked nothing
 * about the recipient (`replies-skip-consent`). It asks now — and asks first,
 * because a refusal must cost the tenant nothing.
 */
@Injectable()
export class MessageSenderService {
  private readonly logger = new Logger(MessageSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly quota: MessageQuotaService,
    private readonly outbox: OutboxService,
    private readonly stream: ConversationStreamService,
    private readonly conversationSpend: ConversationSpendService,
    private readonly suppression: SuppressionService,
  ) {}

  async send(input: SendMessageInput) {
    const { workspaceId, conversationId, text, authorType } = input;
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const channel = await this.prisma.channel.findFirst({
      where: { id: convo.channelId, workspaceId },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    // Disabling a channel silenced its INBOUND immediately — byExternalId only
    // resolves ACTIVE rows — but left outbound working, so a disabled channel
    // kept sending and kept burning message quota (reserve() is below) while
    // nothing could come back. OutboundConversationService already refuses to
    // OPEN a thread on a non-ACTIVE channel; replying on one was the gap.
    // Same null-tolerance as there: fixtures and older rows carry no status.
    if (channel.status && channel.status !== 'ACTIVE') {
      throw new BadRequestException(`Channel is ${channel.status}, not ACTIVE`);
    }

    const identity = convo.contactIdentityId
      ? await this.prisma.contactIdentity.findFirst({
          where: { id: convo.contactIdentityId, workspaceId },
        })
      : null;
    const to = identity?.value ?? null;
    const isEmail = channel.type === 'EMAIL';

    // The consent gate, BEFORE anything that spends. `SuppressionService` owns
    // the union read (the suppression table OR the denormalised Lead flags) and
    // `GATE_MATRIX` owns the class semantics — CONVERSATIONAL suppresses an
    // opt-out only on a PROACTIVE send, so answering a customer who just wrote
    // in still works (`replies-skip-consent`).
    const refusal = isEmail && to ? await this.consentRefusal(workspaceId, conversationId, to) : null;

    // Reserve BEFORE the send (skips web-chat). Throws MESSAGES_EXHAUSTED at cap.
    const reserved = !refusal;
    if (reserved) await this.quota.reserve(workspaceId, channel.type);

    // The record of the send, opened before the provider is called. `body` and
    // `meta` are known now — they describe what we are about to send, not how
    // it went — so only the outcome is left for the settle below.
    let opened: { id: string };
    try {
      opened = await this.prisma.message.create({
        data: {
          workspaceId,
          conversationId,
          direction: 'OUTBOUND',
          authorType,
          authorId: input.authorId ?? null,
          // What actually went out. The WhatsApp adapter's precedence is
          // template > media > text, and the template is rendered by Meta
          // from a name + language, not by us — so persisting `text` for a
          // template send stored something the customer never received:
          // empty for a template-only send, and the ignored text when both
          // were passed. A rep opening the thread saw a blank outbound
          // message, or worse, copy that was never sent.
          body: input.template ? templateBody(input.template, text) : text,
          // The template identity itself, so the summary above stays
          // human-facing and the raw truth is still queryable.
          meta: input.template
            ? ({
                template: {
                  name: input.template.name,
                  languageCode: input.template.languageCode,
                },
              } as Prisma.InputJsonValue)
            : undefined,
          externalMessageId: null,
          status: 'PENDING',
        },
        select: { id: true },
      });
    } catch (e) {
      // Nothing left the building, so the reserve comes straight back.
      if (reserved) await this.quota.refund(workspaceId, channel.type);
      throw e;
    }

    let result: {
      externalMessageId: string | null;
      status: 'SENT' | 'FAILED';
      error?: string;
      /** The adapter's verdict on whether trying again could work. */
      retriable?: boolean;
    };
    if (refusal) {
      // A refusal is visible: it settles as a FAILED message carrying the
      // reason, in the thread, where the rep is looking. It is never thrown —
      // `workflow-executor.service.ts` turns a thrown step into a whole-run
      // FAILED, and the AI engine would simply try again (PLAN G2).
      result = { externalMessageId: null, status: 'FAILED', error: refusal };
    } else {
      try {
        const adapter = this.registry.get(channel.type);
        const config = this.registry.resolveConfig(channel);
        const reply = isEmail ? await this.emailReplyContextFor(workspaceId, conversationId) : null;
        const subject = isEmail ? (reply?.subject ?? input.subject) : undefined;
        result = to
          ? await adapter.send({
              config,
              to,
              text,
              subject,
              template: input.template,
              media: input.media,
              ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
              ...(reply?.references?.length ? { references: reply.references } : {}),
              /**
               * RFC 3834. An unattended reply says so, so the peer's own
               * auto-responder does not answer it back and the two of them
               * loop forever.
               *
               * Gated on `authorType`, never on the channel alone: a HUMAN's
               * reply marked `auto-replied` is filtered by the recipient's own
               * RFC 3834 rules, so the customer never sees what a person wrote
               * to them.
               */
              ...(authorType === 'AI' && isEmail
                ? { autoSubmitted: 'auto-replied' as const }
                : {}),
            })
          : { externalMessageId: null, status: 'FAILED', error: 'no recipient identity on conversation' };
      } catch (e: any) {
        result = { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
      }
    }

    let refunded = false;
    if (result.status === 'FAILED' && reserved) {
      await this.quota.refund(workspaceId, channel.type);
      refunded = true;
      const scrubbed = String(result.error ?? '').replace(/password=[^&\s]+/gi, 'password=***');
      this.logger.warn(`send failed convo=${conversationId} ch=${channel.type}: ${scrubbed}`);
    }

    // Settle the message, bump the conversation, and enqueue the domain event
    // in ONE transaction: the outbox is durable only when appended in the same
    // tx as the state change, and a crash mid-way must not leave a sent message
    // unrecorded with its event lost.
    let message;
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const m = await tx.message.update({
          where: { id: opened.id },
          data: {
            status: result.status,
            externalMessageId: result.externalMessageId,
            error: result.error ?? null,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          /**
           * A FAILED send did not reach anybody, so it is not a message in
           * this thread and must not move the clock.
           *
           * Stamping it anyway is what silently disarmed the hourly
           * ai-reply-backfill sweep, which is the de-facto retry for a
           * channel refusal: the sweep looks for threads whose last message
           * is inbound, and a failed outbound row made every one of them look
           * answered. NOT a skip — `conversations.service` sorts by
           * `lastMessageAt desc` and Postgres puts NULLs first, so leaving it
           * null would float failed threads to the top of every inbox.
           */
          data: {
            lastMessageAt: result.status === 'SENT' ? new Date() : (convo.lastMessageAt ?? new Date()),
          },
        });
        await this.outbox.append(
          {
            type: MarketingEventTypes.ConversationMessageSent,
            idempotencyKey: `conv-msg-sent:${m.id}`,
            payload: {
              workspaceId,
              conversationId,
              channelId: channel.id,
              messageId: m.id,
              authorType,
              occurredAt: new Date().toISOString(),
            },
          },
          tx as any,
        );
        return m;
      });
    } catch (e) {
      // The mail itself is no longer at stake here: the PENDING row above is
      // the record of it, and it survives this rollback. So quota comes back
      // only when nothing reached the customer — refunding a message they are
      // holding would hand the plan's allowance back for real, sent mail.
      if (reserved && !refunded && result.status !== 'SENT') {
        await this.quota.refund(workspaceId, channel.type);
      }
      throw e;
    }

    // Best-effort live fan-out, only after the tx has committed. `leadId` says
    // WHOSE frame this is, so the agent surface refreshes the person it names
    // rather than whoever happens to be open. The conversation is already in
    // hand here, so saying it costs nothing.
    //
    // `payload` is the whole `Message` row on PURPOSE, and only because the
    // subscriber decides what it may keep: this is the workspace stream, read
    // by agents, and `ConversationStreamService.forConversation` rebuilds a
    // visitor's frame from five named fields before it reaches the public
    // web-chat EventSource. It did not always: until that projection existed
    // this line put `authorId`, `error`, `meta`, `status` and the per-message
    // `costAmount` in front of the customer. Widening a push site is safe now;
    // widening what a VISITOR sees means editing `ContactSafeEvent`, which is
    // the point of it being one named place.
    this.stream.push(workspaceId, {
      kind: 'message',
      conversationId,
      leadId: convo.leadId,
      payload: message,
    });

    // Price + debit the per-segment SMS cost against the growth budget. Best-
    // effort and fire-and-forget: ConversationSpendService.settleSms never
    // throws (its internal errors are caught and logged), but the `.catch`
    // here is a defensive backstop — a billing hiccup must NEVER fail (or even
    // delay) a send that already reached the customer.
    if (channel.type === 'SMS' && result.status === 'SENT') {
      this.conversationSpend
        .settleSms(workspaceId, { messageId: message.id, text })
        .catch((err) =>
          this.logger.warn(`SMS settlement failed for message ${message.id}: ${String((err as Error)?.message ?? err)}`),
        );
    }

    /**
     * The adapter's own verdict on whether trying again could work, carried
     * out to the caller.
     *
     * `SendResult.retriable` is set by every adapter and was then dropped on
     * the floor here, so a 4xx greylisting and a permanently rejected address
     * read identically to `ConversationAiEngineService` — which therefore
     * treated every refusal as final and never rescheduled. It rides on the
     * returned row rather than in the database because it is a property of
     * THIS attempt, not of the message.
     */
    return Object.assign(message, {
      ...(result.retriable === undefined ? {} : { retriable: result.retriable }),
    });
  }

  /**
   * "May we send this at all", asked of the one service that knows.
   *
   * Fails OPEN. There is no check on this path today, so a suppression read
   * that cannot complete leaves today's behaviour rather than silencing an
   * entire workspace's inbox on a connection-pool hiccup. A customer's actual
   * refusal is a row; a failed query is not.
   */
  private async consentRefusal(
    workspaceId: string,
    conversationId: string,
    to: string,
  ): Promise<string | null> {
    try {
      const verdict = await this.suppression.check(workspaceId, to, 'CONVERSATIONAL', { conversationId });
      if (!verdict.suppressed || !verdict.reason) return null;
      return SUPPRESSION_MESSAGE[verdict.reason] ?? 'This address cannot be messaged.';
    } catch (e: any) {
      this.logger.warn(`consent check failed convo=${conversationId}: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Everything an EMAIL reply needs to continue the thread it answers.
   *
   * Nothing used to pass a subject, so every reply — the AI's included — went
   * out on `EmailChannelAdapter`'s last-resort fallback, "Re: your message". In
   * a mail client that is a new thread with an English placeholder for a
   * subject, sent to a Turkish customer who wrote in about something specific.
   * And nothing ever passed `In-Reply-To`, so even a correct subject only
   * LOOKED like a reply: the thread the conversation view showed was not the
   * thread the recipient saw.
   *
   * All three answers come off the most recent INBOUND message: the ingress
   * path stores the parsed mail under `meta.raw` and the provider's Message-ID
   * in `externalMessageId` — the same shape for an inbound-parse webhook and
   * for the IMAP poller, so this works whichever one delivered it. Empty when
   * there is nothing to reply to (an outbound thread the customer has not
   * answered yet), which leaves the adapter's own fallback in place rather than
   * inventing a subject here.
   */
  private async emailReplyContextFor(
    workspaceId: string,
    conversationId: string,
  ): Promise<EmailReplyContext> {
    const last = await this.prisma.message.findFirst({
      where: { workspaceId, conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { meta: true, externalMessageId: true },
    });
    if (!last) return {};

    const raw = (last.meta as any)?.raw;
    const ctx: EmailReplyContext = {};

    const subject = replySubject(raw);
    if (subject) ctx.subject = subject;

    // One spelling on both sides of every lookup: inbound ids are persisted
    // with the brackets stripped, outbound ones with them, and the domain's
    // case is whatever the issuing server felt like.
    const parent = normalizeMessageId(last.externalMessageId ?? rawMessageId(raw));
    if (parent) {
      ctx.inReplyTo = parent;
      // RFC 5322 §3.6.4: the parent's References, then the parent itself.
      ctx.references = capReferences([...rawReferences(raw), parent]);
    }
    return ctx;
  }
}

/** The subject to reply WITH, or nothing when there is none to reply to. */
function replySubject(raw: any): string | undefined {
  // `meta.raw` is the provider body verbatim, so the key spelling is the
  // provider's: Postmark capitalises it, and reading only the lowercase one
  // sent every Postmark-delivered thread out on the adapter's placeholder.
  const rawSubject = raw?.subject ?? raw?.Subject;
  const subject = typeof rawSubject === 'string' ? rawSubject.trim() : '';
  if (!subject) return undefined;
  // Mail clients thread on the subject, so an already-prefixed one must not
  // grow a second "Re:" with every round.
  return (REPLY_PREFIX_RE.test(subject) ? subject : `Re: ${subject}`).slice(0, 200);
}

function rawMessageId(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const key of RAW_MESSAGE_ID_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** The chain the parent itself carried, in order, normalized and deduped. */
function rawReferences(raw: any): string[] {
  if (!raw || typeof raw !== 'object') return [];
  let value: unknown;
  for (const key of RAW_REFERENCES_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v) {
      value = v;
      break;
    }
  }
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  for (const part of parts) {
    const id = normalizeMessageId(part);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function capReferences(ids: string[]): string[] {
  const unique: string[] = [];
  for (const id of ids) if (!unique.includes(id)) unique.push(id);
  if (unique.length <= MAX_REFERENCES) return unique;
  return [unique[0], ...unique.slice(-(MAX_REFERENCES - 1))];
}

/**
 * A readable stand-in for a template send.
 *
 * Meta renders an approved template from a name + language + parameters; the
 * rendered text never exists on our side, so there is nothing truthful to store
 * as the body. This records WHAT was sent rather than pretending to quote it,
 * and keeps any caller-supplied text as context — that text is not what the
 * customer received (the adapter's precedence is template > media > text), so
 * it is labelled rather than presented as the message.
 */
function templateBody(template: OutboundTemplate, text: string): string {
  const head = `[template: ${template.name} (${template.languageCode})]`;
  const note = text.trim();
  return note ? `${head} ${note}` : head;

}
