import { safeFetch } from '../../../../common/util/safe-fetch';
import {
  NETWORK_OAUTH,
  Network,
  clientId,
  clientSecret,
  redirectUri,
} from './social-oauth.config';

/** A page/profile/account the user can choose to connect after OAuth. */
export interface ConnectableAsset {
  externalId: string;
  displayName: string;
  accountType: string; // PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK
  /** Per-asset token (e.g. FB page token); falls back to the user token. */
  token?: string;
}

/** Normalized result of exchanging an auth code for tokens. */
export interface ExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface SocialOAuthProvider {
  /** Exchange the auth code for tokens. `codeVerifier` is supplied for PKCE networks. */
  exchangeCode(network: Network, code: string, codeVerifier?: string): Promise<ExchangeResult>;
  listAssets(token: string): Promise<ConnectableAsset[]>;
  /** Refresh an access token; throws if the provider/refresh fails. */
  refresh?(refreshToken: string): Promise<ExchangeResult>;
}

/**
 * Config-driven authorize URL — handles per-network scope delimiter, client key
 * param, extra params (Google offline access), and the PKCE challenge (X).
 */
export function buildAuthorizeUrl(
  network: Network,
  state: string,
  codeChallenge?: string,
): string {
  const def = NETWORK_OAUTH[network];
  const p = new URLSearchParams({
    redirect_uri: redirectUri(network),
    state,
    response_type: 'code',
  });
  // Facebook Login for Business (FLB) grants permissions via a *configuration*
  // (config_id), NOT raw scopes — passing scope to an FLB app yields
  // "Invalid Scopes: pages_manage_posts". When META_LOGIN_CONFIG_ID is set we
  // use the FLB config flow (scope is defined by the configuration); otherwise
  // fall back to the classic scope-based request.
  const metaConfigId =
    network === 'FACEBOOK' || network === 'INSTAGRAM'
      ? process.env.META_LOGIN_CONFIG_ID
      : undefined;
  if (metaConfigId) {
    p.set('config_id', metaConfigId);
  } else {
    p.set('scope', def.scopes.join(def.scopeSep));
  }
  if (network === 'TIKTOK') {
    p.set('client_key', clientId(network) ?? '');
  } else {
    p.set('client_id', clientId(network) ?? '');
  }
  for (const [k, v] of Object.entries(def.extraAuthParams ?? {})) {
    p.set(k, v);
  }
  if (def.pkce && codeChallenge) {
    p.set('code_challenge', codeChallenge);
    p.set('code_challenge_method', 'S256');
  }
  return `${def.authorizeUrl}?${p.toString()}`;
}

/** Basic-auth header for a confidential-client token exchange (X, Pinterest). */
function basicAuth(network: Network): string {
  const raw = `${clientId(network) ?? ''}:${clientSecret(network) ?? ''}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

const GRAPH = 'https://graph.facebook.com/v19.0';

/** Meta (Facebook + Instagram) share one app/token; IG accounts hang off Pages. */
export const metaProvider: SocialOAuthProvider = {
  async exchangeCode(network: Network, code: string): Promise<ExchangeResult> {
    const shortRes = await safeFetch(
      `${GRAPH}/oauth/access_token?` +
        new URLSearchParams({
          client_id: clientId(network) ?? '',
          client_secret: clientSecret(network) ?? '',
          redirect_uri: redirectUri(network),
          code,
        }).toString(),
      { method: 'GET', timeoutMs: 15000 },
    );
    const short = (await shortRes.json()) as any;
    if (!shortRes.ok || !short.access_token) {
      throw new Error(short?.error?.message ?? 'meta token exchange failed');
    }
    // Upgrade to a long-lived user token (~60d); page tokens derived from it
    // are effectively non-expiring.
    const llRes = await safeFetch(
      `${GRAPH}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: clientId(network) ?? '',
          client_secret: clientSecret(network) ?? '',
          fb_exchange_token: short.access_token,
        }).toString(),
      { method: 'GET', timeoutMs: 15000 },
    );
    const ll = (await llRes.json()) as any;
    const accessToken = ll?.access_token ?? short.access_token;
    const expiresAt = ll?.expires_in ? new Date(Date.now() + ll.expires_in * 1000) : undefined;
    return { accessToken, expiresAt };
  },

  async listAssets(userToken: string): Promise<ConnectableAsset[]> {
    const out: ConnectableAsset[] = [];
    const pagesRes = await safeFetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`,
      { method: 'GET', timeoutMs: 15000 },
    );
    const pages = (await pagesRes.json()) as any;
    if (!pagesRes.ok) {
      throw new Error(pages?.error?.message ?? 'failed to list Facebook pages');
    }
    for (const pg of pages?.data ?? []) {
      out.push({
        externalId: pg.id,
        displayName: pg.name,
        accountType: 'PAGE',
        token: pg.access_token,
      });
      try {
        const igRes = await safeFetch(
          `${GRAPH}/${pg.id}?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(pg.access_token)}`,
          { method: 'GET', timeoutMs: 15000 },
        );
        const ig = (await igRes.json()) as any;
        const iga = ig?.instagram_business_account;
        if (iga?.id) {
          out.push({
            externalId: iga.id,
            displayName: iga.username ? `@${iga.username}` : `${pg.name} (Instagram)`,
            accountType: 'IG_BUSINESS',
            token: pg.access_token,
          });
        }
      } catch {
        /* page without a linked IG business account — skip */
      }
    }
    return out;
  },
};

// ──────────────────────────────────────────────────────────────── LinkedIn

const LI_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

async function linkedinTokenRequest(form: Record<string, string>): Promise<ExchangeResult> {
  const res = await safeFetch(LI_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 15000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(json?.error_description ?? json?.error ?? 'linkedin token request failed');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
  };
}

/** LinkedIn — connects the member's own profile and any organizations they admin. */
export const linkedinProvider: SocialOAuthProvider = {
  exchangeCode(_network: Network, code: string): Promise<ExchangeResult> {
    return linkedinTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri('LINKEDIN'),
      client_id: clientId('LINKEDIN') ?? '',
      client_secret: clientSecret('LINKEDIN') ?? '',
    });
  },

  refresh(refreshToken: string): Promise<ExchangeResult> {
    return linkedinTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId('LINKEDIN') ?? '',
      client_secret: clientSecret('LINKEDIN') ?? '',
    });
  },

  async listAssets(token: string): Promise<ConnectableAsset[]> {
    const out: ConnectableAsset[] = [];
    // The member's own profile (OpenID userinfo).
    try {
      const meRes = await safeFetch('https://api.linkedin.com/v2/userinfo', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 15000,
      });
      const me = (await meRes.json()) as any;
      if (meRes.ok && me?.sub) {
        out.push({
          externalId: me.sub,
          displayName: me.name ? `${me.name} (LinkedIn)` : 'My LinkedIn profile',
          accountType: 'LI_PERSON',
          token,
        });
      }
    } catch {
      /* userinfo unavailable — skip the person asset */
    }
    // Organizations the member administers.
    try {
      const orgRes = await safeFetch(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(localizedName)))',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' },
          timeoutMs: 15000,
        },
      );
      const orgs = (await orgRes.json()) as any;
      for (const el of orgs?.elements ?? []) {
        const urn: string = el?.organization ?? '';
        const id = urn.split(':').pop();
        const name = el?.['organization~']?.localizedName;
        if (id) {
          out.push({
            externalId: id,
            displayName: name ?? `Organization ${id}`,
            accountType: 'LI_ORG',
            token,
          });
        }
      }
    } catch {
      /* no admin orgs / insufficient scope — person-only is fine */
    }
    return out;
  },
};

// ──────────────────────────────────────────────────────────────── TikTok

const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';

async function tiktokTokenRequest(form: Record<string, string>): Promise<ExchangeResult> {
  const res = await safeFetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 15000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(json?.error_description ?? json?.error ?? 'tiktok token request failed');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
  };
}

/** TikTok — a single creator account; the open_id identifies it for publishing. */
export const tiktokProvider: SocialOAuthProvider = {
  exchangeCode(_network: Network, code: string): Promise<ExchangeResult> {
    return tiktokTokenRequest({
      client_key: clientId('TIKTOK') ?? '',
      client_secret: clientSecret('TIKTOK') ?? '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri('TIKTOK'),
    });
  },

  refresh(refreshToken: string): Promise<ExchangeResult> {
    return tiktokTokenRequest({
      client_key: clientId('TIKTOK') ?? '',
      client_secret: clientSecret('TIKTOK') ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  },

  async listAssets(token: string): Promise<ConnectableAsset[]> {
    const res = await safeFetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 15000,
      },
    );
    const json = (await res.json()) as any;
    const user = json?.data?.user;
    if (!res.ok || !user?.open_id) {
      throw new Error(json?.error?.message ?? 'failed to fetch TikTok account');
    }
    return [
      {
        externalId: user.open_id,
        displayName: user.display_name ? `${user.display_name} (TikTok)` : 'My TikTok account',
        accountType: 'TIKTOK',
        token,
      },
    ];
  },
};

// ──────────────────────────────────────────────────────────────── X / Twitter

const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

async function xTokenRequest(form: Record<string, string>): Promise<ExchangeResult> {
  // Confidential client ⇒ HTTP Basic auth (client_id:client_secret).
  const res = await safeFetch(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth('TWITTER'),
    },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 15000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(json?.error_description ?? json?.error ?? 'X token request failed');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
  };
}

/** X/Twitter — OAuth2 + PKCE; connects the authenticated user's own account. */
export const twitterProvider: SocialOAuthProvider = {
  exchangeCode(_network: Network, code: string, codeVerifier?: string): Promise<ExchangeResult> {
    return xTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri('TWITTER'),
      client_id: clientId('TWITTER') ?? '',
      code_verifier: codeVerifier ?? '',
    });
  },

  refresh(refreshToken: string): Promise<ExchangeResult> {
    return xTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId('TWITTER') ?? '',
    });
  },

  async listAssets(token: string): Promise<ConnectableAsset[]> {
    const res = await safeFetch('https://api.twitter.com/2/users/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15000,
    });
    const json = (await res.json()) as any;
    const user = json?.data;
    if (!res.ok || !user?.id) {
      throw new Error(json?.detail ?? json?.title ?? 'failed to fetch X account');
    }
    return [
      {
        externalId: user.id,
        displayName: user.username ? `@${user.username} (X)` : 'My X account',
        accountType: 'TWITTER',
        token,
      },
    ];
  },
};

// ──────────────────────────────────────────────────────────────── Pinterest

const PINTEREST_TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';

async function pinterestTokenRequest(form: Record<string, string>): Promise<ExchangeResult> {
  const res = await safeFetch(PINTEREST_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth('PINTEREST'),
    },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 15000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(json?.message ?? json?.error_description ?? json?.error ?? 'pinterest token request failed');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
  };
}

/** Pinterest — each board the user owns is a publishable asset (board_id). */
export const pinterestProvider: SocialOAuthProvider = {
  exchangeCode(_network: Network, code: string): Promise<ExchangeResult> {
    return pinterestTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri('PINTEREST'),
    });
  },

  refresh(refreshToken: string): Promise<ExchangeResult> {
    return pinterestTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  },

  async listAssets(token: string): Promise<ConnectableAsset[]> {
    const res = await safeFetch('https://api.pinterest.com/v5/boards?page_size=100', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15000,
    });
    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new Error(json?.message ?? 'failed to list Pinterest boards');
    }
    return (json?.items ?? [])
      .filter((b: any) => b?.id)
      .map((b: any) => ({
        externalId: String(b.id),
        displayName: b.name ? `${b.name} (Pinterest board)` : `Board ${b.id}`,
        accountType: 'PINTEREST_BOARD',
        token,
      }));
  },
};

// ──────────────────────────────────────────────────── Google Business Profile

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GBP_ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';

async function googleTokenRequest(form: Record<string, string>): Promise<ExchangeResult> {
  const res = await safeFetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 15000,
  });
  const json = (await res.json()) as any;
  if (!res.ok || !json.access_token) {
    throw new Error(json?.error_description ?? json?.error ?? 'google token request failed');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
  };
}

/**
 * Google Business Profile — locations across the user's GBP accounts. externalId
 * is the full `accounts/{a}/locations/{l}` resource (what the Local Post publish
 * adapter posts to). Inert until Google allowlists the Business Profile APIs.
 */
export const gmbProvider: SocialOAuthProvider = {
  exchangeCode(_network: Network, code: string): Promise<ExchangeResult> {
    return googleTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri('GMB'),
      client_id: clientId('GMB') ?? '',
      client_secret: clientSecret('GMB') ?? '',
    });
  },

  refresh(refreshToken: string): Promise<ExchangeResult> {
    return googleTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId('GMB') ?? '',
      client_secret: clientSecret('GMB') ?? '',
    });
  },

  async listAssets(token: string): Promise<ConnectableAsset[]> {
    const acctRes = await safeFetch(GBP_ACCOUNTS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 15000,
    });
    const acctJson = (await acctRes.json()) as any;
    if (!acctRes.ok) {
      throw new Error(acctJson?.error?.message ?? 'failed to list Google Business accounts');
    }
    const out: ConnectableAsset[] = [];
    for (const acct of acctJson?.accounts ?? []) {
      const acctName: string = acct?.name ?? ''; // "accounts/{a}"
      if (!acctName) continue;
      try {
        const locRes = await safeFetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acctName}/locations?readMask=name,title&pageSize=100`,
          { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 15000 },
        );
        const locJson = (await locRes.json()) as any;
        for (const loc of locJson?.locations ?? []) {
          const locName: string = loc?.name ?? ''; // "locations/{l}"
          if (!locName) continue;
          out.push({
            externalId: `${acctName}/${locName}`,
            displayName: loc?.title ? `${loc.title} (Google Business)` : locName,
            accountType: 'GMB_LOCATION',
            token,
          });
        }
      } catch {
        /* a single account's locations being unavailable shouldn't fail the rest */
      }
    }
    return out;
  },
};

/** Dispatch to the right provider. */
export function providerFor(network: Network): SocialOAuthProvider {
  switch (network) {
    case 'FACEBOOK':
    case 'INSTAGRAM':
      return metaProvider;
    case 'LINKEDIN':
      return linkedinProvider;
    case 'TIKTOK':
      return tiktokProvider;
    case 'TWITTER':
      return twitterProvider;
    case 'PINTEREST':
      return pinterestProvider;
    case 'GMB':
      return gmbProvider;
    default:
      throw new Error(`OAuth provider not implemented for ${network}`);
  }
}
