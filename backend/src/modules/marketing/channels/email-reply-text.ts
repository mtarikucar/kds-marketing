/**
 * Trim the quoted thread off an email reply.
 *
 * Inbound-parse providers do this server-side and hand it over ready —
 * Mailgun's `stripped-text` is the field `EmailChannelAdapter.parseInbound`
 * reaches for first. IMAP has no such courtesy: a mailbox hands over the
 * message exactly as it was sent, quoted history and all.
 *
 * That difference matters more than it looks. Every reply in a thread carries
 * the full transcript beneath it, so without trimming the AI reads its own
 * previous message back as if the customer had written it — growing by one
 * round each time — and the conversation view shows a wall of ">" instead of
 * the sentence someone actually typed. The adapter's own echo guard does not
 * help: it drops mail FROM our address, and this text arrives from theirs.
 *
 * It lives apart from the poller so the next inbound path that lacks a
 * stripped body reuses the rules rather than re-deriving them, and so the
 * rules can be tested as what they are: string handling, no mailbox required.
 */

/**
 * Lines that begin the quoted section. Anchored at line start and matched
 * against the TRIMMED line, because clients indent these differently.
 *
 * Deliberately conservative: each pattern is a client's own separator, not a
 * guess about prose. A false positive here silently truncates a customer's
 * message, which is worse than leaving a quote in.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // Outlook, English and Turkish, plus its horizontal rule of underscores.
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*(orijinal|özgün) (mesaj|ileti)\s*-{2,}$/i,
  /^_{10,}$/,
  // Gmail/Apple attribution: "On <date>, <name> <addr> wrote:". The date can
  // run long, so the tail is what is pinned.
  /^on\b.*\bwrote:$/i,
  // The same line in Turkish: "<date> tarihinde <name> <addr> şunu yazdı:".
  // Matched on both halves so an ordinary sentence containing one of them is
  // not enough to cut the message.
  /^.*\btarihinde\b.*\bşunları?\s+yazdı:$/i,
  // Some Turkish clients drop "şunu" entirely.
  /^.*\btarihinde\b.*\byazdı:$/i,
  // Forwarded blocks.
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^-{2,}\s*iletilen (mesaj|ileti)\s*-{2,}$/i,
  // The RFC 3676 signature delimiter — "-- " with its significant trailing
  // space. Everything after it is a signature, which is noise in a CRM thread.
  /^--$/,
];

/** A quoted line. Last-resort marker: on its own it is weaker evidence than the
 *  attributions above, since a person may legitimately quote a snippet. */
const QUOTED_LINE = /^>/;

/**
 * The part the human actually typed.
 *
 * Returns the original text unchanged when trimming would leave nothing — a
 * reply that is only a quote, or a message whose first line happens to match a
 * marker, is better delivered whole than delivered empty.
 */
export function stripQuotedReply(text: string): string {
  const source = String(text ?? '');
  if (!source.trim()) return source;

  const lines = source.split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (QUOTE_MARKERS.some((re) => re.test(line)) || QUOTED_LINE.test(line)) {
      cut = i;
      break;
    }
  }
  if (cut === -1) return trimTrailingBlank(source);

  const head = lines.slice(0, cut).join('\n');
  return head.trim() ? trimTrailingBlank(head) : source;
}

/** Drop the blank lines a client leaves between the reply and the quote. */
function trimTrailingBlank(s: string): string {
  return s.replace(/\s+$/, '');
}
