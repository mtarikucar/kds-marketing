import { stripQuotedReply } from '../email-reply-text';

/**
 * "Beni listeden çıkarın" — read from a reply, in the ingress.
 *
 * ## Why it lives here and not in the AI engine
 *
 * The obvious home is `conversation-ai-engine.service.ts`, where a tool could
 * record the opt-out. That protects only a workspace with `conversationAi` AND
 * an ACTIVE agent on the channel — the common case (campaigns and drips, no
 * agent) is exactly the case that keeps mailing somebody who asked it to stop.
 * So detection sits on the one path every inbound message takes, AI or not.
 *
 * ## Three rules the naive version got wrong
 *
 * - **De-quoted text only.** Every reply to a campaign quotes the original,
 *   and the original carries the unsubscribe footer. A substring matcher would
 *   opt out the whole audience the first time anyone answered.
 * - **Phrases, word-bounded, never substrings.** "dur" lives inside "durum",
 *   "iptal" inside "siparişimi iptal edin" (a cancellation, not an opt-out),
 *   "stop" inside "stopaj". Single words count only when they are essentially
 *   the whole message.
 * - **Folded, not just lower-cased.** Half of Turkey types "cikarin" for
 *   "çıkarın", and `'İ'.toLowerCase()` yields `i` + a combining dot that no
 *   pattern written by hand will ever match. Both sides are folded to ASCII.
 *
 * A false positive is not cheap — the caller writes through
 * `SuppressionService`, which for SMS reaches the operator blacklist and İYS —
 * so everything here is deliberately conservative.
 */

/** What the detector concluded, and which phrase decided it. */
export interface OptOutDetection {
  matched: boolean;
  /** The folded pattern that fired, for the audit note. Null when none did. */
  phrase: string | null;
}

export interface OptOutOptions {
  /**
   * Drop a leading line that is followed by a blank one.
   *
   * `EmailChannelAdapter.parseInbound` builds the message text as
   * `${subject}\n\n${body}`, so a reply to a campaign called "Listeden çıkmak
   * için tıklayın" would otherwise opt out everyone who answered it. Only the
   * email callers pass this; a one-line message is a body, not a subject.
   */
  skipFirstLine?: boolean;
}

/**
 * Phrases, as word sequences. A trailing `*` on a word matches a PREFIX — one
 * entry then covers every Turkish suffix ("çıkmak", "çıkarın", "çıkartın") —
 * and every other word has to match whole, which is what keeps "dur" out of
 * "durum". Written in the folded alphabet the text is compared in.
 */
const PHRASES: readonly string[] = [
  // --- Turkish
  'abonelikten cik*',
  'abonelikten ayril*',
  'listeden cik*',
  'beni cikar*',
  'beni listeden cik*',
  'mail gondermeyin',
  'mail atmayin',
  'e posta* gondermeyin',
  'eposta* gondermeyin',
  'ileti istemiyorum',
  'e posta* almak istemiyorum',
  'eposta* almak istemiyorum',
  'mail almak istemiyorum',
  'bilgilendirme istemiyorum',
  // --- English
  'unsubscribe',
  'stop emailing me',
  'stop sending me',
  'remove me from',
  'take me off',
  'opt me out',
];

/**
 * Single words that mean "stop" ONLY as the entire message. NetGSM's own SMS
 * convention, and what people type back at a mail they want to end.
 */
const WHOLE_MESSAGE_WORDS: readonly string[] = ['dur', 'stop', 'iptal', 'ret', 'unsubscribe', 'cik'];

/** A body this short cannot be anything but the word itself. */
const WHOLE_MESSAGE_MAX_TOKENS = 1;

/**
 * Lower-case, strip diacritics, and fold the letters JavaScript will not.
 *
 * `'çık'` and `'cik'` have to compare equal, and so do `'İPTAL'` and `'iptal'`
 * — the second of which `toLowerCase()` turns into `i` + U+0307, a spelling no
 * pattern in this file contains.
 */
function foldTurkish(value: string): string {
  return String(value ?? '')
    .normalize('NFKD')
    // Everything NFKD split off: the cedilla, the breve, the umlaut, and the
    // dot above that lower-casing 'İ' produces.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ç/g, 'c');
}

/** The comparison form: folded words, punctuation gone. */
function words(value: string): string[] {
  return foldTurkish(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Does `pattern` occur as a word sequence in `tokens`? */
function containsPhrase(tokens: readonly string[], pattern: readonly string[]): boolean {
  if (!pattern.length || tokens.length < pattern.length) return false;
  for (let start = 0; start + pattern.length <= tokens.length; start++) {
    let hit = true;
    for (let i = 0; i < pattern.length; i++) {
      const want = pattern[i];
      const got = tokens[start + i];
      const ok = want.endsWith('*') ? got.startsWith(want.slice(0, -1)) : got === want;
      if (!ok) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** The part the human typed, with any quote of ours removed. */
function humanText(text: string, opts: OptOutOptions): string {
  let source = String(text ?? '');
  if (opts.skipFirstLine) {
    const lines = source.split(/\r?\n/);
    // Only a first line that OPENS a block is the prepended subject. A message
    // that is one line long is the message.
    if (lines.length > 2 && !lines[1].trim()) source = lines.slice(2).join('\n');
  }
  return stripQuotedReply(source)
    .split(/\r?\n/)
    // Belt and braces over `stripQuotedReply`: an interleaved answer legitimately
    // keeps quoted lines around it, and OUR footer is in those lines.
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * Did this person ask to stop hearing from us?
 *
 * Never throws and never guesses: an empty body, a quote-only reply and an
 * order cancellation all answer `false`.
 */
export function detectOptOut(
  text: string | null | undefined,
  opts: OptOutOptions = {},
): OptOutDetection {
  const tokens = words(humanText(String(text ?? ''), opts));
  if (!tokens.length) return { matched: false, phrase: null };

  for (const pattern of PHRASES) {
    if (containsPhrase(tokens, pattern.split(' '))) {
      return { matched: true, phrase: pattern.replace(/\*/g, '') };
    }
  }

  if (tokens.length <= WHOLE_MESSAGE_MAX_TOKENS && WHOLE_MESSAGE_WORDS.includes(tokens[0])) {
    return { matched: true, phrase: tokens[0] };
  }
  return { matched: false, phrase: null };
}
