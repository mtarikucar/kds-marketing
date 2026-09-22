import { WorkspaceMailboxService } from './workspace-mailbox.service';

/**
 * WHICH mailbox is allowed to send as the workspace.
 *
 * This logic used to live inside the campaign sender, privately. The workflow
 * engine needed the same answer, did not have it, and kept sending on the
 * platform transport — so a workspace's campaigns left from its own address
 * while its automations left from ours. These tests belong to the shared owner
 * so the next caller inherits the decision instead of re-making it.
 */
describe('WorkspaceMailboxService', () => {
  const WS = 'ws-1';
  const SMTP = { smtpHost: 'smtpout.secureserver.net', smtpUser: 'admin@own.com', smtpPass: 'x' };

  let prisma: any;
  let registry: any;
  let send: jest.Mock;
  let svc: WorkspaceMailboxService;

  function build(channel: any, secrets: Record<string, unknown> = SMTP) {
    prisma = { channel: { findMany: jest.fn().mockResolvedValue(channel ? [channel] : []) } };
    send = jest.fn().mockResolvedValue({ externalMessageId: 'm1', status: 'SENT' });
    registry = {
      get: jest.fn().mockReturnValue({ send }),
      resolveConfig: jest.fn().mockReturnValue({ secrets, public: {} }),
    };
    svc = new WorkspaceMailboxService(prisma, registry);
  }

  const CH = { id: 'ch-1', type: 'EMAIL' };

  it('asks only for a mailbox that has PASSED a health check', async () => {
    // ChannelsService.verify writes lastVerifiedAt ONLY on health.ok, so this
    // query is what separates "a mailbox is configured" from "a mailbox has
    // ever worked". Sending through credentials nobody proved is how you get a
    // run of 535s with the send already recorded.
    build(CH);
    await svc.resolve(WS);
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: WS,
        type: 'EMAIL',
        status: 'ACTIVE',
        lastVerifiedAt: { not: null },
      },
      // Freshest proven login first, so the choice is deterministic rather than
      // whatever order the rows happen to come back in.
      orderBy: { lastVerifiedAt: 'desc' },
    });
  });

  it('resolves a verified SMTP mailbox', async () => {
    build(CH);
    await expect(svc.resolve(WS)).resolves.toMatchObject({ secrets: SMTP });
  });

  it('returns null when the workspace has no verified mailbox', async () => {
    build(null);
    await expect(svc.resolve(WS)).resolves.toBeNull();
  });

  it('returns null for a consent-connected (OAuth) mailbox', async () => {
    // email-oauth.sender.ts pins Microsoft to contentType:'Text' and builds
    // Gmail's RFC822 with no HTML part, so routing rich mail there would
    // silently drop the HTML body. Plain text from the right address is worse
    // than formatted from the platform's.
    build(CH, { oauthProvider: 'GOOGLE', oauthAccessToken: 't', fromEmail: 'a@b.com' });
    await expect(svc.resolve(WS)).resolves.toBeNull();
  });

  it('returns null when the SMTP credentials are incomplete', async () => {
    build(CH, { smtpHost: 'h' });
    await expect(svc.resolve(WS)).resolves.toBeNull();
  });

  it('picks the usable SMTP mailbox even when an OAuth one is stored first', async () => {
    // `Channel` carries no unique on (workspaceId, type) — only
    // @@unique([type, externalId]) — so one workspace can legitimately hold a
    // consent-connected mailbox AND an SMTP one. An unordered findFirst that
    // inspects whichever row Postgres hands back first, and gives up on it,
    // sends the ENTIRE workspace's mail from the platform address while its own
    // verified mailbox sits one row away. Which mailbox wins must not depend on
    // physical row order.
    const oauth = { id: 'ch-oauth', type: 'EMAIL' };
    const smtp = { id: 'ch-smtp', type: 'EMAIL' };
    prisma = {
      channel: { findMany: jest.fn().mockResolvedValue([oauth, smtp]) },
    };
    registry = {
      get: jest.fn(),
      resolveConfig: jest.fn((ch: any) =>
        ch.id === 'ch-oauth'
          ? { secrets: { oauthProvider: 'GOOGLE', oauthAccessToken: 't' }, public: {} }
          : { secrets: SMTP, public: {} },
      ),
    };
    svc = new WorkspaceMailboxService(prisma, registry);

    await expect(svc.resolve(WS)).resolves.toMatchObject({ secrets: SMTP });
  });

  describe('send', () => {
    it('goes through the channel adapter and reports the provider message id', async () => {
      build(CH);
      const r = await svc.send({ workspaceId: WS, to: 'x@y.z', subject: 'S', text: 'b' });
      expect(r).toEqual({ ok: true, messageId: 'm1', error: undefined });
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'x@y.z', subject: 'S', text: 'b' }),
      );
    });

    it('passes html ALONGSIDE text, never instead of it', async () => {
      // Multipart is what clients and spam filters expect, and an HTML-only
      // mail from a new sending identity is a reputation problem by itself.
      build(CH);
      await svc.send({ workspaceId: WS, to: 'x@y.z', subject: 'S', text: 'plain', html: '<p>r</p>' });
      expect(send.mock.calls[0][0]).toMatchObject({ text: 'plain', html: '<p>r</p>' });
    });

    it('returns null — not a failure — when there is no mailbox, so callers fall back', async () => {
      build(null);
      await expect(
        svc.send({ workspaceId: WS, to: 'x@y.z', subject: 'S', text: 'b' }),
      ).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });

    it('reports the provider’s own refusal rather than a generic string', async () => {
      build(CH);
      send.mockResolvedValue({
        externalMessageId: null,
        status: 'FAILED',
        error: '535 Authentication Failed',
      });
      const r = await svc.send({ workspaceId: WS, to: 'x@y.z', subject: 'S', text: 'b' });
      expect(r).toMatchObject({ ok: false, error: '535 Authentication Failed' });
    });
  });

  /**
   * A mailbox connected by CONSENT is opt-in, never a default.
   *
   * `oauth-send-only`: the OAuth transport is offered first in the UI and then
   * excluded from every send, so a Google Workspace owner who connects by
   * consent still watches invoices leave from the platform address. Widening
   * `resolve()` in place would be worse — the campaign sender calls it and MUST
   * keep excluding consent mailboxes until the adapter can carry
   * `List-Unsubscribe`. So the widening is a second argument, and bulk simply
   * never passes it.
   */
  describe('resolve(…, { allowConsent })', () => {
    const CONSENT = {
      oauthProvider: 'GOOGLE',
      oauthAccessToken: 'tok',
      oauthRefreshToken: 'ref',
      oauthExpiresAt: String(Date.now() + 3_600_000),
      fromEmail: 'owner@acme.test',
    };

    /** Two channels behind one mock, answering both of resolve()'s queries. */
    function buildPair(rows: any[], secretsById: Record<string, Record<string, unknown>>) {
      prisma = {
        channel: {
          findMany: jest.fn(async ({ where }: any) =>
            where.lastVerifiedAt ? rows.filter((r) => r.lastVerifiedAt) : rows,
          ),
        },
      };
      send = jest.fn().mockResolvedValue({ externalMessageId: 'm1', status: 'SENT' });
      registry = {
        get: jest.fn().mockReturnValue({ send }),
        resolveConfig: jest.fn((ch: any) => ({
          channelId: ch.id,
          secrets: secretsById[ch.id],
          public: {},
        })),
      };
      svc = new WorkspaceMailboxService(prisma, registry);
    }

    const oauthRow = { id: 'ch-oauth', type: 'EMAIL', lastVerifiedAt: null, createdAt: new Date(1) };
    const smtpRow = { id: 'ch-smtp', type: 'EMAIL', lastVerifiedAt: new Date(2), createdAt: new Date(2) };

    it('still refuses a consent mailbox when no options are passed', async () => {
      buildPair([oauthRow], { 'ch-oauth': CONSENT });
      await expect(svc.resolve(WS)).resolves.toBeNull();
    });

    it('hands back a consent mailbox when the caller opted in', async () => {
      buildPair([oauthRow], { 'ch-oauth': CONSENT });
      await expect(svc.resolve(WS, { allowConsent: true })).resolves.toMatchObject({
        channelId: 'ch-oauth',
      });
    });

    it('prefers a verified SMTP mailbox over a consent one even when opted in', async () => {
      // Consent is the fallback, not a promotion: the SMTP mailbox is the one
      // whose login has actually been accepted, and it can carry HTML.
      buildPair([oauthRow, smtpRow], { 'ch-oauth': CONSENT, 'ch-smtp': SMTP });
      await expect(svc.resolve(WS, { allowConsent: true })).resolves.toMatchObject({
        channelId: 'ch-smtp',
      });
    });

    it('does not hand back a consent mailbox whose token has expired', async () => {
      // The adapter would refuse the send outright. Falling through to the
      // platform transport puts the mail in front of the customer instead.
      buildPair([oauthRow], {
        'ch-oauth': { ...CONSENT, oauthExpiresAt: String(Date.now() - 1_000) },
      });
      await expect(svc.resolve(WS, { allowConsent: true })).resolves.toBeNull();
    });

    it('does not hand back a consent mailbox the provider has already refused', async () => {
      buildPair([oauthRow], { 'ch-oauth': { ...CONSENT, oauthError: 'invalid_grant' } });
      await expect(svc.resolve(WS, { allowConsent: true })).resolves.toBeNull();
    });

    it('send() opts in for an HTML mail too, now that the transport carries one', async () => {
      // It used to stay out: the OAuth branch of email.adapter.ts forwarded
      // {from,to,subject,text} and dropped the HTML on the floor. That branch
      // now builds a real multipart/alternative, so the trade this opt-in used
      // to make — the platform address over a stripped body — has no reason
      // left. `listUnsubscribeUrl` is still not carried, which is why BULK is
      // kept off this transport by SenderIdentityService rather than here.
      buildPair([oauthRow], { 'ch-oauth': CONSENT });
      await svc.send({ workspaceId: WS, to: 'x@y.z', subject: 'S', text: 'b' });
      expect(send).toHaveBeenCalled();

      buildPair([oauthRow], { 'ch-oauth': CONSENT });
      const r = await svc.send({
        workspaceId: WS,
        to: 'x@y.z',
        subject: 'S',
        text: 'b',
        html: '<p>r</p>',
      });
      expect(r).not.toBeNull();
      expect(send.mock.calls[0][0]).toMatchObject({ text: 'b', html: '<p>r</p>' });
    });
  });

  /**
   * Merit selection, in ONE place.
   *
   * `distribution-oldest-channel`: content distribution pinned every draft to
   * the oldest ACTIVE channel (`orderBy: { createdAt: 'asc' }`), so a workspace
   * whose first mailbox died sent every outreach through it while a working one
   * sat next to it. The rule — proven first, then freshest — belongs to the
   * owner of "which mailbox is allowed to send", not to each caller.
   */
  describe('candidates / bestChannelIds', () => {
    const rows = [
      { id: 'old-verified', type: 'EMAIL', lastVerifiedAt: new Date('2026-01-01'), createdAt: new Date('2020-01-01') },
      { id: 'new-unverified', type: 'EMAIL', lastVerifiedAt: null, createdAt: new Date('2026-09-01') },
      { id: 'newest-verified', type: 'EMAIL', lastVerifiedAt: new Date('2026-06-01'), createdAt: new Date('2021-01-01') },
    ];

    function buildAll(all: any[], secretsById: Record<string, Record<string, unknown>> = {}) {
      prisma = { channel: { findMany: jest.fn().mockResolvedValue(all) } };
      registry = {
        get: jest.fn(),
        resolveConfig: jest.fn((ch: any) => ({
          channelId: ch.id,
          secrets: secretsById[ch.id] ?? SMTP,
          public: {},
        })),
      };
      svc = new WorkspaceMailboxService(prisma, registry);
    }

    it('orders proven mailboxes first, then the freshest proof', async () => {
      buildAll(rows);
      const got = await svc.candidates(WS);
      expect(got.map((c) => c.channelId)).toEqual([
        'newest-verified',
        'old-verified',
        'new-unverified',
      ]);
    });

    it('scopes the read to the workspace', async () => {
      buildAll(rows);
      await svc.candidates(WS);
      expect(prisma.channel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, type: 'EMAIL', status: 'ACTIVE' }),
        }),
      );
    });

    it('says which mailbox is a consent one and whether it can receive', async () => {
      buildAll([rows[0], rows[1]], {
        'old-verified': SMTP,
        'new-unverified': {
          oauthProvider: 'GOOGLE',
          oauthAccessToken: 'tok',
          oauthRefreshToken: 'ref',
          oauthExpiresAt: String(Date.now() + 3_600_000),
          fromEmail: 'owner@acme.test',
        },
      });
      const got = await svc.candidates(WS);
      expect(got.find((c) => c.channelId === 'old-verified')).toMatchObject({
        kind: 'SMTP',
        verified: true,
        usable: true,
        canReceive: true,
        address: 'admin@own.com',
      });
      expect(got.find((c) => c.channelId === 'new-unverified')).toMatchObject({
        kind: 'CONSENT',
        verified: false,
        usable: true,
        canReceive: false,
        address: 'owner@acme.test',
      });
    });

    it('picks the best channel PER TYPE and never crosses types', async () => {
      // Merit ordering must not quietly move outreach from free email onto
      // paid, İYS-governed SMS the first time somebody verifies an SMS channel.
      buildAll([
        { id: 'sms-verified', type: 'SMS', lastVerifiedAt: new Date('2026-09-01'), createdAt: new Date('2026-09-01') },
        { id: 'email-old', type: 'EMAIL', lastVerifiedAt: null, createdAt: new Date('2020-01-01') },
        { id: 'email-verified', type: 'EMAIL', lastVerifiedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
      ]);
      const best = await svc.bestChannelIds(WS, ['EMAIL', 'SMS']);
      expect(best.get('EMAIL')?.id).toBe('email-verified');
      expect(best.get('SMS')?.id).toBe('sms-verified');
    });

    it('falls back to the newest ACTIVE channel when none was ever verified', async () => {
      // Verify is a manual button and the consent connect path never stamps it,
      // so a hard "verified only" filter would silently zero out outreach for a
      // workspace whose mailbox works.
      buildAll([
        { id: 'a', type: 'EMAIL', lastVerifiedAt: null, createdAt: new Date('2020-01-01') },
        { id: 'b', type: 'EMAIL', lastVerifiedAt: null, createdAt: new Date('2026-01-01') },
      ]);
      const best = await svc.bestChannelIds(WS, ['EMAIL']);
      expect(best.get('EMAIL')?.id).toBe('b');
    });
  });
});
