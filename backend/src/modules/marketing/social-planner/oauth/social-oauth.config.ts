import {
  GOOGLE_CLIENT_ID_ENVS,
  GOOGLE_CLIENT_SECRET_ENVS,
  firstEnv,
} from '../../../../common/util/google-oauth-env';

export type Network =
  | 'FACEBOOK'
  | 'INSTAGRAM'
  | 'INSTAGRAM_LOGIN'
  | 'LINKEDIN'
  | 'TIKTOK'
  | 'TWITTER'
  | 'PINTEREST'
  | 'GMB';

export const OAUTH_NETWORKS: Network[] = [
  'FACEBOOK',
  'INSTAGRAM',
  'INSTAGRAM_LOGIN',
  'LINKEDIN',
  'TIKTOK',
  'TWITTER',
  'PINTEREST',
  'GMB',
];

interface OAuthDef {
  authorizeUrl: string;
  scopes: string[];
  /**
   * Env var(s) holding the client id — the FIRST one with a non-blank value
   * wins, so a list expresses "this app is configurable under either name".
   *
   * A list rather than a resolver callback, and a list rather than a
   * special-case inside the resolver: the table stays plain data (greppable,
   * printable in an operator-facing error, and true when read on its own).
   * Google is the only entry that needs one — its app has two historical env
   * names — and it takes them from google-oauth-env so the spelling and the
   * precedence live in exactly one place.
   */
  clientIdEnv: string | readonly string[];
  clientSecretEnv: string | readonly string[];
  /** Scope delimiter the provider's authorize endpoint expects. */
  scopeSep: string;
  /** OAuth2 PKCE (S256) — required by X/Twitter's confidential-client flow. */
  pkce?: boolean;
  /** Extra authorize-URL params (e.g. Google's access_type/prompt for a refresh token). */
  extraAuthParams?: Record<string, string>;
}

/**
 * Per-network OAuth definitions. Client id/secret come from env (shared
 * platform apps, one per network); a network is "configured" only when both
 * are present — the same gate the publish adapters use via isNetworkConfigured.
 */
export const NETWORK_OAUTH: Record<Network, OAuthDef> = {
  FACEBOOK: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    // Publishing + messaging-channel + ad-account onboarding in one consent.
    // Only sent on the classic flow; the FLB config (META_LOGIN_CONFIG_ID)
    // defines the grant when set. Messaging/WhatsApp/ads scopes need App Review,
    // so they stay inert (the connect path is env-gated) until approved.
    scopes: [
      'pages_show_list',
      'pages_manage_posts',
      'pages_read_engagement',
      'business_management',
      'pages_messaging',
      // Subscribe the Page to our messaging webhook (subscribed_apps) so inbound
      // Messenger/IG DMs are delivered — required by provisionMetaMessagingChannel.
      'pages_manage_metadata',
      // Instagram Direct: read the Page-linked IG account + receive/send IG DMs.
      // (IG messaging is delivered via the linked Page's subscription.)
      'instagram_basic',
      'instagram_manage_messages',
      'whatsapp_business_management',
      'whatsapp_business_messaging',
      'ads_read',
    ],
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
    scopeSep: ',',
  },
  INSTAGRAM: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    scopes: ['pages_show_list', 'instagram_basic', 'instagram_content_publish', 'business_management'],
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
    scopeSep: ',',
  },
  // "Instagram API with Instagram Login" — the DIRECT flow where the user logs
  // in at instagram.com (NOT via a Facebook Page). Distinct app credentials
  // (INSTAGRAM_APP_ID/SECRET) and host (graph.instagram.com). Comma-delimited
  // scopes; publishing needs instagram_business_content_publish.
  INSTAGRAM_LOGIN: {
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    clientIdEnv: 'INSTAGRAM_APP_ID',
    clientSecretEnv: 'INSTAGRAM_APP_SECRET',
    scopeSep: ',',
  },
  LINKEDIN: {
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    // openid/profile/w_member_social are self-serve; w_organization_social +
    // r_organization_social need Community Management API review (org assets stay
    // inert until granted). r_organization_admin was never a real LinkedIn scope.
    scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'r_organization_social'],
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
    scopeSep: ' ',
  },
  TIKTOK: {
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    scopes: ['user.info.basic', 'video.publish'],
    clientIdEnv: 'TIKTOK_CLIENT_KEY',
    clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
    scopeSep: ',',
  },
  // X/Twitter — OAuth2 Authorization Code WITH PKCE (S256), confidential client.
  // `offline.access` yields a refresh token; `media.write` enables image upload.
  TWITTER: {
    authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
    clientIdEnv: 'X_CLIENT_ID',
    clientSecretEnv: 'X_CLIENT_SECRET',
    scopeSep: ' ',
    pkce: true,
  },
  // Pinterest — OAuth2 (Basic-auth token exchange); each board is a publishable asset.
  PINTEREST: {
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    scopes: ['boards:read', 'pins:read', 'pins:write'],
    clientIdEnv: 'PINTEREST_APP_ID',
    clientSecretEnv: 'PINTEREST_APP_SECRET',
    scopeSep: ',',
  },
  // Google Business Profile — Google OAuth2 with the business.manage scope. Shares
  // the ONE Google app, which is configurable under either historical env name
  // (deploy.yml ships the OAUTH-prefixed pair); access_type=offline +
  // prompt=consent are required to receive a refresh token.
  GMB: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    clientIdEnv: GOOGLE_CLIENT_ID_ENVS,
    clientSecretEnv: GOOGLE_CLIENT_SECRET_ENVS,
    scopeSep: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export function isOAuthNetwork(n: string): n is Network {
  return (OAUTH_NETWORKS as string[]).includes(n);
}

/** The env names a network's credentials may be configured under, in order. */
export function credentialEnvNames(n: Network): { id: string[]; secret: string[] } {
  return {
    id: [NETWORK_OAUTH[n].clientIdEnv].flat(),
    secret: [NETWORK_OAUTH[n].clientSecretEnv].flat(),
  };
}

export function clientId(n: Network): string | undefined {
  return firstEnv(credentialEnvNames(n).id);
}

export function clientSecret(n: Network): string | undefined {
  return firstEnv(credentialEnvNames(n).secret);
}

export function isOAuthConfigured(n: Network): boolean {
  return !!(clientId(n) && clientSecret(n));
}

/** True when the network's authorize/token flow uses OAuth2 PKCE (S256). */
export function usesPkce(n: Network): boolean {
  return NETWORK_OAUTH[n].pkce === true;
}

const LINKEDIN_ORG_SCOPES = ['w_organization_social', 'r_organization_social'];

/**
 * The READ half of each grant — what `network-insights.ts` needs to see how a
 * published post actually did.
 *
 * Every one of these providers grants publishing and reading separately, and
 * the connect flows have only ever asked for publishing. So the organic
 * insights pipeline is, on a fresh install, permanently refused: a healthy,
 * actively-publishing account returns a permission error from every read, and
 * the panel says so rather than drawing a flat zero line. That is correct
 * behaviour for a grant nobody asked for — but it is not a state to stay in.
 *
 * They are listed here rather than in the definitions above, and gated, for the
 * same reason LinkedIn's org scopes are: asking for a permission the app has
 * not been approved for is not free. Meta shows the user a consent screen that
 * names it and then simply does not grant it (harmless, but it makes the dialog
 * ask for more than it can deliver); LinkedIn rejects the whole authorize
 * request; TikTok refuses an unregistered scope outright. Until each app's
 * review clears, the safe state is to keep asking for exactly what we can use.
 *
 * TO TURN ON, per provider, once its review has cleared:
 *   META_INSIGHTS_SCOPES=1     FACEBOOK read_insights · INSTAGRAM instagram_manage_insights
 *   IG_LOGIN_INSIGHTS_SCOPES=1 INSTAGRAM_LOGIN instagram_business_manage_insights
 *   LINKEDIN_ORG_SCOPES=1      r_organization_social (already gated below; org pages only)
 *   TIKTOK_INSIGHTS_SCOPES=1   video.list + user.info.stats
 * X already asks for what it needs (`tweet.read` + `users.read`).
 *
 * Existing connections are NOT upgraded by flipping a flag — a token carries
 * the scopes it was minted with, so an account connected before the flag has to
 * be reconnected before its insights become readable. The Account Center's
 * reconnect path is the same one it already offers.
 */
const INSIGHTS_SCOPES: Partial<Record<Network, { env: string; scopes: string[] }>> = {
  FACEBOOK: { env: 'META_INSIGHTS_SCOPES', scopes: ['read_insights'] },
  INSTAGRAM: { env: 'META_INSIGHTS_SCOPES', scopes: ['instagram_manage_insights'] },
  INSTAGRAM_LOGIN: {
    env: 'IG_LOGIN_INSIGHTS_SCOPES',
    scopes: ['instagram_business_manage_insights'],
  },
  TIKTOK: { env: 'TIKTOK_INSIGHTS_SCOPES', scopes: ['video.list', 'user.info.stats'] },
};

/**
 * Effective scopes for a network at request time. LinkedIn's org scopes belong
 * to the Community Management API, which LinkedIn only grants to a separate
 * single-product app after partner review — requesting them from the self-serve
 * app makes LinkedIn reject the ENTIRE authorize request. They stay off until
 * LINKEDIN_ORG_SCOPES is set (i.e. the configured app has CMA access).
 *
 * The insights scopes ride the same rule, one env flag per provider — see
 * INSIGHTS_SCOPES. Both filters are subtractive: the base list is what the app
 * can actually use today, and a flag only ever ADDS.
 */
export function scopesFor(n: Network): string[] {
  let scopes = NETWORK_OAUTH[n].scopes;
  if (n === 'LINKEDIN' && !process.env.LINKEDIN_ORG_SCOPES) {
    scopes = scopes.filter((s) => !LINKEDIN_ORG_SCOPES.includes(s));
  }
  const insights = INSIGHTS_SCOPES[n];
  if (insights && process.env[insights.env]) {
    // De-duplicated: a provider that later folds one of these into its base
    // grant must not make us send it twice.
    scopes = [...new Set([...scopes, ...insights.scopes])];
  }
  return scopes;
}

/** The insights scopes a network would gain, for the connect UI to explain. */
export function insightsScopesFor(n: Network): { scopes: string[]; enabled: boolean } {
  const cfg = INSIGHTS_SCOPES[n];
  if (!cfg) return { scopes: [], enabled: n === 'TWITTER' };
  return { scopes: cfg.scopes, enabled: !!process.env[cfg.env] };
}

/**
 * The provider redirect URI — must be registered verbatim in each provider's
 * app. Built from the PUBLIC backend origin (`PUBLIC_BASE_URL`, e.g.
 * https://jeetagrowth.com) plus the global `/api` prefix the backend
 * is served under — the same construction as the netgsm public callback.
 */
export function redirectUri(n: Network): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/social/oauth/${n.toLowerCase()}/callback`;
}
