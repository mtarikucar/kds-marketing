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
  exchangeCode(network: Network, code: string): Promise<ExchangeResult>;
  listAssets(token: string): Promise<ConnectableAsset[]>;
  /** Refresh an access token; throws if the provider/refresh fails. */
  refresh?(refreshToken: string): Promise<ExchangeResult>;
}

/** Config-driven authorize URL — handles per-network scope delimiter + client key param. */
export function buildAuthorizeUrl(network: Network, state: string): string {
  const def = NETWORK_OAUTH[network];
  const p = new URLSearchParams({
    redirect_uri: redirectUri(network),
    state,
    response_type: 'code',
    scope: def.scopes.join(def.scopeSep),
  });
  if (network === 'TIKTOK') {
    p.set('client_key', clientId(network) ?? '');
  } else {
    p.set('client_id', clientId(network) ?? '');
  }
  return `${def.authorizeUrl}?${p.toString()}`;
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
    default:
      throw new Error(`OAuth provider not implemented for ${network}`);
  }
}
