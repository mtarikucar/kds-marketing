import {
  EMAIL_OAUTH,
  EMAIL_OAUTH_PROVIDERS,
  buildEmailAuthorizeUrl,
  emailStateNetwork,
} from './email-oauth.config';

/**
 * The scopes are a contract with code that lives elsewhere: the connect flow
 * asks the provider for exactly these, and `email-oauth.sender.ts` then calls
 * endpoints that only work if the right one was granted. Nothing at runtime
 * cross-checks the two, and the consequence of a mismatch is not a degraded
 * feature — it is "Connection failed" for every user of that provider, on a
 * path that cannot be exercised until an operator registers an app.
 */
describe('mail consent scopes', () => {
  describe('Microsoft', () => {
    it('asks for User.Read, which Graph /me requires', () => {
      // `fetchConnectedAddress` reads the connected address from
      // https://graph.microsoft.com/v1.0/me. Without User.Read that call is a
      // 403 for every M365 account, `handleCallback` throws "Could not read the
      // address", and Microsoft connect fails 100% of the time.
      expect(EMAIL_OAUTH.MICROSOFT.scopes).toContain('https://graph.microsoft.com/User.Read');
    });

    it('still asks for nothing that reads mail', () => {
      // User.Read is the directory profile, not the mailbox. Mail.Read is
      // deliberately absent until the inbound half of consent is built.
      expect(EMAIL_OAUTH.MICROSOFT.scopes).not.toContain('https://graph.microsoft.com/Mail.Read');
      expect(EMAIL_OAUTH.MICROSOFT.scopes).toContain('https://graph.microsoft.com/Mail.Send');
    });

    it('carries the scope into the authorize URL it builds', () => {
      process.env.MICROSOFT_MAIL_CLIENT_ID = 'client';
      process.env.PUBLIC_BASE_URL = 'https://app.example.com';
      const url = new URL(buildEmailAuthorizeUrl('MICROSOFT', 'st'));
      expect(url.searchParams.get('scope')).toContain('User.Read');
      delete process.env.MICROSOFT_MAIL_CLIENT_ID;
    });
  });

  describe('Google', () => {
    it('stays send-only: no Gmail read scope is requested', () => {
      // `gmail.readonly` and `https://mail.google.com/` are RESTRICTED scopes —
      // holding either buys an annual CASA Tier 2 assessment. Inbound for a
      // consent mailbox is an IMAP app password, not a wider consent.
      expect(EMAIL_OAUTH.GOOGLE.scopes).toEqual(['https://www.googleapis.com/auth/gmail.send', 'openid', 'email']);
    });
  });

  describe('what the connect dialog must tell the owner', () => {
    it('declares that consent does not bring replies, per provider, with a reason', () => {
      // A mailbox that sends but never receives is the single most confusing
      // outcome of this flow. The config carries the fact and the WHY so the UI
      // can say it at connect time instead of leaving the owner to discover it
      // when the first reply never arrives.
      for (const p of EMAIL_OAUTH_PROVIDERS) {
        expect(EMAIL_OAUTH[p].receive).toBe('NONE');
        expect(EMAIL_OAUTH[p].receiveReason).toBeTruthy();
      }
      expect(EMAIL_OAUTH.GOOGLE.receiveReason).toBe('GMAIL_READ_NEEDS_CASA');
      expect(EMAIL_OAUTH.MICROSOFT.receiveReason).toBe('GRAPH_MAIL_READ_NOT_REQUESTED');
    });
  });

  describe('state network tags', () => {
    it('keeps an email state out of the social callback', () => {
      expect(emailStateNetwork('GOOGLE')).toBe('email-google');
      expect(emailStateNetwork('MICROSOFT')).toBe('email-microsoft');
    });
  });
});
