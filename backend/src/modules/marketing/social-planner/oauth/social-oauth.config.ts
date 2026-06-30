import {
  googleOAuthClientId,
  googleOAuthClientSecret,
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
  clientIdEnv: string;
  clientSecretEnv: string;
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
    scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'r_organization_admin'],
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
  // the Google app creds (dual env names handled below); access_type=offline +
  // prompt=consent are required to receive a refresh token.
  GMB: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    scopeSep: ' ',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export function isOAuthNetwork(n: string): n is Network {
  return (OAUTH_NETWORKS as string[]).includes(n);
}

export function clientId(n: Network): string | undefined {
  // GMB shares the Google OAuth app, which has two historical env names.
  if (n === 'GMB') return googleOAuthClientId();
  return process.env[NETWORK_OAUTH[n].clientIdEnv];
}

export function clientSecret(n: Network): string | undefined {
  if (n === 'GMB') return googleOAuthClientSecret();
  return process.env[NETWORK_OAUTH[n].clientSecretEnv];
}

export function isOAuthConfigured(n: Network): boolean {
  return !!(clientId(n) && clientSecret(n));
}

/** True when the network's authorize/token flow uses OAuth2 PKCE (S256). */
export function usesPkce(n: Network): boolean {
  return NETWORK_OAUTH[n].pkce === true;
}

/**
 * The provider redirect URI — must be registered verbatim in each provider's
 * app. Built from the PUBLIC backend origin (`PUBLIC_BASE_URL`, e.g.
 * https://marketing.hummytummy.com) plus the global `/api` prefix the backend
 * is served under — the same construction as the netgsm public callback.
 */
export function redirectUri(n: Network): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/social/oauth/${n.toLowerCase()}/callback`;
}
