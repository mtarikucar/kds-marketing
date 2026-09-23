import { createHmac, timingSafeEqual } from 'crypto';
import { deriveMailKey } from '../channels/lead-unsubscribe.token';

/**
 * The `?c=` on a trigger link — who this click belongs to.
 *
 * Attribution is not decoration here: a click with a lead attached fires
 * `link.clicked` with `trigger.leadId`, which qualifies the lead, sends the
 * code and opens the task. A RAW lead id in a query string means anyone who
 * has ever seen one — an exported CSV, a shared inbox, a forwarded mail, a
 * former employee — can mint that outcome for any lead, as many times as they
 * like, by typing it.
 *
 * So the claim is signed. Three properties, each deliberate:
 *
 * - **Deterministic.** One lead has ONE link. A resend, a re-rendered template
 *   and the copy already sitting in an inbox all point at the same URL, so the
 *   same click is the same click.
 * - **No expiry.** The mail outlives any TTL we would pick, and an expired
 *   attribution reads to the tenant as "clicks stopped working".
 * - **Workspace-bound.** The tenant is INSIDE the signature, so a token cannot
 *   be re-pointed at another tenant's lead id. The service still scopes the
 *   lead lookup to the link's workspace; this is the belt, that is the braces.
 *
 * Keyed through `deriveMailKey` — the same derivation root the unsubscribe
 * token and the suppression pepper use, under its own label so one token shape
 * can never be replayed as another.
 *
 * NOT a fix for forwarding. A forwarded mail carries a valid token, and the
 * friend who clicks it is recorded as the lead. Nothing in a link can tell
 * those apart; what this stops is FORGING a click for a lead id you already
 * know.
 */

const LABEL = 'trigger-link-contact';

/** Short keys: this rides in a query string next to whatever else is there. */
interface TokenPayload {
  w: string;
  l: string;
}

export interface TriggerLinkContactClaim {
  workspaceId: string;
  leadId: string;
}

function sign(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

/**
 * The `?c=` value for this lead, or `null` when unmintable —
 * `MARKETING_SECRET_KEY` absent, or a blank subject.
 *
 * Returns null rather than throwing: every caller is on a send path, where a
 * throw becomes a failed mail (G2). A link with no `?c=` still works; it just
 * records an unattributed click.
 */
export function signTriggerLinkContact(workspaceId: string, leadId: string): string | null {
  const key = deriveMailKey(LABEL);
  if (!key || !workspaceId || !leadId) return null;
  const payload: TokenPayload = { w: workspaceId, l: leadId };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, key)}`;
}

/**
 * The claim inside a `?c=`, or null for anything that is not one.
 *
 * Never throws and never distinguishes WHY it said no — a public click route
 * that answered "bad signature" versus "unknown lead" would be an oracle for
 * which lead ids exist. The comparison is constant-time.
 */
export function verifyTriggerLinkContact(token: unknown): TriggerLinkContactClaim | null {
  const key = deriveMailKey(LABEL);
  // 4 KiB is far past any legitimate token and stops a huge query string being
  // hashed on an unauthenticated route.
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
    return { workspaceId: payload.w, leadId: payload.l };
  } catch {
    return null;
  }
}

/**
 * Is this deployment able to sign at all?
 *
 * The click path needs to know, because "no key" has a different correct
 * answer from "bad signature": without a key nothing can MINT a signed link
 * either, so refusing raw ids would silently switch attribution off for a
 * deployment that has been running fine. See `TriggerLinksService.click`.
 */
export function canSignTriggerLinkContact(): boolean {
  return deriveMailKey(LABEL) !== null;
}
