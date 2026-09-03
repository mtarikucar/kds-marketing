/**
 * Connecting a mailbox WITHOUT asking for its password.
 *
 * Most people's mail is Gmail or Microsoft, and for those the honest connect
 * flow is OAuth: the owner consents in the provider's own window and no
 * password ever reaches this product. Custom SMTP stays for everyone else —
 * see `smtp-autodiscover.ts`, which fills in the server settings so that path
 * asks for an address and a password rather than five fields.
 *
 * ── THE DECISION THAT SHAPES THIS FILE ──────────────────────────────────────
 *
 * Google is sent through the Gmail HTTP API, NOT through SMTP, and that is not
 * a style preference — it is what keeps this feature free to operate.
 *
 * Gmail's SMTP server authenticates XOAUTH2 only against
 * `https://mail.google.com/`, which is a RESTRICTED scope: an app holding it
 * must pass an annual independent CASA Tier 2 assessment (a Google-approved
 * lab, roughly $540–1,000 a year, re-done every 12 months).
 *
 * `gmail.send` — send only, no read, no modify — is a SENSITIVE scope: Google
 * reviews it themselves, for free, and up to 100 accounts may use the app
 * before any review at all. But it works ONLY with the HTTP API; Gmail's SMTP
 * rejects it.
 *
 * So "just add XOAUTH2 to nodemailer", which is the shorter road and which
 * nodemailer supports out of the box, would have bought a permanent yearly
 * audit for a mailbox connection. Hence one send path per provider.
 *
 * Microsoft goes through Graph for a related reason: `Mail.Send` is a normal
 * delegated permission, while Microsoft has spent years switching SMTP AUTH
 * off by default in tenants.
 */

export const EMAIL_OAUTH_PROVIDERS = ['GOOGLE', 'MICROSOFT'] as const;
export type EmailOAuthProvider = (typeof EMAIL_OAUTH_PROVIDERS)[number];

export interface EmailOAuthProviderConfig {
  /** Shown on the connect button. */
  label: string;
  authUrl: string;
  tokenUrl: string;
  /**
   * Send-only, deliberately. A broader scope would read the customer's mail —
   * which this product has no use for and no business holding — and for Google
   * would also move the app onto the paid verification track.
   */
  scopes: readonly string[];
  /** Env names for the app registration the workspace owner creates. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra authorize params the provider needs to return a refresh token. */
  authParams: Readonly<Record<string, string>>;
}

export const EMAIL_OAUTH: Readonly<Record<EmailOAuthProvider, EmailOAuthProviderConfig>> = {
  GOOGLE: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // `gmail.send` alone. `userinfo.email` is what tells us WHICH mailbox was
    // connected — without it we would have to ask the owner to type the address
    // they just authenticated, and a typo there sends from the wrong account.
    scopes: ['https://www.googleapis.com/auth/gmail.send', 'openid', 'email'],
    clientIdEnv: 'GOOGLE_MAIL_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_MAIL_CLIENT_SECRET',
    // Google returns a refresh token ONLY on the first consent unless both of
    // these are sent; without them a reconnect yields an access token that
    // expires in an hour and a channel that dies overnight.
    authParams: { access_type: 'offline', prompt: 'consent' },
  },
  MICROSOFT: {
    label: 'Microsoft',
    // `common` accepts both work/school and personal accounts; a tenant-pinned
    // authority would refuse every customer outside our own tenant.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // `offline_access` is what mints the refresh token here — Microsoft has no
    // access_type parameter.
    scopes: ['https://graph.microsoft.com/Mail.Send', 'openid', 'email', 'offline_access'],
    clientIdEnv: 'MICROSOFT_MAIL_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_MAIL_CLIENT_SECRET',
    authParams: {},
  },
};

export function isEmailOAuthProvider(v: unknown): v is EmailOAuthProvider {
  return typeof v === 'string' && (EMAIL_OAUTH_PROVIDERS as readonly string[]).includes(v);
}

/** Whether an app registration exists for this provider. Absent = the connect
 *  button is not offered, rather than offered and failing at the redirect. */
export function isEmailOAuthConfigured(p: EmailOAuthProvider): boolean {
  const c = EMAIL_OAUTH[p];
  return !!process.env[c.clientIdEnv] && !!process.env[c.clientSecretEnv];
}

/** The providers a workspace can actually pick today. */
export function configuredEmailOAuthProviders(): EmailOAuthProvider[] {
  return EMAIL_OAUTH_PROVIDERS.filter(isEmailOAuthConfigured);
}
