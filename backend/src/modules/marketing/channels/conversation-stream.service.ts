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
const CONTACT_SAFE_KINDS: ReadonlySet<ConversationStreamEvent['kind']> = new Set([
  'message',
  'ai_typing',
]);

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
   * 2. **Fields.** `leadId` is REMOVED, not blanked. It is an internal
   *    identifier for a CRM record the visitor is not a party to, and it exists
   *    on the event solely so the agent surface can tell whose frame it is
   *    reading. Deleting the key (rather than setting it to null or undefined)
   *    is the difference that shows on the wire: `JSON.stringify` drops an
   *    undefined value but serialises `null`, which would still tell a visitor
   *    that their thread carries a lead id.
   *
   * The rebuild is unconditional and shallow — one small object per frame on a
   * stream that already serialises every frame to text.
   */
  forConversation(
    workspaceId: string,
    conversationId: string,
  ): Observable<ConversationStreamEvent> {
    return this.subjectFor(workspaceId)
      .asObservable()
      .pipe(
        filter((e) => e.conversationId === conversationId && CONTACT_SAFE_KINDS.has(e.kind)),
        map(({ leadId: _internalLeadId, ...contactSafe }) => contactSafe),
      );
  }
}
