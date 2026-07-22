import { Logger } from '@nestjs/common';

/**
 * Reddit community channel adapter — submits ONE self (text) post to a subreddit.
 *
 * SAFETY / ToS: only submit to subreddits you OWN or are explicitly authorized to
 * post marketing in. Auto-posting promotional content to communities you do not
 * control violates Reddit's Content Policy + subreddit rules and gets accounts
 * banned. The CALLER is responsible for ensuring `subreddit` is an owned/authorized
 * target — this adapter only performs the API mechanics. Live posting is opt-in
 * and creds-gated (mirrors the `isNetworkConfigured` gating the social publishers
 * use); it is INERT unless all three env vars below are set, in which case the
 * executor stages a human-review draft instead.
 *
 * Auth model: a Reddit "script"/installed OAuth app using a long-lived REFRESH
 * token for the owned account (no interactive flow at post time).
 * ENV to add (deploy.yml — documented only, not edited here):
 *   REDDIT_CLIENT_ID      — the app's client id
 *   REDDIT_CLIENT_SECRET  — the app's secret
 *   REDDIT_REFRESH_TOKEN  — an OAuth refresh token for the owned account
 */
const logger = new Logger('RedditAdapter');

/** Reddit requires a descriptive, unique User-Agent on every request. */
const REDDIT_USER_AGENT = 'web:jeeta-growth-strategy-engine:v1 (community-engage)';

export interface ChannelPostResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** True only when a full script/refresh-token app is configured. Inert otherwise. */
export function isRedditConfigured(): boolean {
  return !!(
    process.env.REDDIT_CLIENT_ID &&
    process.env.REDDIT_CLIENT_SECRET &&
    process.env.REDDIT_REFRESH_TOKEN
  );
}

/** Exchange the refresh token for a short-lived access token (Basic-auth app creds). */
async function getAccessToken(): Promise<{ token?: string; error?: string }> {
  const basic = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`,
  ).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': REDDIT_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: String(process.env.REDDIT_REFRESH_TOKEN),
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `Reddit token HTTP ${res.status} ${body}`.trim().slice(0, 500) };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const token = json?.access_token;
  return token ? { token: String(token) } : { error: 'Reddit token: no access_token returned' };
}

/**
 * Submit a self post to `subreddit` (accepts "r/Foo" or "Foo"). Obtains an access
 * token via the refresh grant, then POSTs `/api/submit` (kind: self). Any failure
 * — auth, transport, or Reddit's `json.errors` (which arrive even on HTTP 200) —
 * degrades to `{ ok:false, error }` so the caller can stage a draft instead.
 */
export async function postToReddit({
  subreddit,
  title,
  text,
}: {
  subreddit: string;
  title: string;
  text: string;
}): Promise<ChannelPostResult> {
  if (!isRedditConfigured()) {
    return {
      ok: false,
      error: 'Reddit not configured: set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REFRESH_TOKEN',
    };
  }
  try {
    const auth = await getAccessToken();
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
