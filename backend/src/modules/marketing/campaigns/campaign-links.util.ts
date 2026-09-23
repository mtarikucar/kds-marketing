/**
 * Campaign click-tracking link extraction — pure, so both the freeze
 * (`CampaignsService.launch`) and any later recompute can produce the SAME
 * array from the same content. That matters because `Campaign.links` is an
 * INDEX: the tracked URL carries `?i=<position>` and
 * `CampaignTrackingService.click` resolves the target by that position, so a
 * different order is a different destination.
 *
 * Deliberately a plain util rather than a method on `CampaignsService`:
 * `CampaignSenderService` needs the same function and already imports this
 * module's neighbours, and a service-to-service import would be a cycle.
 */

/** A body pair as it is stored on a campaign or one of its A/B variants. */
export interface CampaignBody {
  body?: string | null;
  bodyHtml?: string | null;
}

/**
 * Bare-URL scan. This is the right extractor for PLAIN-TEXT bodies only: SMS,
 * WhatsApp and voice campaigns, plus the text part of an email — those carry
 * naked URLs and no markup at all, so narrowing them to hrefs would silently
 * end click tracking for every non-HTML campaign.
 */
export function extractPlainLinks(body: string): string[] {
  return [...new Set(body.match(/https?:\/\/[^\s)\]<>"']+/g) ?? [])];
}

/**
 * Anchor-only scan for an HTML body. An `<img src>` must NEVER become a tracked
 * link (img-src-click): image proxies — Gmail's cache, Apple Mail Privacy
 * Protection — fetch every image on open, so a tracked image URL reports a
 * click for a mail nobody clicked, and a click-metric A/B test then picks its
 * winner from image loads.
 */
export function extractHrefLinks(html: string): string[] {
  const out = new Set<string>();
  // Attribute-scoped on purpose: match the href of an <a>, in any of the three
  // quoting styles a compiled or hand-authored template may use.
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    // mailto:/tel:/#anchors/relative paths are not trackable destinations —
    // rewriting them would break the link outright.
    if (/^https?:\/\//i.test(url)) out.add(url);
  }
  return [...out];
}

/**
 * Reverse the renderer's HTML escaping so a tracked link's redirect target is
 * the real URL (`&amp;` → `&` etc.). `&amp;` is decoded LAST to avoid
 * double-decoding (`&amp;lt;` → `&lt;`, not `<`).
 */
export function decodeCampaignHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The campaign's full tracked-link array: the control's text + HTML unioned
 * with every variant's, first-seen order preserved.
 *
 * Feeding it the control alone would drop every variant-only URL AND shift the
 * indices of the surviving ones, which silently kills A/B variant click
 * tracking — so callers must always hand over control + variants together, and
 * variants in a deterministic order (by key).
 */
export function extractCampaignLinks(control: CampaignBody, variants: CampaignBody[]): string[] {
  const out: string[] = [];
  const add = (urls: string[]) => {
    for (const u of urls) if (!out.includes(u)) out.push(u);
  };
  for (const src of [control, ...variants]) {
    add(extractPlainLinks(src.body ?? ''));
    add(extractHrefLinks(decodeCampaignHtml(src.bodyHtml ?? '')));
  }
  return out;
}

/**
 * How many distinct destinations one campaign may track.
 *
 * `Campaign.links` is an INDEX the public redirector resolves by position, so
 * an unbounded array is an unbounded lookup table hosted on the platform's own
 * domain. A marketing email with more than this many distinct URLs is not a
 * marketing email.
 */
export const MAX_TRACKED_LINKS = 200;

/** Why a link cannot be tracked. Codes, not sentences: the launch refusal is
 *  rendered to a tenant and a raw reason is never printed (PLAN G8). */
export type CampaignLinkRefusal = 'BAD_SCHEME' | 'UNPARSEABLE' | 'CREDENTIALS_IN_URL' | 'TOO_MANY';

export type CampaignLinkScreen =
  | { ok: true }
  | { ok: false; reason: CampaignLinkRefusal; url: string };

/**
 * Is every tracked destination something the SHARED redirector may point at?
 *
 * `/api/public/t/c/:token?i=N` resolves out of this array on the PLATFORM's own
 * domain. Until this ran at launch, the only check was "starts with http" at
 * redirect time — which is an open redirector with the platform's name on it:
 * aim it at a credential-harvesting page and every reputation system blames
 * jeetagrowth.com rather than the tenant who wrote the link.
 *
 * Deliberately NARROW. Refusing a link a tenant legitimately wanted is a
 * campaign that cannot ship, so only shapes that cannot be a real marketing
 * destination are refused; everything else is a judgement call this function
 * has no business making.
 */
export function screenCampaignLinks(links: readonly string[]): CampaignLinkScreen {
  if (links.length > MAX_TRACKED_LINKS) {
    return { ok: false, reason: 'TOO_MANY', url: links[MAX_TRACKED_LINKS] ?? '' };
  }
  for (const raw of links) {
    const url = String(raw ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'UNPARSEABLE', url };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'BAD_SCHEME', url };
    }
    if (!parsed.hostname) return { ok: false, reason: 'UNPARSEABLE', url };
    // `https://acme.com@evil.test/` reads as Acme and resolves to evil.test.
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'CREDENTIALS_IN_URL', url };
    }
  }
  return { ok: true };
}
