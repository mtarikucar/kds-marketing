import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The unsubscribe link in the footer of mail that has no CampaignRecipient row.
 *
 * Today the only unsubscribe token in the product is the per-recipient one a
 * campaign mints at launch, so a workflow/drip `send_email` — commercial mail
 * to a list, by every definition that matters — goes out with no way off the
 * list at all. Minting a recipient row for it would be wrong (there is no
 * campaign) and a token table would be a migration plus a lifetime of rows, so
 * the token IS the claim: `base64url({w,l,c}) . HMAC-SHA256`.
 *
 * Three properties it must have, each learned the hard way:
 *
 * - **Deterministic.** One lead has ONE link, so a resend, a re-rendered footer
 *   and the copy sitting in the recipient's inbox all point at the same URL.
 * - **No expiry.** Mail outlives any TTL we would pick; an expired unsubscribe
 *   link is a compliance failure that reads to the recipient as contempt.
 * - **Workspace-bound.** The tenant is INSIDE the signature, so a token cannot
 *   be re-pointed at another tenant's lead id.
 *
 * Keyed from `MARKETING_SECRET_KEY` through `deriveMailKey` — the same
 * derivation root the suppression pepper uses, label-separated. That shared
 * root is the point: two independently-rotating secrets would leave the footer
 * link 404ing against the very rows it wrote.
 */

/** Only EMAIL today. SMS/WhatsApp opt-out goes through İYS + the NetGSM
 *  blacklist, which this token deliberately does not touch. */
export type UnsubscribeChannel = 'EMAIL';

export interface LeadUnsubscribeClaim {
  workspaceId: string;
  leadId: string;
  channel: UnsubscribeChannel;
}

/**
 * One master key, one derived key per purpose.
 *
 * Returns `null` rather than throwing when `MARKETING_SECRET_KEY` is absent:
 * both callers sit on a send path where a throw becomes a failed mail (G2 —
 * nothing new throws), and "no key" has a correct answer in each of them —
 * BULK fails closed for want of a token, and suppression falls back to the
 * denormalised Lead flags it has always read.
 */
export function deriveMailKey(label: string): Buffer | null {
  const raw = process.env.MARKETING_SECRET_KEY;
  if (!raw) return null;
  return createHmac('sha256', Buffer.from(raw, 'base64')).update(label).digest();
}

const LABEL = 'lead-unsubscribe';

/** Short keys: this travels in a URL that also carries the site's own path. */
interface TokenPayload {
  w: string;
  l: string;
  c: UnsubscribeChannel;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(body: string, key: Buffer): string {
  return b64url(createHmac('sha256', key).update(body).digest());
}

/** The token for this lead's unsubscribe link, or null when unmintable. */
export function signLeadUnsubscribeToken(
  workspaceId: string,
  leadId: string,
  channel: UnsubscribeChannel = 'EMAIL',
): string | null {
  const key = deriveMailKey(LABEL);
  if (!key || !workspaceId || !leadId) return null;
  const payload: TokenPayload = { w: workspaceId, l: leadId, c: channel };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, key)}`;
}

/**
 * The claim inside a token, or null for anything that is not one.
 *
 * Never throws and never distinguishes WHY it said no — a public unsubscribe
 * route is an oracle otherwise. The comparison is constant-time.
 */
export function verifyLeadUnsubscribeToken(token: string): LeadUnsubscribeClaim | null {
  const key = deriveMailKey(LABEL);
  // 4 KiB is far past any legitimate token and stops a huge body being hashed.
  if (!key || typeof token !== 'string' || !token || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig) return null;

  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.w !== 'string' || !payload.w) return null;
    if (typeof payload.l !== 'string' || !payload.l) return null;
    if (payload.c !== 'EMAIL') return null;
    return { workspaceId: payload.w, leadId: payload.l, channel: payload.c };
  } catch {
    return null;
  }
}
