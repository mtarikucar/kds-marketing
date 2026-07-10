/**
 * SMS segment counting — frontend port of
 * `backend/src/modules/marketing/wallet/sms-segments.util.ts`. Powers the
 * live "X characters · Y segments" caption under every SMS composer
 * (campaign body, inbox reply, workflow send_sms step).
 *
 * Carriers bill per 160-char GSM-7 segment (153 when a message spans multiple
 * segments, because of the concatenation header). A message containing any
 * non-GSM-7 character is encoded as UCS-2 and billed per 70-char segment (67
 * multipart). A handful of GSM-7 "extended" characters occupy two septets.
 * Pure + dependency-free so it is trivially testable and reusable.
 *
 * This file must stay in lockstep with the backend util — same alphabet,
 * same thresholds — so the number a user sees while typing matches what
 * `ConversationSpendService.settleSms` / `settleCampaignSms` actually bills.
 * Any change to one must be mirrored in the other.
 *
 * `reservedSuffixChars` (frontend-only addition on top of the backend math)
 * models characters that will land in the SENT message but never appear in
 * the textarea the user is looking at, so the live counter doesn't
 * understate the real, billed segment count:
 *   - `NETGSM_HEADER_OVERHEAD_CHARS` — NetGSM headed (başlıklı, i.e. sent
 *     with a msgheader/sender-ID) SMS effectively lose ~5 usable chars per
 *     segment (160 -> 155 GSM-7 single-segment cap). Every SMS this app
 *     sends is headed, so every composer reserves at least this much.
 *   - `CAMPAIGN_UNSUBSCRIBE_FOOTER_CHARS` — campaign sends get a mandatory
 *     "\nStop: <link>" footer appended AFTER the authored body (see
 *     `campaign-sender.service.ts` `render()`); the campaign composer never
 *     shows that footer inline, so it must be reserved too.
 * This estimate only affects what the LIVE counter displays. The
 * authoritative segment count used for billing is always computed
 * server-side against the real, fully-rendered text, so a rough estimate
 * here can never mis-charge anyone — worst case the live counter is off by
 * a segment until the message is actually sent.
 */

// Basic GSM 03.38 7-bit default alphabet.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extended set — each of these is encoded as ESC + char, i.e. 2 septets.
const GSM7_EXTENDED = '^{}\\[~]|€';

const basic = new Set(GSM7_BASIC);
const extended = new Set(GSM7_EXTENDED);

/** True when every character is representable in GSM-7 (basic or extended). */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!basic.has(ch) && !extended.has(ch)) return false;
  }
  return true;
}

/** Number of 7-bit septets the text occupies (extended chars cost 2). */
function septetLength(text: string): number {
  let n = 0;
  for (const ch of text) n += extended.has(ch) ? 2 : 1;
  return n;
}

export interface SmsSegmentsOptions {
  /** Extra per-segment capacity to reserve for suffix content the composer
   *  doesn't render inline (header overhead, unsubscribe footer, …).
   *  Defaults to 0 — the raw backend math, unmodified. */
  reservedSuffixChars?: number;
}

/**
 * The number of billable SMS segments for `text`. Empty text is 1 segment
 * (an empty SMS still bills as one), matching carrier behaviour.
 */
export function smsSegments(text: string, opts: SmsSegmentsOptions = {}): number {
  const reserved = Math.max(0, opts.reservedSuffixChars ?? 0);
  const s = text ?? '';
  if (isGsm7(s)) {
    const len = septetLength(s);
    const singleCap = Math.max(1, 160 - reserved);
    const multiCap = Math.max(1, 153 - reserved);
    if (len <= singleCap) return 1;
    return Math.ceil(len / multiCap);
  }
  // UCS-2: count UTF-16 code units (surrogate pairs => 2), 70/67 per segment.
  const units = s.length; // JS string length is UTF-16 code-unit count
  const singleCap = Math.max(1, 70 - reserved);
  const multiCap = Math.max(1, 67 - reserved);
  if (units <= singleCap) return 1;
  return Math.ceil(units / multiCap);
}

/** NetGSM headed (başlıklı) sender-ID overhead — every SMS this app sends
 *  carries a msgheader, which costs ~5 usable chars per segment. */
export const NETGSM_HEADER_OVERHEAD_CHARS = 5;

/**
 * Conservative estimate of the mandatory campaign unsubscribe footer
 * (`\nStop: <PUBLIC_BASE_URL>/api/public/u/<token>`) that
 * `CampaignSenderService.render()` appends AFTER the authored body: a
 * `cr_` + 36-hex-char token (39 chars) + the `/api/public/u/` path (14
 * chars) + `\nStop: ` (7 chars) = 60 chars, BEFORE the workspace's
 * `PUBLIC_BASE_URL` domain itself (a handful more) — rounded up to 64.
 * Only relevant to the campaign SMS composer; direct sends (inbox reply,
 * workflow send_sms) never get this footer.
 */
export const CAMPAIGN_UNSUBSCRIBE_FOOTER_CHARS = 64;

/** Total reserved suffix chars for the campaign SMS composer's live counter
 *  (header overhead + the unsubscribe footer). */
export const CAMPAIGN_SMS_RESERVED_SUFFIX_CHARS =
  NETGSM_HEADER_OVERHEAD_CHARS + CAMPAIGN_UNSUBSCRIBE_FOOTER_CHARS;
