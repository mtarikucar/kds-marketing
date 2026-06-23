import { safeFetch } from '../../../../common/util/safe-fetch';
import { metaGraphFetch, graphBaseUrl } from '../../../../common/util/meta-graph.util';
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
  // PAGE | IG_BUSINESS | LI_PERSON | LI_ORG | TIKTOK | WHATSAPP_NUMBER | AD_ACCOUNT
  accountType: string;
  /** Per-asset token (e.g. FB page token); falls back to the user token. */
  token?: string;
  /** Typed extras the provisioner needs (phoneNumberId, wabaId, accountId, currency…). */
  meta?: Record<string, unknown>;
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
  return `${def.authorizeUrl}?${p.toString()}`;
}

/** Meta (Facebook + Instagram) share one app/token; IG accounts hang off Pages.
 *  Token EXCHANGE uses plain safeFetch (no appsecret_proof — there's no token
 *  yet, only client_secret); all authenticated READS go through metaGraphFetch
 *  so they carry appsecret_proof + the configured Graph version. */
export const metaProvider: SocialOAuthProvider = {
  async exchangeCode(network: Network, code: string): Promise<ExchangeResult> {
    const base = graphBaseUrl();
    const shortRes = await safeFetch(
      `${base}/oauth/access_token?` +
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
      `${base}/oauth/access_token?` +
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
    // Pages (+ linked IG business accounts) — the core publishing assets; throws
    // on failure (this is the minimum the connect flow needs).
    const pagesRes = await metaGraphFetch('/me/accounts', {
      accessToken: userToken,
      query: { fields: 'id,name,access_token' },
      timeoutMs: 15000,
    });
    if (!pagesRes.ok) {
      throw new Error(pagesRes.error?.message ?? 'failed to list Facebook pages');
    }
    for (const pg of pagesRes.data?.data ?? []) {
      out.push({
        externalId: pg.id,
        displayName: pg.name,
        accountType: 'PAGE',
        token: pg.access_token,
        meta: { pageId: pg.id },
      });
      try {
        const igRes = await metaGraphFetch(`/${pg.id}`, {
          accessToken: pg.access_token,
          query: { fields: 'instagram_business_account{id,username}' },
          timeoutMs: 15000,
        });
        const iga = igRes.ok ? igRes.data?.instagram_business_account : null;
        if (iga?.id) {
          out.push({
            externalId: iga.id,
            displayName: iga.username ? `@${iga.username}` : `${pg.name} (Instagram)`,
            accountType: 'IG_BUSINESS',
            token: pg.access_token,
            meta: { pageId: pg.id },
          });
        }
      } catch {
        /* page without a linked IG business account — skip */
      }
    }
    // Ad accounts + WhatsApp numbers are OPTIONAL (need ads_read /
    // whatsapp_business_management — App-Review-gated). Degrade gracefully so a
    // publish-only grant still yields the page assets.
    try {
      out.push(...(await discoverAdAccounts(userToken)));
    } catch {
      /* no ads_read — skip ad accounts */
    }
    try {
      out.push(...(await discoverWhatsApp(userToken)));
    } catch {
      /* no WhatsApp scope — skip numbers */
    }
    return out;
  },
};

/** /me/adaccounts → AD_ACCOUNT assets (active only). Returns [] on any failure. */
async function discoverAdAccounts(userToken: string): Promise<ConnectableAsset[]> {
  const r = await metaGraphFetch('/me/adaccounts', {
    accessToken: userToken,
    query: { fields: 'account_id,name,currency,account_status' },
    timeoutMs: 15000,
  });
  if (!r.ok) return [];
  const out: ConnectableAsset[] = [];
  for (const a of r.data?.data ?? []) {
    // account_status 1 = ACTIVE — skip disabled/closed accounts so the cron
    // doesn't hammer Meta for dead act_ ids.
    if (a?.account_status != null && Number(a.account_status) !== 1) continue;
    const accountId = String(a?.account_id ?? '');
    if (!accountId) continue;
    out.push({
      externalId: accountId,
      displayName: a?.name ? `${a.name} (Ads)` : `Ad account ${accountId}`,
      accountType: 'AD_ACCOUNT',
      token: userToken,
      meta: { accountId, currency: a?.currency ?? null },
    });
  }
  return out;
}

/** /me/businesses → WABAs → phone numbers → WHATSAPP_NUMBER assets. [] on failure. */
async function discoverWhatsApp(userToken: string): Promise<ConnectableAsset[]> {
  const out: ConnectableAsset[] = [];
  const bizRes = await metaGraphFetch('/me/businesses', {
    accessToken: userToken,
    query: { fields: 'id,name' },
    timeoutMs: 15000,
  });
  if (!bizRes.ok) return out;
  for (const biz of bizRes.data?.data ?? []) {
    const wabaRes = await metaGraphFetch(`/${biz.id}/owned_whatsapp_business_accounts`, {
      accessToken: userToken,
      query: { fields: 'id,name' },
      timeoutMs: 15000,
    });
    if (!wabaRes.ok) continue;
    for (const waba of wabaRes.data?.data ?? []) {
      const phRes = await metaGraphFetch(`/${waba.id}/phone_numbers`, {
        accessToken: userToken,
        query: { fields: 'id,display_phone_number,verified_name' },
        timeoutMs: 15000,
      });
      if (!phRes.ok) continue;
      for (const ph of phRes.data?.data ?? []) {
        const pid = String(ph?.id ?? '');
        if (!pid) continue;
        out.push({
          externalId: pid,
          displayName: ph?.verified_name
            ? `${ph.verified_name} (WhatsApp)`
            : (ph?.display_phone_number ?? `WhatsApp ${pid}`),
          accountType: 'WHATSAPP_NUMBER',
          token: userToken,
          meta: { phoneNumberId: pid, wabaId: waba.id, displayPhoneNumber: ph?.display_phone_number ?? null },
        });
      }
    }
  }
  return out;
}

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
