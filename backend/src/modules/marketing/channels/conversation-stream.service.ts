import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

/** A live inbox/widget event. `kind` lets the client route it. `note` is an
 *  INTERNAL (team-only) kind — it reaches the agent Inbox (forWorkspace) but is
 *  hard-excluded from the public widget stream (forConversation). */
export interface ConversationStreamEvent {
  kind: 'message' | 'conversation' | 'ai_typing' | 'note' | 'status';
  conversationId: string;
  /**
   * WHOSE event this is — the `leadId` of the conversation it happened on.
   *
   * The agent surface subscribes to the WHOLE workspace stream and keeps one
   * person open beside it. Without this field a client cannot tell a frame
   * about the person on screen from a frame about anybody else, so it had to
   * refetch the open person's record on EVERY frame in the workspace — a
   * payload carrying their activities, offers and tasks, re-read because
   * somebody else got an SMS. With it, a frame refreshes the person it names.
   *
   * OPTIONAL, and the client keeps its broad refresh as the fallback when it is
   * absent. A publisher that cannot cheaply resolve the lead must degrade to
   * "refresh everything", never to "refresh nothing" — a missed inbound message
   * is a rep replying to a customer whose last line they cannot see.
   *
   * It never reaches the visitor: `forConversation` strips it. See there.
   */
  leadId?: string;
  payload: unknown;
}

/** Event kinds safe to emit to the CONTACT (public web-chat widget). Anything
 *  not in this set (e.g. internal 'note', 'conversation' metadata) is never sent
 *  to the visitor — forConversation enforces this allowlist server-side. */
const CONTACT_SAFE_KINDS = ['message', 'ai_typing'] as const;
type ContactSafeKind = (typeof CONTACT_SAFE_KINDS)[number];
const CONTACT_SAFE_KIND_SET: ReadonlySet<ConversationStreamEvent['kind']> = new Set(
  CONTACT_SAFE_KINDS,
);

/**
 * A message as the VISITOR may see it — the same five columns
 * `GET /webchat/:widgetKey/history` selects, and deliberately the same five.
 *
 * The two endpoints feed one widget: history paints the thread on load, the
 * stream appends to it live. They were not the same shape. `/history` has
 * always had an explicit `select`; the stream carried `payload: message`, the
 * whole `Message` row straight off `tx.message.create` — which handed a
 * visitor's EventSource `workspaceId`, `authorId` (an internal MarketingUser
 * id), `externalMessageId`, `status`, `error`, `meta`, `smsSegments` and
 * `costAmount`, the per-message cost of talking to them. The SSE path leaked
 * strictly more than the REST path beside it.
 */
export interface ContactSafeMessage {
  id: unknown;
  direction: unknown;
  authorType: unknown;
  body: unknown;
  createdAt: unknown;
}

/** The AI's typing indicator, the only other thing a visitor is sent. */
export interface ContactSafeTyping {
  typing: unknown;
}

/**
 * The public web-chat widget's wire format, in full.
 *
 * A type of its own rather than `Omit<ConversationStreamEvent, 'leadId'>`,
 * because Omit tracks the internal event: the next internal field added to
 * `ConversationStreamEvent` would join this type automatically and the
 * compiler would have nothing to say about it. Spelled out, the visitor's
 * frame is a fixed three keys that an author has to widen ON PURPOSE.
 */
export interface ContactSafeEvent {
  kind: ContactSafeKind;
  conversationId: string;
  payload: ContactSafeMessage | ContactSafeTyping | null;
}

/** Read a key off an unknown payload without asserting a shape onto it. */
function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

/**
 * Rebuild the payload from named fields rather than filtering the row.
 *
 * Construction, not subtraction: a column added to `Message` — or a push site
 * that hands over a whole Prisma row, which is exactly how `costAmount` got
 * onto the wire — cannot reach a visitor through a projection that only ever
 * copies five names it was told. A denylist would have to be updated by
 * whoever adds the column, and the whole point is that they will not.
 */
function contactSafePayload(kind: ContactSafeKind, payload: unknown): ContactSafeEvent['payload'] {
  if (kind === 'ai_typing') return { typing: field(payload, 'typing') };
  return {
    id: field(payload, 'id'),
    direction: field(payload, 'direction'),
    authorType: field(payload, 'authorType'),
    body: field(payload, 'body'),
    createdAt: field(payload, 'createdAt'),
  };
}

/**
 * Per-workspace in-process SSE fan-out. One RxJS Subject per workspace; the
 * Inbox subscribes to the whole workspace stream and the public widget filters
 * to a single conversation. Single-replica assumption (documented non-goal:
 * multi-replica needs a pg NOTIFY / Redis bridge) — matches the in-process
 * DomainEventBus. The Subject is hot + unbuffered: a client that isn't
 * connected simply misses live events and re-fetches the thread on (re)connect.
 */
@Injectable()
export class ConversationStreamService {
  private readonly streams = new Map<string, Subject<ConversationStreamEvent>>();

  private subjectFor(workspaceId: string): Subject<ConversationStreamEvent> {
    let s = this.streams.get(workspaceId);
    if (!s) {
      s = new Subject<ConversationStreamEvent>();
      this.streams.set(workspaceId, s);
    }
    return s;
  }

  push(workspaceId: string, event: ConversationStreamEvent): void {
    this.subjectFor(workspaceId).next(event);
  }

  /** Whole-workspace stream — the agent Inbox (every conversation). */
  forWorkspace(workspaceId: string): Observable<ConversationStreamEvent> {
    return this.subjectFor(workspaceId).asObservable();
  }

  /**
   * Single-conversation stream — the PUBLIC web-chat widget.
   *
   * Two server-side restrictions, both because the subscriber here is the
   * CONTACT rather than an agent, and both enforced on the way OUT rather than
   * trusted at the push sites:
   *
   * 1. **Kinds.** Only `CONTACT_SAFE_KINDS`, so internal events (notes,
   *    conversation metadata) never reach the visitor's EventSource even if
   *    pushed onto the shared workspace Subject.
   * 2. **Fields.** The frame is REBUILT from named fields — `ContactSafeEvent`
   *    and `contactSafePayload` — rather than having its unsafe parts removed.
   *
   *    `leadId` is therefore absent rather than blank, which is the difference
   *    that shows on the wire: `JSON.stringify` drops an undefined value but
   *    serialises `null`, and a `"leadId":null` would still tell a visitor
   *    their thread carries a CRM record they are not a party to.
   *
   *    Rebuilding rather than subtracting is what makes that hold for fields
   *    NOBODY HAS WRITTEN YET. The old code stripped one known key and passed
   *    `payload` through untouched, so `message-sender` handing over a whole
   *    `Message` row put `authorId`, `error`, `meta`, `status` and the
   *    per-message `costAmount` on a public EventSource — while the `/history`
   *    endpoint beside it selected five columns. Same widget, two answers, and
   *    the SSE one leaked strictly more.
   *
   * The rebuild is unconditional and shallow — two small objects per frame on
   * a stream that already serialises every frame to text.
   */
  forConversation(workspaceId: string, conversationId: string): Observable<ContactSafeEvent> {
    return this.subjectFor(workspaceId)
      .asObservable()
      .pipe(
        filter((e) => e.conversationId === conversationId && CONTACT_SAFE_KIND_SET.has(e.kind)),
        map(
          (e): ContactSafeEvent => ({
            kind: e.kind as ContactSafeKind,
            conversationId: e.conversationId,
            payload: contactSafePayload(e.kind as ContactSafeKind, e.payload),
          }),
        ),
      );
  }
}
