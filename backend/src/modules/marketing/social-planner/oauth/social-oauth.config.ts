export type Network = 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'TIKTOK';

export const OAUTH_NETWORKS: Network[] = ['FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'TIKTOK'];

interface OAuthDef {
  authorizeUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Scope delimiter the provider's authorize endpoint expects. */
  scopeSep: string;
}

/**
 * Per-network OAuth definitions. Client id/secret come from env (shared
 * platform apps, one per network); a network is "configured" only when both
 * are present — the same gate the publish adapters use via isNetworkConfigured.
 */
export const NETWORK_OAUTH: Record<Network, OAuthDef> = {
  FACEBOOK: {
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management'],
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
};

export function isOAuthNetwork(n: string): n is Network {
  return (OAUTH_NETWORKS as string[]).includes(n);
}

export function clientId(n: Network): string | undefined {
  return process.env[NETWORK_OAUTH[n].clientIdEnv];
}

export function clientSecret(n: Network): string | undefined {
  return process.env[NETWORK_OAUTH[n].clientSecretEnv];
}

export function isOAuthConfigured(n: Network): boolean {
  return !!(clientId(n) && clientSecret(n));
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
