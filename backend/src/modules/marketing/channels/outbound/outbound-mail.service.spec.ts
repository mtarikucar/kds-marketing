import { OutboundMailService } from './outbound-mail.service';
import { OutboundMail } from './outbound-mail.types';

/**
 * The seam. What these cases pin down is the difference between the four
 * answers that used to be one bare `false`: SENT, REFUSED (policy said no),
 * FAILED_TRANSIENT (try again) and FAILED_PERMANENT (never) — plus the two
 * things that must never happen: a refusal costing quota, and a mock success
 * reported as a delivery.
 */
describe('OutboundMailService', () => {
  const UNSUB = { token: 'tok', url: 'https://app.test/api/public/ul/tok' };

  function mail(over: Partial<OutboundMail> = {}): OutboundMail {
    return {
      workspaceId: 'ws-1',
      mailClass: 'BULK',
      to: 'ali@acme.test',
      subject: 'Kampanya',
      text: 'merhaba',
      source: 'campaign:c1',
      unsubscribe: UNSUB,
      ...over,
    };
  }

  function build(
    over: {
      refusal?: any;
      identity?: any;
      claim?: any;
      pending?: any;
      adapterResult?: any;
      platformResult?: any;
      configured?: boolean;
      lead?: any;
      workspace?: any;
    } = {},
  ) {
    const identity = {
      resolve: jest.fn().mockResolvedValue(
        over.identity ?? {
          transport: 'PLATFORM',
          fromEmail: 'no-reply@jeetagrowth.com',
          fromName: 'Acme via Jeeta',
          replyTo: 'admin@acme.test',
        },
      ),
    };
    const guard = {
      check: jest.fn().mockResolvedValue(over.refusal ?? null),
      refundQuota: jest.fn().mockResolvedValue(undefined),
    };
    const mailLog = {
      claim: jest.fn().mockResolvedValue(over.claim ?? null),
      pending: jest.fn().mockResolvedValue(
        over.pending ?? {
          deduped: false,
          row: { id: 'ml-1', workspaceId: 'ws-1', status: 'PENDING', messageId: null },
        },
      ),
      settle: jest.fn().mockResolvedValue(undefined),
    };
    const trace = { record: jest.fn().mockResolvedValue(undefined) };
    const suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
    const adapter = {
      send: jest.fn().mockResolvedValue(over.adapterResult ?? { externalMessageId: '<x@acme.test>', status: 'SENT' }),
    };
    const registry = { get: jest.fn().mockReturnValue(adapter) };
    const platform = over.platformResult ?? { ok: true, messageId: '<p@jeetagrowth.com>' };
    const email = {
      isConfigured: jest.fn().mockReturnValue(over.configured ?? true),
      sendPlainEmailResult: jest.fn().mockResolvedValue(platform),
      sendCampaignEmailResult: jest.fn().mockResolvedValue(platform),
      sendPlainEmailWithIcsResult: jest.fn().mockResolvedValue(platform),
    };
    const health = {
      recordOk: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    const prisma: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(over.lead ?? null) },
      workspace: {
        findUnique: jest.fn().mockResolvedValue(
          over.workspace === undefined
            ? { status: 'ACTIVE', settings: null, name: 'Acme', defaultLanguage: 'tr' }
            : over.workspace,
        ),
      },
    };
    const svc = new OutboundMailService(
      prisma,
      identity as any,
      guard as any,
      mailLog as any,
      trace as any,
      suppression as any,
      registry as any,
      email as any,
      health as any,
    );
    return { svc, prisma, identity, guard, mailLog, trace, suppression, registry, adapter, email, health };
  }

  describe('a refusal', () => {
    it('comes back REFUSED with the gate reason and a localisable message', async () => {
      const { svc, mailLog } = build({ refusal: { reason: 'NO_UNSUBSCRIBE', retriable: false } });
      const r = await svc.send(mail({ unsubscribe: undefined }));
      expect(r).toMatchObject({
        outcome: 'REFUSED',
        ok: false,
        transport: 'NONE',
        reason: 'NO_UNSUBSCRIBE',
        userMessage: { key: 'mail.reason.NO_UNSUBSCRIBE' },
        retriable: false,
      });
      expect(mailLog.pending).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'REFUSED', reason: 'NO_UNSUBSCRIBE', transport: 'NONE' }),
      );
    });

    it('never reaches a transport', async () => {
      const { svc, email, adapter } = build({ refusal: { reason: 'SUPPRESSED_OPT_OUT', retriable: false } });
      await svc.send(mail());
      expect(email.sendPlainEmailResult).not.toHaveBeenCalled();
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it('is written onto the lead timeline — the line that never existed', async () => {
      const { svc, trace } = build({
        refusal: { reason: 'SUPPRESSED_OPT_OUT', retriable: false },
        lead: { id: 'lead-1', emailNormalized: 'ali@acme.test' },
      });
      await svc.send(mail({ leadId: 'lead-1' }));
      expect(trace.record).toHaveBeenCalledWith(
        expect.objectContaining({
          leadId: 'lead-1',
          receipt: expect.objectContaining({ outcome: 'REFUSED', reason: 'SUPPRESSED_OPT_OUT' }),
        }),
      );
    });

    it('does not throw when the quota is exhausted', async () => {
      const { svc } = build({ refusal: { reason: 'QUOTA_EXHAUSTED', retriable: false } });
      await expect(svc.send(mail())).resolves.toMatchObject({
        outcome: 'REFUSED',
        reason: 'QUOTA_EXHAUSTED',
      });
    });
  });

  describe('no transport', () => {
    it('is FAILED_PERMANENT / NOT_CONFIGURED, never a mock success', async () => {
      const { svc, email, mailLog } = build({ configured: false });
      const r = await svc.send(mail());
      expect(r).toMatchObject({
        outcome: 'FAILED_PERMANENT',
        ok: false,
        transport: 'NONE',
        reason: 'NOT_CONFIGURED',
      });
      expect(email.sendPlainEmailResult).not.toHaveBeenCalled();
      expect(mailLog.settle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ outcome: 'FAILED_PERMANENT', reason: 'NOT_CONFIGURED' }),
      );
    });

    it('refuses a mailbox identity with no resolved config', async () => {
      const { svc, adapter } = build({
        identity: { transport: 'MAILBOX_SMTP', fromEmail: 'admin@acme.test', fromName: 'Acme' },
      });
      await expect(svc.send(mail())).resolves.toMatchObject({ reason: 'NOT_CONFIGURED' });
      expect(adapter.send).not.toHaveBeenCalled();
    });
  });

  describe('dedupe', () => {
    it('answers DEDUPED for a key that already sent', async () => {
      const { svc, guard } = build({
        claim: { id: 'ml-old', workspaceId: 'ws-1', status: 'SENT', messageId: 'a@b.test', transport: 'PLATFORM' },
      });
      const r = await svc.send(mail({ idempotencyKey: 'wf:r1:s1:l1' }));
      expect(r).toMatchObject({ outcome: 'DEDUPED', ok: true, mailLogId: 'ml-old', messageId: 'a@b.test' });
      expect(guard.check).not.toHaveBeenCalled();
    });

    it('never dedupes without a key — a rep may type "tamam" twice', async () => {
      const { svc, mailLog } = build();
      await svc.send(mail());
      expect(mailLog.claim).not.toHaveBeenCalled();
    });

    it('gives the quota back when it loses the insert race', async () => {
      const { svc, guard } = build({
        pending: { deduped: true, row: { id: 'ml-old', workspaceId: 'ws-1', status: 'SENT', messageId: null } },
      });
      const r = await svc.send(mail({ idempotencyKey: 'wf:r1:s1:l1' }));
      expect(r.outcome).toBe('DEDUPED');
      expect(guard.refundQuota).toHaveBeenCalled();
    });
  });

  describe('a successful send', () => {
    it('settles the ledger and reports the transport that carried it', async () => {
      const { svc, mailLog } = build();
      const r = await svc.send(mail());
      expect(r).toMatchObject({ outcome: 'SENT', ok: true, transport: 'PLATFORM', retriable: false });
      // The id comes back normalised — no angle brackets on either side of a
      // later equality check.
      expect(r.messageId).toBe('p@jeetagrowth.com');
      expect(mailLog.settle).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ml-1' }),
        expect.objectContaining({ outcome: 'SENT' }),
      );
    });

    it('opens the ledger row BEFORE dispatching', async () => {
      const order: string[] = [];
      const { svc, mailLog, email } = build();
      mailLog.pending.mockImplementation(async () => {
        order.push('pending');
        return { deduped: false, row: { id: 'ml-1', workspaceId: 'ws-1', status: 'PENDING', messageId: null } };
      });
      email.sendPlainEmailResult.mockImplementation(async () => {
        order.push('dispatch');
        return { ok: true, messageId: null };
      });
      await svc.send(mail());
      expect(order).toEqual(['pending', 'dispatch']);
    });

    it('carries the tenant Reply-To and display name onto the platform transport', async () => {
      const { svc, email } = build();
      await svc.send(mail());
      const from = email.sendPlainEmailResult.mock.calls[0][3];
      expect(from).toMatchObject({
        email: 'no-reply@jeetagrowth.com',
        name: 'Acme via Jeeta',
        replyTo: 'admin@acme.test',
      });
    });

    it('uses its own deterministic Message-ID when the transport reports none', async () => {
      const { svc } = build({ platformResult: { ok: true, messageId: null } });
      const r = await svc.send(mail());
      expect(r.messageId).toBe('ml-1@jeetagrowth.com');
    });

    it('puts that same id on the wire, not only on the ledger row', async () => {
      // A stored id the recipient never saw matches no DSN and no Sent-folder
      // copy — it would be a key for nothing.
      const { svc, email } = build();
      await svc.send(mail());
      expect(email.sendPlainEmailResult.mock.calls[0][5]).toBe('<ml-1@jeetagrowth.com>');
    });
  });

  describe('bulk composition', () => {
    it('passes the one-click URL to the transport and appends a footer with the link', async () => {
      const { svc, email } = build();
      await svc.send(mail());
      const [, , text, , unsubUrl] = email.sendPlainEmailResult.mock.calls[0];
      expect(unsubUrl).toBe(UNSUB.url);
      expect(text).toContain(UNSUB.url);
      expect(text).toContain('ali@acme.test');
    });

    it('does not append a second footer when the caller already rendered the link', async () => {
      const { svc, email } = build();
      await svc.send(mail({ text: `merhaba\n\nAboneliği bırak: ${UNSUB.url}` }));
      const text = email.sendPlainEmailResult.mock.calls[0][2];
      expect(text.match(new RegExp(UNSUB.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    });

    it('never gives a transactional mail an unsubscribe header or footer', async () => {
      const { svc, email } = build();
      await svc.send(mail({ mailClass: 'TRANSACTIONAL', unsubscribe: UNSUB, text: 'Faturanız hazır' }));
      const [, , text, , unsubUrl] = email.sendPlainEmailResult.mock.calls[0];
      expect(unsubUrl).toBeUndefined();
      expect(text).toBe('Faturanız hazır');
    });

    it('sends an HTML body through the multipart sender and escapes the footer values', async () => {
      const { svc, email } = build({
        workspace: {
          status: 'ACTIVE',
          name: 'Acme',
          defaultLanguage: 'en',
          settings: { email: { identity: { tradeName: '<script>x</script>' } } },
        },
      });
      await svc.send(mail({ html: '<p>merhaba</p>' }));
      const html = email.sendCampaignEmailResult.mock.calls[0][3];
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
    });
  });

  describe('the mailbox transport', () => {
    const CONFIG = { channelId: 'ch-1', workspaceId: 'ws-1', type: 'EMAIL', externalId: null, secrets: {}, public: {} };
    const MAILBOX = {
      transport: 'MAILBOX_SMTP',
      config: CONFIG,
      fromEmail: 'admin@acme.test',
      fromName: 'Acme',
    };

    it('threads a conversational reply and marks an AI body auto-submitted', async () => {
      const { svc, adapter } = build({ identity: MAILBOX });
      await svc.send(
        mail({
          mailClass: 'CONVERSATIONAL',
          unsubscribe: undefined,
          aiAuthored: true,
          thread: { inReplyTo: 'a@b.test', references: ['<c@d.test>'] },
        }),
      );
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: '<a@b.test>',
          references: ['<c@d.test>'],
          autoSubmitted: 'auto-replied',
        }),
      );
    });

    it('never threads a campaign into somebody else s thread', async () => {
      const { svc, adapter } = build({ identity: MAILBOX });
      await svc.send(mail({ thread: { inReplyTo: 'a@b.test' } }));
      const sent = adapter.send.mock.calls[0][0];
      expect(sent.inReplyTo).toBeUndefined();
      expect(sent.autoSubmitted).toBeUndefined();
    });

    it('records the send lane of the mailbox card', async () => {
      const { svc, health } = build({ identity: MAILBOX });
      await svc.send(mail());
      expect(health.recordOk).toHaveBeenCalledWith({ id: 'ch-1', workspaceId: 'ws-1' }, 'send');
    });

    it('records a send-lane failure', async () => {
      const { svc, health } = build({
        identity: MAILBOX,
        adapterResult: { externalMessageId: null, status: 'FAILED', error: '535 5.7.8 auth failed' },
      });
      await svc.send(mail());
      expect(health.recordFailure).toHaveBeenCalledWith(
        { id: 'ch-1', workspaceId: 'ws-1' },
        'send',
        expect.objectContaining({ reason: 'SYSTEMIC' }),
      );
    });
  });

  describe('classifying a failure', () => {
    async function failWith(error: string, smtpCode?: number) {
      const { svc, suppression, guard } = build({ platformResult: { ok: false, error, smtpCode } });
      const receipt = await svc.send(mail());
      return { receipt, suppression, guard };
    }

    it('calls a 4xx transient and retriable', async () => {
      const { receipt } = await failWith('451 4.3.0 try later', 451);
      expect(receipt).toMatchObject({ outcome: 'FAILED_TRANSIENT', reason: 'TRANSIENT', retriable: true });
    });

    it('calls an auth refusal systemic — requeued, but not retried as-is', async () => {
      const { receipt } = await failWith('535 5.7.8 Authentication failed', 535);
      expect(receipt).toMatchObject({ outcome: 'FAILED_TRANSIENT', reason: 'SYSTEMIC', retriable: false });
    });

    it('does NOT suppress on 550 5.7.1 — that is a policy refusal, not a dead mailbox', async () => {
      const { receipt, suppression } = await failWith('550 5.7.1 Message rejected by policy', 550);
      expect(receipt.outcome).toBe('FAILED_PERMANENT');
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('suppresses on 550 5.1.1 — workspace-scoped, never globally', async () => {
      const { receipt, suppression } = await failWith('550 5.1.1 <ali@acme.test> User unknown', 550);
      expect(receipt).toMatchObject({ outcome: 'FAILED_PERMANENT', reason: 'PERMANENT' });
      expect(suppression.suppress).toHaveBeenCalledWith(
        'ws-1',
        'ali@acme.test',
        'EMAIL',
        'HARD_BOUNCE',
        expect.objectContaining({ source: 'smtp:campaign:c1' }),
      );
    });

    it('gives the quota back on every failure', async () => {
      const { guard } = await failWith('451 4.3.0 try later', 451);
      expect(guard.refundQuota).toHaveBeenCalled();
    });

    it('keeps the provider s own words, truncated', async () => {
      const { receipt } = await failWith(`550 ${'x'.repeat(400)}`, 550);
      expect(receipt.error).toHaveLength(300);
    });
  });

  describe('scoping', () => {
    it('reads the lead inside the workspace', async () => {
      const { svc, prisma } = build({ lead: { id: 'lead-1', emailNormalized: 'ali@acme.test' } });
      await svc.send(mail({ leadId: 'lead-1' }));
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-1', workspaceId: 'ws-1' } }),
      );
    });

    it('does not read the workspace for account or product mail', async () => {
      const { svc, prisma } = build();
      await svc.send(mail({ mailClass: 'AUTH', unsubscribe: undefined }));
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('preflight', () => {
    it('reports the resolved identity when nothing stops the send', async () => {
      const { svc, mailLog } = build();
      await expect(svc.preflight(mail())).resolves.toMatchObject({
        ok: true,
        transport: 'PLATFORM',
        from: { email: 'no-reply@jeetagrowth.com', replyTo: 'admin@acme.test' },
      });
      expect(mailLog.pending).not.toHaveBeenCalled();
    });

    it('spends no quota', async () => {
      const { svc, guard } = build();
      await svc.preflight(mail());
      expect(guard.check).toHaveBeenCalledWith(expect.objectContaining({ skipMetering: true }));
    });

    it('answers with the same reason the send would refuse with', async () => {
      const { svc } = build({ refusal: { reason: 'SUPPRESSED_OPT_OUT', retriable: false } });
      await expect(svc.preflight(mail())).resolves.toMatchObject({
        ok: false,
        reason: 'SUPPRESSED_OPT_OUT',
        userMessage: { key: 'mail.reason.SUPPRESSED_OPT_OUT' },
      });
    });

    it('names a missing transport before anybody presses send', async () => {
      const { svc } = build({ configured: false });
      await expect(svc.preflight(mail())).resolves.toMatchObject({
        ok: false,
        reason: 'NOT_CONFIGURED',
        transport: 'NONE',
      });
    });

    it('carries the degraded reason through for the pre-launch card', async () => {
      const { svc } = build({
        identity: {
          transport: 'PLATFORM',
          fromEmail: 'no-reply@jeetagrowth.com',
          fromName: 'Acme via Jeeta',
          degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
        },
      });
      await expect(svc.preflight(mail())).resolves.toMatchObject({
        degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
      });
    });
  });
});
