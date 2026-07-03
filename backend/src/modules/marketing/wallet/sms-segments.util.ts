/**
 * SMS segment counting (Budget Autopilot conversation pricing).
 *
 * Carriers bill per 160-char GSM-7 segment (153 when a message spans multiple
 * segments, because of the concatenation header). A message containing any
 * non-GSM-7 character is encoded as UCS-2 and billed per 70-char segment (67
 * multipart). A handful of GSM-7 "extended" characters occupy two septets.
 * Pure + dependency-free so it is trivially testable and reusable.
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

/**
 * The number of billable SMS segments for `text`. Empty text is 1 segment
 * (an empty SMS still bills as one), matching carrier behaviour.
 */
export function smsSegments(text: string): number {
  const s = text ?? '';
  if (isGsm7(s)) {
    const len = septetLength(s);
    if (len <= 160) return 1;
    return Math.ceil(len / 153);
  }
  // UCS-2: count UTF-16 code units (surrogate pairs => 2), 70/67 per segment.
  const units = s.length; // JS string length is UTF-16 code-unit count
  if (units <= 70) return 1;
  return Math.ceil(units / 67);
}
