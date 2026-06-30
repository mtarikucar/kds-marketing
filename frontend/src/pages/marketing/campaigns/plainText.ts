/**
 * Derive a plain-text body from rendered HTML. Used so attaching an HTML email
 * template never forces the operator to also hand-write a plain-text fallback —
 * we generate one from the template when the field is left blank. (The backend
 * requires a non-empty `body`; this keeps that invariant without a manual step.)
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** Decode one entity body (the text between `&` and `;`), or undefined if unknown. */
function decodeEntity(ref: string): string | undefined {
  if (ref[0] === '#') {
    const isHex = ref[1] === 'x' || ref[1] === 'X';
    const code = isHex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
    try {
      return String.fromCodePoint(code);
    } catch {
      return undefined; // lone surrogate / out-of-range
    }
  }
  return NAMED_ENTITIES[ref.toLowerCase()];
}

export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    // Drop the *contents* of script/style blocks entirely.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Tags → space (so adjacent words don't fuse).
    .replace(/<[^>]+>/g, ' ')
    // Decode HTML entities in a SINGLE pass — named plus decimal/hex numeric
    // refs. Real email templates are full of &#8217; / &#x2014; / &hellip;
    // (smart quotes, dashes, ellipses); the old short named-only list leaked
    // those through as literal "&#8217;". A single pass (vs. chained replaces)
    // also stops "&amp;lt;" double-decoding to "<" — it correctly stays "&lt;".
    // Unknown entities are left untouched rather than mangled.
    .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ref) => decodeEntity(ref) ?? m)
    // Collapse runs of whitespace and trim.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The plain-text body to send: the typed text when present, otherwise the text
 * extracted from the attached HTML. Empty only when neither exists (the form
 * validates that case before submit).
 */
export function plainTextBody(body: string | undefined, bodyHtml: string | undefined): string {
  const typed = (body ?? '').trim();
  return typed || htmlToText(bodyHtml);
}
