/**
 * "Was this click a person, or a machine?" — the one question both public
 * click paths have to answer the same way.
 *
 * Corporate mail security (Outlook Safe Links, Defender, Mimecast, Proofpoint),
 * link-preview unfurlers (Slack, WhatsApp, Telegram) and prefetching clients
 * fetch EVERY link in a mail the moment it lands. On a tracking redirect that
 * is a counted click; on a trigger link it is a fired `link.clicked` workflow —
 * 200 leads qualified, 200 discount codes sent, before a human read a word.
 *
 * Two rules the shape of this file exists to enforce:
 *
 * - **Classify, never block.** Callers still do the redirect and still record
 *   the row. Only the side effects a human would have earned are withheld.
 * - **One helper, two callers.** The trigger-link path and the campaign-click
 *   path must not drift into two half-right lists.
 *
 * Why the signals are weighted the way they are: Defender detonation
 * increasingly forges a current Chrome user agent, so the UA list catches the
 * honest machines only. The method and the `Sec-Fetch-*` / `Accept` headers are
 * what a scanner cannot fake without actually being a browser navigation — a
 * real top-level click is `GET` + `Sec-Fetch-Mode: navigate` +
 * `Sec-Fetch-Dest: document` + an `Accept` that asks for HTML, and every
 * browser shipping today (including the Chromium/WebKit webviews inside the
 * Gmail and Outlook apps) sends that shape.
 *
 * Deliberately NOT here: an IP denylist. Scanner egress ranges are shared with
 * real corporate users behind the same gateway, they change weekly, and a
 * false positive is a customer whose click silently did nothing.
 */

/** Structurally compatible with an Express `Request`, without importing one. */
export interface AutomatedFetchRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Honest machines announce themselves. Kept as a weak signal on purpose — a
 * miss here costs nothing, because the header signals carry the weight.
 *
 * `bot` is the one alternative that must be word-bounded, and `bot/<version>`
 * covers the `AhrefsBot/7.0` naming every real crawler uses. A bare substring
 * fires on a Cubot phone's User-Agent, and this verdict outranks the sibling
 * classifier (`machineHitReason` tests `hit.automated` before its own lists),
 * so a false positive here costs that recipient every click-driven automation,
 * their click and their open — permanently and with nothing on screen to say
 * why. The named bots below (slackbot, twitterbot, telegrambot, discordbot)
 * are listed in full for exactly that reason.
 */
const BOT_UA =
  /(\b(bot|bots)\b|bot\/\d|crawler|spider|preview|scan|monitor|curl|wget|python-requests|go-http-client|okhttp|headlesschrome|slackbot|twitterbot|facebookexternalhit|whatsapp|telegrambot|discordbot|bingpreview|msoffice|mimecast|proofpoint)/i;

/** A UA is attacker-supplied text; never hand an unbounded string to a regex. */
const UA_SCAN_LIMIT = 512;

function header(req: AutomatedFetchRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : undefined;
}

/**
 * True when this request looks like a machine rather than a recipient.
 *
 * Pure and total: it never throws, never does I/O, and treats a header bag it
 * does not recognise as "unknown", not as "human".
 */
export function isAutomatedFetch(req: AutomatedFetchRequest): boolean {
  // 1. HEAD. A browser never navigates with HEAD; a scanner probing a link
  //    does. Express routes HEAD to the GET handler, so this is reachable.
  if ((req.method ?? '').toUpperCase() === 'HEAD') return true;

  // 2. The request declares itself as not-a-navigation. Present-but-wrong is
  //    the signal; absent means an older client, which proves nothing.
  const mode = header(req, 'sec-fetch-mode');
  if (mode && mode.toLowerCase() !== 'navigate') return true;
  const dest = header(req, 'sec-fetch-dest');
  if (dest && dest.toLowerCase() !== 'document') return true;
  if ((header(req, 'sec-purpose') ?? '').toLowerCase().includes('prefetch')) return true;

  // 3. An Accept that cannot render a page. A browser's Accept LEADS with
  //    `text/html` and only trails a low-q `*/*`, so "asks for anything" is
  //    read off the FIRST media type — testing for a `*/*` substring would
  //    clear every real Chrome request instead. A bare `*/*` is not proof on
  //    its own (some in-app webviews send it), so it is demoted to a weak
  //    signal below rather than answered here.
  const accept = header(req, 'accept')?.toLowerCase();
  const wildcardFirst = !!accept && accept.trimStart().startsWith('*/*');
  if (accept && !wildcardFirst && !accept.includes('text/html')) return true;

  // 4. No user agent at all, or one that says "I am a machine".
  const ua = (header(req, 'user-agent') ?? '').slice(0, UA_SCAN_LIMIT);
  if (!ua.trim()) return true;
  if (BOT_UA.test(ua)) return true;

  // 5. Weak signals: each is normal on its own, and a pair is not. A browser
  //    sends a specific Accept AND a language; a scripted client usually sends
  //    `Accept: */*` and no language at all.
  let weak = 0;
  if (!accept || wildcardFirst) weak += 1;
  if (!header(req, 'accept-language')) weak += 1;
  return weak >= 2;
}
