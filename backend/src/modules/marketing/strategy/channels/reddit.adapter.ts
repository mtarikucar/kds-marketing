import { Logger } from '@nestjs/common';
import type {
  CommunityChannelService,
  RedditTokenBundle,
} from './community-channel.service';
import {
  REDDIT_USER_AGENT,
  isRedditEnvConfigured,
} from './community-channel.service';

/**
 * Reddit community channel adapter — submits ONE self (text) post to a subreddit
 * using the PER-WORKSPACE connected Reddit account.
 *
 * SAFETY / ToS: only submit to subreddits you OWN or are explicitly authorized to
 * post marketing in. Auto-posting promotional content to communities you do not
 * control violates Reddit's Content Policy + subreddit rules and gets accounts
 * banned. The CALLER is responsible for ensuring `subreddit` is an owned/authorized
 * target — this adapter only performs the API mechanics. Live posting is opt-in
 * and creds-gated (mirrors the `isNetworkConfigured` gating the social publishers
 * use); it is INERT unless the workspace connected its OWN Reddit account (OAuth)
 * AND the platform Reddit app creds (REDDIT_CLIENT_ID/SECRET) are present.
 *
 * Auth model: each workspace connects its own account via OAuth (duration=permanent
 * → refresh token). The sealed { access, refresh, expiresAt } bundle lives on the
 * workspace's CommunityChannelConfig; this adapter unseals it (via the service),
 * refreshes the access token when expired (re-sealing the new bundle), and submits.
 */
const logger = new Logger('RedditAdapter');

/** Refresh the access token ~1 min before expiry to avoid a mid-request 401. */
const EXPIRY_SKEW_MS = 60 * 1000;

export interface ChannelPostResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * True only when the workspace connected its own Reddit account AND the platform
 * app creds are present. Inert otherwise (→ the executor stages a draft).
 */
export async function isRedditConfigured(
  workspaceId: string,
  svc: CommunityChannelService,
): Promise<boolean> {
  if (!isRedditEnvConfigured()) return false;
  return !!(await svc.getRedditToken(workspaceId));
}

/**
 * Ensure a non-expired access token for this workspace, refreshing (and re-sealing)
 * via the refresh grant when needed. Returns the access token, or null on failure.
 */
async function ensureAccessToken(
  workspaceId: string,
  svc: CommunityChannelService,
): Promise<{ token?: string; error?: string }> {
  const bundle = await svc.getRedditToken(workspaceId);
  if (!bundle) return { error: 'Reddit not connected for this workspace' };
  if (bundle.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return { token: bundle.access };
  }
  if (!bundle.refresh) return { error: 'Reddit access token expired and no refresh token is stored' };
  try {
    const refreshed: RedditTokenBundle = await svc.redditTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: bundle.refresh,
    });
    // A refresh grant may omit refresh_token — keep the existing one.
    if (!refreshed.refresh) refreshed.refresh = bundle.refresh;
    await svc.saveRedditToken(workspaceId, refreshed);
    return { token: refreshed.access };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Reddit token refresh failed: ${msg}`.slice(0, 500) };
  }
}

/**
 * Submit a self post to `subreddit` (accepts "r/Foo" or "Foo") using the
 * workspace's connected account. Obtains/refreshes an access token, then POSTs
 * `/api/submit` (kind: self). Any failure — auth, transport, or Reddit's
 * `json.errors` (which arrive even on HTTP 200) — degrades to `{ ok:false, error }`
 * so the caller can stage a draft instead.
 */
export async function postToReddit(
  workspaceId: string,
  svc: CommunityChannelService,
  { subreddit, title, text }: { subreddit: string; title: string; text: string },
): Promise<ChannelPostResult> {
  if (!isRedditEnvConfigured()) {
    return { ok: false, error: 'Reddit not configured: set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET' };
  }
  try {
    const auth = await ensureAccessToken(workspaceId, svc);
    if (!auth.token) return { ok: false, error: auth.error ?? 'Reddit auth failed' };

    const sr = subreddit.replace(/^\/?r\//i, '').trim(); // "r/Foo" | "/r/Foo" | "Foo" → "Foo"
    const res = await fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': REDDIT_USER_AGENT,
      },
      body: new URLSearchParams({ api_type: 'json', kind: 'self', sr, title, text }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Reddit submit HTTP ${res.status} ${body}`.trim().slice(0, 500) };
    }
    const json = (await res.json().catch(() => ({}))) as {
      json?: { errors?: unknown[]; data?: Record<string, unknown> };
    };
    // Reddit reports validation failures in json.json.errors even on a 200.
    const errs = json?.json?.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      return { ok: false, error: `Reddit submit: ${JSON.stringify(errs)}`.slice(0, 500) };
    }
    const data = json?.json?.data ?? {};
    const id = (data.id ?? data.name ?? data.url) as string | undefined;
    return { ok: true, id: id ? String(id) : undefined };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`Reddit submit error: ${msg}`);
    return { ok: false, error: msg.slice(0, 500) };
  }
}
