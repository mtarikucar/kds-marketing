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
   *
   * A scope here is a contract with `email-oauth.sender.ts`: whatever endpoint
   * that file calls for this provider must be covered by this list, or connect
   * fails for every user and only at the provider. `email-oauth.config.spec.ts`
   * pins the pairs, because nothing at runtime can.
   */
  scopes: readonly string[];
  /**
   * What the consent gives us on the INBOUND side — 'NONE' for both providers,
   * and the dialog has to SAY so. A mailbox that sends but never receives is
   * the most confusing outcome of this flow, and the owner should learn it at
   * connect time rather than when the first reply fails to arrive. Replies for
   * a consent mailbox come from an IMAP app password sealed beside the token
   * (see `imap-target.ts`), not from a wider consent.
   */
  receive: 'NONE';
  /** Machine code for that fact; the words are the frontend's (i18n). */
  receiveReason: 'GMAIL_READ_NEEDS_CASA' | 'GRAPH_MAIL_READ_NOT_REQUESTED';
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
    // Reading a Gmail inbox needs `gmail.readonly` (or `https://mail.google.com/`),
    // and both are RESTRICTED — the annual CASA Tier 2 assessment described at
    // the top of this file. So Gmail consent is send-only, permanently as far
    // as this product is concerned, and the connect dialog says it out loud.
    receive: 'NONE',
    receiveReason: 'GMAIL_READ_NEEDS_CASA',
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
    //
    // `User.Read` is NOT scope creep, and the next reader should not delete it:
    // the callback learns which mailbox consented from Graph's `/v1.0/me`
    // (`email-oauth.sender.ts`), and Graph refuses `/me` with 403 unless this
    // scope was granted. Without it EVERY Microsoft connect ends in "Could not
    // read the address of the connected mailbox". It reads the directory
    // profile — display name, UPN, mail — and never a message, so the
    // send-only principle above still holds.
    //
    // `https://graph.microsoft.com/Mail.Read` is the scope that would make a
    // Microsoft mailbox two-way. It is deliberately NOT requested yet: inbound
    // over Graph is a separate piece of work, and asking for mail-read consent
    // before anything reads mail is consent we would not be using.
    scopes: [
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
      'openid',
      'email',
      'offline_access',
    ],
    receive: 'NONE',
    receiveReason: 'GRAPH_MAIL_READ_NOT_REQUESTED',
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

/**
 * ONE callback address for both providers — the provider is carried in the
 * signed state, not in the path. The owner registers this exact string in their
 * own Google Cloud / Azure app, and a redirect URI that differed per provider
 * would be one more thing to get wrong for no gain.
 */
export function emailOAuthRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/channels/email/oauth/callback`;
}

export function buildEmailAuthorizeUrl(provider: EmailOAuthProvider, state: string): string {
  const c = EMAIL_OAUTH[provider];
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env[c.clientIdEnv] ?? '',
    redirect_uri: emailOAuthRedirectUri(),
    scope: c.scopes.join(' '),
    state,
    ...c.authParams,
  });
  return `${c.authUrl}?${params.toString()}`;
}

/** The signed-state `network` tag for a provider, so an email state can never
 *  be replayed against the social-connect callback (or the reverse). */
export function emailStateNetwork(provider: EmailOAuthProvider): string {
  return `email-${provider.toLowerCase()}`;
}
