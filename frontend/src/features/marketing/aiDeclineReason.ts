/**
 * Why the AI stayed quiet on a thread, in the reader's own language.
 *
 * `Conversation.aiLastDeclineReason` is a free-text column the engine writes,
 * and the inbox used to render it verbatim — so a Turkish rep read
 * "conversation is CLOSED, not OPEN" underneath a Turkish label. The engine now
 * prefixes a machine code onto its own sentence (`CODE: prose`, see
 * backend/src/modules/marketing/channels/ai-decline-reason.ts).
 *
 * Two fallbacks, both deliberate: a row written before codes existed has no
 * prefix and renders as it always did, and a code this bundle has never heard
 * of (the SPA and the API deploy separately) renders the whole stored string.
 * Prose is degraded; blank would be broken.
 */

/** Codes this build ships a sentence for. Mirrors the backend list. */
export const AI_DECLINE_CODES = [
  'REPLY_DISABLED',
  'AI_PAUSED',
  'CONVERSATION_MISSING',
  'CONVERSATION_NOT_OPEN',
  'LEAD_GONE',
  'CHANNEL_MISSING',
  'CHANNEL_INACTIVE',
  'AGENT_MISSING',
  'AGENT_INACTIVE',
  'MESSAGE_QUOTA',
  'DAILY_CAP',
  'SEND_REFUSED_RETRY',
  'SEND_REFUSED',
] as const;

export type AiDeclineCode = (typeof AI_DECLINE_CODES)[number];

/** The English sentence for each code, used as the i18n `defaultValue` so the
 *  catalogue and the in-code default can never disagree. */
export const AI_DECLINE_FALLBACK: Record<AiDeclineCode, string> = {
  REPLY_DISABLED: 'AI replies are switched off for this workspace.',
  AI_PAUSED: 'A colleague took this conversation over.',
  CONVERSATION_MISSING: 'This conversation could not be found.',
  CONVERSATION_NOT_OPEN: 'This conversation is closed.',
  LEAD_GONE: 'This person was deleted or merged.',
  CHANNEL_MISSING: 'The channel for this conversation is gone.',
  CHANNEL_INACTIVE: 'The channel for this conversation is not active.',
  AGENT_MISSING: 'The AI assistant attached to this channel no longer exists.',
  AGENT_INACTIVE: 'The AI assistant attached to this channel is not active.',
  MESSAGE_QUOTA: 'The monthly message allowance is used up.',
  DAILY_CAP: 'The daily reply limit for this conversation has been reached.',
  SEND_REFUSED_RETRY: 'The channel refused the reply — it will be tried again shortly.',
  SEND_REFUSED: 'The channel refused the reply.',
};

/**
 * Turn a stored reason into something to render.
 *
 * Only an ALL-CAPS token this build knows, at the very head, counts as a code:
 * prose that happens to contain a colon ("Note: …") has to stay prose.
 */
export function readDeclineReason(
  raw: string | null | undefined,
  t: (key: string, defaultValue: string) => string,
): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  const m = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(value);
  const code = m?.[1];
  if (code && (AI_DECLINE_CODES as readonly string[]).includes(code)) {
    return t(`inbox.aiDeclineReason.${code}`, AI_DECLINE_FALLBACK[code as AiDeclineCode]);
  }
  return value;
}
