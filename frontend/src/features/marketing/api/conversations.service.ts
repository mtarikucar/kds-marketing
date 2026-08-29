/**
 * conversations.service.ts — the omnichannel Inbox's conversation reads, as a
 * typed service instead of an inline `marketingApi.get('/conversations')`.
 *
 * The inbox page was the only caller, so the call lived inside the component.
 * The lead detail page is now a second caller with a DIFFERENT filter (one
 * lead's threads rather than the workspace's open queue), and a second inline
 * copy of the same URL is how the two drift apart — including on the
 * query-parameter names, which are the part a typo silently widens: an
 * unrecognised param is ignored by the controller, so `lead_id` would return
 * the whole workspace and look completely normal.
 *
 * Thin typed wrappers over `marketingApi`, matching the convention documented
 * for leads.service.ts / opportunities.service.ts.
 */

import marketingApi from './marketingApi';

export interface ConversationChannelRef {
  id?: string;
  type?: string;
  name?: string;
}

export interface ConversationLastMessage {
  body?: string;
  direction?: string;
  createdAt?: string;
}

/** One row of `GET /marketing/conversations` (the list's enriched shape). */
export interface ConversationSummary {
  id: string;
  status: string;
  aiPaused: boolean;
  unreadCount: number;
  lastMessageAt?: string | null;
  lead?: { id?: string; businessName?: string; contactPerson?: string } | null;
  channel?: ConversationChannelRef | null;
  lastMessage?: ConversationLastMessage | null;
}

export interface ConversationListParams {
  status?: string;
  channelId?: string;
  assignedToId?: string;
  /** Narrow to one lead's threads — the lead detail page's Konuşmalar tab. */
  leadId?: string;
  limit?: number;
}

export const listConversations = (
  params: ConversationListParams = {},
): Promise<ConversationSummary[]> =>
  marketingApi.get('/conversations', { params }).then((r) => r.data);

// ── Starting a thread ────────────────────────────────────────────────────────

export interface StartConversationParams {
  leadId: string;
  /** Which connected channel to reach them on. Only SMS / WhatsApp / email can
   *  OPEN a thread — see OutboundConversationService's INITIABLE map. */
  channelId: string;
  /** Required in practice: the backend refuses a start with neither text nor a
   *  (WhatsApp-only) approved template. */
  text?: string;
}

/** `POST /marketing/conversations/start` — message a lead we chose, opening the
 *  thread if there is not one yet. Finds an existing thread rather than forking
 *  a second one, so a double-send is not a double-conversation. */
export const startConversation = (params: StartConversationParams): Promise<unknown> =>
  marketingApi.post('/conversations/start', params).then((r) => r.data);
