import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';

/** A live inbox/widget event. `kind` lets the client route it. `note` is an
 *  INTERNAL (team-only) kind — it reaches the agent Inbox (forWorkspace) but is
 *  hard-excluded from the public widget stream (forConversation). */
export interface ConversationStreamEvent {
  kind: 'message' | 'conversation' | 'ai_typing' | 'note' | 'status';
  conversationId: string;
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

  /** Single-conversation stream — the PUBLIC web-chat widget. Restricted to
   *  contact-safe kinds so internal events (notes, metadata) never reach the
   *  visitor's EventSource even if pushed onto the shared workspace Subject. */
  forConversation(
    workspaceId: string,
    conversationId: string,
  ): Observable<ConversationStreamEvent> {
    return this.subjectFor(workspaceId)
      .asObservable()
      .pipe(filter((e) => e.conversationId === conversationId && CONTACT_SAFE_KINDS.has(e.kind)));
  }
}
