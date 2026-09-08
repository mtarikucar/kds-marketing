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
    prisma = { channel: { findFirst: jest.fn().mockResolvedValue(channel) } };
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
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: WS,
        type: 'EMAIL',
        status: 'ACTIVE',
        lastVerifiedAt: { not: null },
      },
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
});
