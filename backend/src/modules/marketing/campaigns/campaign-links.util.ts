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
