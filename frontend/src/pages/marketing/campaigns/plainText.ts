/**
 * Derive a plain-text body from rendered HTML. Used so attaching an HTML email
 * template never forces the operator to also hand-write a plain-text fallback —
 * we generate one from the template when the field is left blank. (The backend
 * requires a non-empty `body`; this keeps that invariant without a manual step.)
 */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    // Drop the *contents* of script/style blocks entirely.
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Tags → space (so adjacent words don't fuse).
    .replace(/<[^>]+>/g, ' ')
    // Common HTML entities.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
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
