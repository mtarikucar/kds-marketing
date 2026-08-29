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

/**
 * Every value `Message.status` can hold, mirroring the Prisma column's own
 * comment (schema.prisma:1865 — `RECEIVED | SENT | DELIVERED | READ | FAILED`).
 *
 * A start only ever returns SENT or FAILED — those are the two
 * MessageSenderService writes — but the column is later moved to DELIVERED /
 * READ by the provider webhooks, so narrowing this to the two would be a type
 * that is true of one moment rather than of the field.
 */
export type MessageStatus = 'RECEIVED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** The Message row `POST /conversations/start` echoes back — the Prisma model,
 *  minus the columns no caller here reads. */
export interface StartedMessage {
  id: string;
  conversationId: string;
  direction: string;
  body: string;
  /** THE outcome of the send. See StartedConversation's note — a 2xx does not
   *  mean this is 'SENT'. */
  status: MessageStatus;
  /** The provider's own refusal, verbatim, when `status` is 'FAILED'. */
  error?: string | null;
  externalMessageId?: string | null;
  createdAt?: string;
}

/**
 * What a start really answers with.
 *
 * The `message` is not a courtesy echo — it is the only place the send's
 * outcome exists. MessageSenderService.send does NOT throw when an adapter
 * rejects a send: it records the Message as FAILED with the provider's reason,
 * refunds the quota, logs a warning and returns
 * (message-sender.service.ts:78-93, :177). OutboundConversationService.start
 * returns that Message unchanged, so the HTTP status describes the REQUEST and
 * `message.status` describes the SEND, and the two disagree routinely — on SMS
 * and email as much as on WhatsApp.
 *
 * This was `Promise<unknown>`, which is exactly the shape in which that
 * distinction is invisible: a caller with `unknown` has no `message` to look
 * at, so 2xx is the only signal it can act on, and it reports "sent" for a
 * message that never left the building.
 */
export interface StartedConversation {
  conversationId: string;
  leadId: string;
  /** The channel TYPE ('SMS' | 'WHATSAPP' | 'EMAIL'), not its id. */
  channel: string;
  /** The canonical address the message was addressed to (E.164 / normalised
   *  email), which is not necessarily the spelling stored on the lead. */
  to: string;
  /** True when an OPEN thread already existed and was reused rather than a
   *  second one opened beside it. */
  reusedThread: boolean;
  message: StartedMessage;
}

/** `POST /marketing/conversations/start` — message a lead we chose, opening the
 *  thread if there is not one yet. Finds an existing thread rather than forking
 *  a second one, so a double-send is not a double-conversation.
 *
 *  A resolved promise means the REQUEST succeeded. Read `message.status` for
 *  whether anything was actually sent. */
export const startConversation = (
  params: StartConversationParams,
): Promise<StartedConversation> =>
  marketingApi.post('/conversations/start', params).then((r) => r.data);
