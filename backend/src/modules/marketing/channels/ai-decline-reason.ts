/**
 * Why the AI stayed quiet on a thread, in a form the inbox can translate.
 *
 * `Conversation.aiLastDeclineReason` is a free-text column the engine writes and
 * the inbox renders verbatim, so a Turkish rep was reading "conversation is
 * CLOSED, not OPEN" underneath a Turkish label (PLAN G8: a server reason code is
 * never printed raw).
 *
 * It cannot become an enum — schema changes are out of scope here, and the
 * column already holds prose for every thread the engine has ever declined. So
 * the code is PREFIXED onto the prose it explains, `CODE: sentence`. A reader
 * that knows the code shows its own sentence; a reader that does not — and every
 * row written before this existed — shows the prose, which is exactly today's
 * behaviour. The prose also stays in the column for whoever is reading the
 * database during an incident, which a bare code would have taken away.
 */

/** Every code the inbox ships a sentence for. Adding one here without its
 *  `inbox.aiDeclineReason.<CODE>` copy degrades to the prose, never to blank. */
export const AI_DECLINE_CODES = [
  /** Conversation AI is switched off for this workspace. */
  'REPLY_DISABLED',
  /** A human took this thread over. */
  'AI_PAUSED',
  /** The thread vanished from under the job. */
  'CONVERSATION_MISSING',
  /** The thread is CLOSED/SNOOZED, so there is nothing to answer into. */
  'CONVERSATION_NOT_OPEN',
  /** The lead was deleted or merged away. */
  'LEAD_GONE',
  'CHANNEL_MISSING',
  'CHANNEL_INACTIVE',
  'AGENT_MISSING',
  'AGENT_INACTIVE',
  /** The workspace's monthly message allowance is spent. */
  'MESSAGE_QUOTA',
  /** The agent profile's per-conversation daily reply cap. */
  'DAILY_CAP',
  /** The channel refused the reply and a retry is queued. */
  'SEND_REFUSED_RETRY',
  /** The channel refused the reply and nothing further is scheduled. */
  'SEND_REFUSED',
] as const;

export type AiDeclineCode = (typeof AI_DECLINE_CODES)[number];

/** `CODE: prose` — the single shape both sides agree on. */
export function codedDeclineReason(code: AiDeclineCode, text: string): string {
  return `${code}: ${text}`;
}

/**
 * Read a stored reason back. Only an ALL-CAPS token this build knows, at the
 * very head, is a code: prose that happens to contain a colon ("Note: …",
 * "daily reply cap reached (5/day): lost the race") must stay prose, or the UI
 * starts translating sentences into the wrong thing.
 */
export function splitDeclineReason(raw: string | null | undefined): {
  code: AiDeclineCode | null;
  text: string;
} {
  const value = (raw ?? '').trim();
  if (!value) return { code: null, text: '' };
  const m = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(value);
  if (m && (AI_DECLINE_CODES as readonly string[]).includes(m[1])) {
    return { code: m[1] as AiDeclineCode, text: (m[2] ?? '').trim() };
  }
  return { code: null, text: value };
}
