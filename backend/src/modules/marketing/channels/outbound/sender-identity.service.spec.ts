import { SenderIdentityService } from './sender-identity.service';

/**
 * WHO the mail is from — one answer, for every class of mail.
 *
 * The answer used to be re-derived at each call site, and each one got a
 * different part of it wrong. Platform-fallback mail left as plain
 * "Jeeta" <admin@jeetagrowth.com> with no Reply-To, so a customer answering a
 * quote reached the operator's inbox and never the tenant
 * (`platform-fallback-no-reply-to`). Tenant copy went out under the platform's
 * own name with nothing saying who wrote it (`tenant-content-platform`). A
 * consent-connected mailbox was offered first and then excluded from every send
 * (`oauth-send-only`).
 *
 * The one thing that must NOT move is the From ADDRESS on the platform
 * transport: jeetagrowth.com is DMARC `p=reject` with SPF `-all` and no tenant
 * DKIM key, so a From-swap fails alignment and loses the mail outright. Only
 * the display name and the Reply-To may change.
 */
describe('SenderIdentityService', () => {
  const WS = 'ws-1';
  const PLATFORM_FROM = 'no-reply@jeetagrowth.com';

  const ENV: Record<string, string> = {
    EMAIL_FROM: PLATFORM_FROM,
    EMAIL_FROM_NAME: 'Jeeta',
    APP_NAME: 'Jeeta',
  };

  const SMTP_CONFIG = {
    channelId: 'ch-smtp',
    workspaceId: WS,
    type: 'EMAIL',
    externalId: 'admin@acme.test',
    secrets: { smtpHost: 'h', smtpUser: 'admin@acme.test', smtpPass: 'x', fromEmail: 'admin@acme.test' },
    public: {},
  };

  const CONSENT_CANDIDATE = {
    channelId: 'ch-oauth',
    config: {
      channelId: 'ch-oauth',
      workspaceId: WS,
      type: 'EMAIL',
      externalId: 'owner@acme.test',
      secrets: { oauthProvider: 'GOOGLE', oauthAccessToken: 't', fromEmail: 'owner@acme.test' },
      public: {},
    },
    kind: 'CONSENT' as const,
    verified: false,
    usable: true,
    needsReauth: false,
    canReceive: false,
    address: 'owner@acme.test',
  };

  let prisma: any;
  let mailbox: any;
  let sendingDomains: any;
  let svc: SenderIdentityService;

  function build(
    over: {
      workspace?: any;
      brand?: any;
      owner?: any;
      smtp?: any;
      candidates?: any[];
      from?: any;
    } = {},
  ) {
    prisma = {
      workspace: {
        findUnique: jest
          .fn()
          .mockResolvedValue(over.workspace === undefined ? { name: 'Acme', settings: null } : over.workspace),
      },
      brandProfile: { findUnique: jest.fn().mockResolvedValue(over.brand ?? null) },
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue(over.owner ?? null) },
    };
    mailbox = {
      resolve: jest.fn().mockResolvedValue(over.smtp ?? null),
      candidates: jest.fn().mockResolvedValue(over.candidates ?? []),
    };
    sendingDomains = { resolveFrom: jest.fn().mockResolvedValue(over.from ?? null) };
    svc = new SenderIdentityService(prisma, mailbox, sendingDomains, {
      get: (k: string) => ENV[k],
    } as any);
  }

  describe('AUTH and INTERNAL', () => {
    it('keeps the platform identity and never carries a tenant Reply-To', async () => {
      // A tenant Reply-To on a password reset is the phishing shape itself, and
      // "Acme via Jeeta" on a login code relabels OUR security mail as theirs.
      build({ smtp: SMTP_CONFIG, owner: { user: { email: 'owner@acme.test' } } });
      await expect(svc.resolve(WS, 'AUTH')).resolves.toEqual({
        transport: 'PLATFORM',
        fromEmail: PLATFORM_FROM,
        fromName: 'Jeeta',
      });
    });

    it('does not even look the workspace up', async () => {
      // Account recovery must not depend on a tenant read succeeding.
      build({ smtp: SMTP_CONFIG });
      await svc.resolve(WS, 'INTERNAL');
      expect(mailbox.resolve).not.toHaveBeenCalled();
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });

    it('is never degraded — there is nothing for the tenant to fix', async () => {
      build();
      const id = await svc.resolve(WS, 'AUTH');
      expect(id.degraded).toBeUndefined();
    });
  });

  describe('the mailbox rungs', () => {
    it('sends as the workspace when it has a verified SMTP mailbox', async () => {
      build({ smtp: SMTP_CONFIG });
      await expect(svc.resolve(WS, 'TRANSACTIONAL')).resolves.toMatchObject({
        transport: 'MAILBOX_SMTP',
        fromEmail: 'admin@acme.test',
        fromName: 'Acme',
        config: SMTP_CONFIG,
      });
    });

    it('carries the brand name as the display name, with no "via" on the tenant’s own transport', async () => {
      build({ smtp: SMTP_CONFIG, brand: { brandName: 'Acme Kombi' } });
      const id = await svc.resolve(WS, 'TRANSACTIONAL');
      expect(id.fromName).toBe('Acme Kombi');
      expect(id.replyTo).toBeUndefined();
    });

    it('uses a consent mailbox for non-bulk mail, and says it cannot receive', async () => {
      build({ candidates: [CONSENT_CANDIDATE] });
      await expect(svc.resolve(WS, 'TRANSACTIONAL')).resolves.toMatchObject({
        transport: 'MAILBOX_OAUTH',
        fromEmail: 'owner@acme.test',
        degraded: { code: 'MAILBOX_SEND_ONLY', fix: 'ADD_IMAP' },
      });
    });

    it('never picks a consent mailbox for BULK', async () => {
      // The OAuth branch of the adapter carries neither HTML nor
      // List-Unsubscribe, and RFC 8058 headers are fail-closed on bulk.
      build({ candidates: [CONSENT_CANDIDATE] });
      const id = await svc.resolve(WS, 'BULK');
      expect(id.transport).toBe('PLATFORM');
      expect(id.fromEmail).toBe(PLATFORM_FROM);
    });

    it('falls through to the platform when the consent token needs the owner back', async () => {
      build({
        candidates: [{ ...CONSENT_CANDIDATE, usable: false, needsReauth: true }],
        owner: { user: { email: 'owner@acme.test' } },
      });
      await expect(svc.resolve(WS, 'TRANSACTIONAL')).resolves.toMatchObject({
        transport: 'PLATFORM',
        degraded: { code: 'OAUTH_REAUTH', fix: 'RECONNECT_MAILBOX' },
      });
    });

    it('asks for a verify, not a reconnect, when an SMTP mailbox was never proven', async () => {
      build({
        candidates: [
          {
            ...CONSENT_CANDIDATE,
            channelId: 'ch-smtp',
            kind: 'SMTP',
            usable: true,
            canReceive: true,
            address: 'admin@acme.test',
          },
        ],
      });
      await expect(svc.resolve(WS, 'TRANSACTIONAL')).resolves.toMatchObject({
        transport: 'PLATFORM',
        degraded: { code: 'MAILBOX_UNVERIFIED', fix: 'VERIFY_MAILBOX' },
      });
    });

    it('keeps HTML off the consent transport while that transport is text-only', async () => {
      build({ candidates: [CONSENT_CANDIDATE] });
      (svc as any).consentCarriesHtml = () => false;
      await expect(svc.resolve(WS, 'TRANSACTIONAL', { html: true })).resolves.toMatchObject({
        transport: 'PLATFORM',
        degraded: { code: 'HTML_ON_CONSENT', fix: 'CONNECT_MAILBOX' },
      });
    });
  });

  describe('the verified sending domain', () => {
    const FROM = {
      email: 'noreply@acme.com',
      name: 'Acme',
      dkim: { domainName: 'acme.com', keySelector: 'jeeta1', privateKey: 'PEM' },
    };

    it('sends from the tenant domain WITH its aligned DKIM key', async () => {
      build({ from: FROM, owner: { user: { email: 'owner@acme.test' } } });
      await expect(svc.resolve(WS, 'BULK')).resolves.toMatchObject({
        transport: 'PLATFORM',
        fromEmail: 'noreply@acme.com',
        dkim: FROM.dkim,
        replyTo: 'owner@acme.test',
      });
    });

    it('is not consulted for conversational mail', async () => {
      // A thread-bound reply goes out through the mailbox transport; a
      // sending-domain From on one would not match the thread it answers.
      build({ from: FROM });
      const id = await svc.resolve(WS, 'CONVERSATIONAL');
      expect(sendingDomains.resolveFrom).not.toHaveBeenCalled();
      expect(id.fromEmail).toBe(PLATFORM_FROM);
    });
  });

  describe('the platform fallback', () => {
    it('degrades — it never refuses — when the workspace has no mailbox at all', async () => {
      build({ owner: { user: { email: 'owner@acme.test' } } });
      await expect(svc.resolve(WS, 'BULK')).resolves.toEqual({
        transport: 'PLATFORM',
        fromEmail: PLATFORM_FROM,
        fromName: 'Acme via Jeeta',
        replyTo: 'owner@acme.test',
        degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
      });
    });

    it('keeps the platform From ADDRESS unchanged whatever the tenant is called', async () => {
      // jeetagrowth.com is DMARC p=reject with SPF -all and no tenant DKIM key.
      // A From-swap here does not look nicer, it loses the mail.
      build({ workspace: { name: 'Acme', settings: { emailFromName: 'Acme Kombi' } } });
      const id = await svc.resolve(WS, 'TRANSACTIONAL');
      expect(id.fromEmail).toBe(PLATFORM_FROM);
      expect(id.fromName).toBe('Acme Kombi via Jeeta');
    });

    it('still names the tenant when it has no mailbox and no reply address', async () => {
      build();
      const id = await svc.resolve(WS, 'TRANSACTIONAL');
      expect(id.replyTo).toBeUndefined();
      expect(id.fromName).toBe('Acme via Jeeta');
      expect(id.degraded?.code).toBe('NO_MAILBOX');
    });
  });

  describe('replyIdentity', () => {
    it('prefers the workspace’s own mailbox address — a consent one counts', async () => {
      // Reply-To needs an ADDRESS, not the ability to send: a mailbox that can
      // only send is still where the tenant reads its replies.
      build({
        candidates: [CONSENT_CANDIDATE],
        workspace: { name: 'Acme', settings: { replyTo: 'settings@acme.test' } },
        owner: { user: { email: 'owner@acme.test' } },
      });
      await expect(svc.replyIdentity(WS)).resolves.toEqual({
        replyTo: 'owner@acme.test',
        name: 'Acme',
      });
    });

    it('falls to the configured reply address, then to the OWNER', async () => {
      build({
        workspace: { name: 'Acme', settings: { replyTo: 'settings@acme.test' } },
        owner: { user: { email: 'owner@acme.test' } },
      });
      await expect(svc.replyIdentity(WS)).resolves.toMatchObject({ replyTo: 'settings@acme.test' });

      build({ owner: { user: { email: 'owner@acme.test' } } });
      await expect(svc.replyIdentity(WS)).resolves.toMatchObject({ replyTo: 'owner@acme.test' });
    });

    it('resolves the OWNER through the membership, never MarketingUser.workspaceId', async () => {
      // `MarketingUser.workspaceId` is the user's HOME workspace. An owner whose
      // home is elsewhere owns this one just as much, and reading the pointer
      // would silently drop them.
      build({ owner: { user: { email: 'owner@acme.test' } } });
      await svc.replyIdentity(WS);
      expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, role: 'OWNER', status: 'ACTIVE' }),
        }),
      );
    });

    it('answers with no reply address rather than failing', async () => {
      build();
      await expect(svc.replyIdentity(WS)).resolves.toEqual({ name: 'Acme' });
    });

    it('is cached per workspace, so a campaign does not re-ask per recipient', async () => {
      build({ owner: { user: { email: 'owner@acme.test' } } });
      await svc.replyIdentity(WS);
      await svc.replyIdentity(WS);
      expect(prisma.workspace.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
