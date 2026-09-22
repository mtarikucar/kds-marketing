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
 *
 * ## Cutting too much is the bug this file has already made once
 *
 * The first version cut at the FIRST `>` anywhere in the message, so a customer
 * who answered inline — quote, answer, quote, answer, the normal way to reply
 * to several questions — had every one of their answers thrown away, and the AI
 * answered a blank message (`quote-stripping`). Three rules come out of that:
 *
 * - `>` is only evidence in the **trailing** block. A `>` line with the
 *   customer's own words beneath it is part of the message.
 * - The signature delimiter `--` only counts in the **tail**. A message that
 *   opens with a dashed list is not a signature.
 * - Everything else is a client's own separator, matched whole. A false
 *   positive silently truncates a customer's message, which is worse than
 *   leaving a quote in.
 */

/**
 * Lines that begin the quoted section. Anchored at line start and matched
 * against the TRIMMED line, because clients indent these differently.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // Outlook, English and Turkish, plus its horizontal rule of underscores.
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*(orijinal|özgün) (mesaj|ileti)\s*-{2,}$/i,
  /^_{10,}$/,
  // Forwarded blocks.
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^-{2,}\s*iletilen (mesaj|ileti)\s*-{2,}$/i,
];

/**
 * The "<who> wrote:" line clients put above the quote.
 *
 * Kept apart from the markers above because these are the ones that WRAP: the
 * date, the name and the address together run past any sane line length, so
 * Gmail and Outlook fold them over two or three lines and a per-line match
 * sees none of it. They are matched against the joined form too.
 */
const ATTRIBUTIONS: readonly RegExp[] = [
  // Gmail/Apple: "On <date>, <name> <addr> wrote:". The date can run long, so
  // the tail is what is pinned.
  /^on\b.*\bwrote:$/i,
  // The same line in Turkish: "<date> tarihinde <name> <addr> şunu yazdı:".
  // Matched on both halves so an ordinary sentence containing one of them is
  // not enough to cut the message.
  /^.*\btarihinde\b.*\bşunları?\s+yazdı:$/i,
  // Some Turkish clients drop "şunu" entirely.
  /^.*\btarihinde\b.*\byazdı:$/i,
];

/** How many lines a folded attribution may span before it stops being one.
 *  Three is enough for "date / name / address"; more would let a paragraph
 *  that happens to end in "wrote:" swallow the prose above it. */
const ATTRIBUTION_JOIN_LINES = 3;

/**
 * The header block Outlook writes above a quote, in both languages. Each line
 * must be `Label: <something>`, and at least two must sit together — a lone
 * `Konu: fiyat listesi` is how a person OPENS a mail, not how a client quotes
 * one, and cutting on it would throw the message away.
 */
const OUTLOOK_HEADER_LINE =
  /^(from|sent|to|cc|bcc|subject|date|reply-to|kimden|gönderilen|gönderildi|tarih|kime|bilgi|konu|gizli)\s*:\s*\S/i;

/** Two consecutive header lines, not one. */
const OUTLOOK_HEADER_RUN = 2;

/** The RFC 3676 signature delimiter — "-- " with its significant trailing
 *  space, which arrives trimmed. Everything after it is a signature. */
const SIGNATURE_DELIMITER = /^--$/;

/** How far from the end "--" still reads as a signature delimiter rather than
 *  as a dashed line somebody typed in the body. */
const SIGNATURE_TAIL_LINES = 10;

/** A quoted line. Evidence only where the quote actually is: at the end. */
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
  // Every detector answers independently and the EARLIEST wins, so none of
  // them has to know about the others.
  const cut = earliest([
    separatorCut(lines),
    outlookHeaderCut(lines),
    signatureCut(lines),
    trailingQuoteCut(lines),
  ]);
  if (cut === -1) return trimTrailingBlank(source);

  const head = lines.slice(0, cut).join('\n');
  return head.trim() ? trimTrailingBlank(head) : source;
}

/** The first client separator or attribution line, folded or not. */
function separatorCut(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (QUOTE_MARKERS.some((re) => re.test(line))) return i;
    if (ATTRIBUTIONS.some((re) => re.test(line))) return i;
    // The folded form: join this line with the next one or two and try again.
    // A blank line ends the fold — no client wraps an attribution across one.
    let joined = line;
    for (let span = 1; span < ATTRIBUTION_JOIN_LINES && i + span < lines.length; span++) {
      const next = lines[i + span].trim();
      if (!next) break;
      joined = `${joined} ${next}`;
      if (ATTRIBUTIONS.some((re) => re.test(joined))) return i;
    }
  }
  return -1;
}

/**
 * The start of the first run of consecutive Outlook header lines.
 *
 * The run must also open a block — start of message, a blank line, or a
 * divider above it. A labelled list inside a paragraph ("Kime: Ali" under
 * "aşağıdaki bilgiler") is prose somebody typed, and cutting there would throw
 * their message away; Outlook always separates its block first.
 */
function outlookHeaderCut(lines: string[]): number {
  let runStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OUTLOOK_HEADER_LINE.test(lines[i].trim())) {
      if (runStart === -1) runStart = i;
      if (i - runStart + 1 >= OUTLOOK_HEADER_RUN && opensABlock(lines, runStart)) return runStart;
    } else {
      runStart = -1;
    }
  }
  return -1;
}

function opensABlock(lines: string[], at: number): boolean {
  if (at === 0) return true;
  const previous = lines[at - 1].trim();
  return !previous || /^[-_=*]{3,}$/.test(previous);
}

/** The signature delimiter, but only once we are near the end. */
function signatureCut(lines: string[]): number {
  const tailFrom = lines.length - SIGNATURE_TAIL_LINES;
  for (let i = 0; i < lines.length; i++) {
    if (i < tailFrom) continue;
    if (SIGNATURE_DELIMITER.test(lines[i].trim())) return i;
  }
  return -1;
}

/**
 * The start of the quote block at the END of the message.
 *
 * Walks up from the last non-blank line while the line is quoted or blank, so
 * the blank lines a client leaves inside the quote do not end the walk — and a
 * `>` line with the customer's own answer beneath it is never touched.
 */
function trailingQuoteCut(lines: string[]): number {
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0 || !QUOTED_LINE.test(lines[i].trim())) return -1;

  let start = i;
  while (start > 0) {
    const previous = lines[start - 1].trim();
    if (!previous || QUOTED_LINE.test(previous)) start--;
    else break;
  }
  return start;
}

function earliest(cuts: number[]): number {
  const found = cuts.filter((c) => c >= 0);
  return found.length ? Math.min(...found) : -1;
}

/**
 * Where the quote starts in an HTML body, before any tag stripping.
 *
 * Root-causing the Outlook case in HTML is what keeps the text heuristics
 * honest: flattened to plain text, an Outlook quote loses the very structure
 * that identified it, and `Kimden:` ends up inline with the reply. Every client
 * marks its quote container — `<blockquote>`, Gmail's `gmail_quote`, Outlook's
 * `appendonsend` / `divRplyFwdMsg` / `OutlookMessageHeader`, or a rule above a
 * header block — so the cut is made while those markers are still there.
 */
const HTML_QUOTE_MARKERS: readonly RegExp[] = [
  /<blockquote\b/i,
  /class\s*=\s*["']?[^"'>]*\bgmail_quote\b/i,
  /id\s*=\s*["']?appendonsend\b/i,
  /id\s*=\s*["']?divRplyFwdMsg\b/i,
  /class\s*=\s*["']?[^"'>]*\bOutlookMessageHeader\b/i,
];

/** How much of the document after an `<hr>` is searched for a header block. */
const HR_LOOKAHEAD_CHARS = 600;

/** The same labels as the text side, as they appear between tags. */
const HTML_HEADER_LABEL =
  /(?:^|[>\s;])(from|sent|to|cc|bcc|subject|date|reply-to|kimden|gönderilen|gönderildi|tarih|kime|bilgi|konu|gizli)\s*:/gi;

/** An `<hr>` counts as a quote boundary only when a header block follows it —
 *  on its own it is just a rule somebody put between two paragraphs. */
const HR_HEADER_LABELS_REQUIRED = 2;

export function truncateHtmlQuote(html: string | null | undefined): string {
  const source = String(html ?? '');
  if (!source.trim()) return source;

  const cuts: number[] = [];
  for (const re of HTML_QUOTE_MARKERS) {
    const m = re.exec(source);
    // Back up to the tag the attribute belongs to, or the container itself is
    // kept and the quote leaks out of it.
    if (m) cuts.push(tagStart(source, m.index));
  }
  const hr = hrBeforeHeaderBlock(source);
  if (hr >= 0) cuts.push(hr);
  if (!cuts.length) return source;

  const head = source.slice(0, Math.min(...cuts));
  // Same guarantee as the text side: an empty message looks like the customer
  // said nothing, which is worse than showing them the quote.
  return visibleText(head) ? head : source;
}

/** The index of the `<` that opens the tag containing `at`. */
function tagStart(html: string, at: number): number {
  const open = html.lastIndexOf('<', at);
  return open >= 0 ? open : at;
}

/** The first `<hr>` that has a header block within reach below it. */
function hrBeforeHeaderBlock(html: string): number {
  const rule = /<hr\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(html)) !== null) {
    const window = html.slice(m.index + m[0].length, m.index + m[0].length + HR_LOOKAHEAD_CHARS);
    const labels = new Set<string>();
    HTML_HEADER_LABEL.lastIndex = 0;
    let label: RegExpExecArray | null;
    while ((label = HTML_HEADER_LABEL.exec(window)) !== null) labels.add(label[1].toLowerCase());
    if (labels.size >= HR_HEADER_LABELS_REQUIRED) return m.index;
  }
  return -1;
}

/** Is there anything left once the markup is gone? */
function visibleText(html: string): boolean {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim().length > 0;
}

/** Drop the blank lines a client leaves between the reply and the quote. */
function trimTrailingBlank(s: string): string {
  return s.replace(/\s+$/, '');
}
