import { createHmac, createSign, generateKeyPairSync } from 'crypto';
import { EspFeedbackService } from './esp-feedback.service';
import { EspFeedbackController } from '../controllers/esp-feedback.controller';
import { WebhookReplayStore } from './inbound/webhook-verifier/webhook-replay.store';

describe('ESP feedback (bounce/complaint suppression)', () => {
  describe('EspFeedbackService.suppress', () => {
    let prisma: any;
    let svc: EspFeedbackService;
    beforeEach(() => {
      prisma = { lead: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) } };
      svc = new EspFeedbackService(prisma as any);
    });

    it('stamps emailBouncedAt + emailOptOut globally by normalized address', async () => {
      const out = await svc.suppress([{ email: ' John.Doe@Gmail.com ', kind: 'bounce' }]);
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      expect(arg.where.emailNormalized).toBe('john.doe@gmail.com'); // trimmed + lowercased
      expect(arg.where.emailBouncedAt).toBeNull(); // only un-suppressed rows
      expect(arg.data).toEqual({ emailBouncedAt: expect.any(Date), emailOptOut: true });
      expect(out).toEqual({ suppressed: 2, failed: 0 });
    });

    it('a COMPLAINT withdraws marketing consent only — it never stamps emailBouncedAt', async () => {
      // A spam report is a statement about marketing, not about the address:
      // stamping emailBouncedAt would stop tenant B's INVOICES to a customer who
      // complained about tenant A's campaign (esp-complaint-crosstenant).
      await svc.suppress([{ email: 'spam@x.com', kind: 'complaint' }]);
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      expect(arg.data).toEqual({ emailOptOut: true });
      expect(arg.data.emailBouncedAt).toBeUndefined();
    });

    it('guards a complaint on emailOptOut so an already-bounced address is not a silent no-op', async () => {
      await svc.suppress([{ email: 'spam@x.com', kind: 'complaint' }]);
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ emailNormalized: 'spam@x.com', emailOptOut: false });
      expect(arg.where.emailBouncedAt).toBeUndefined();
    });

    it('treats a provider "drop" like a complaint, not like a hard bounce', async () => {
      await svc.suppress([{ email: 'dropped@x.com', kind: 'drop' }]);
      expect(prisma.lead.updateMany.mock.calls[0][0].data).toEqual({ emailOptOut: true });
    });

    it('skips an unparseable address without throwing', async () => {
      const out = await svc.suppress([{ email: 'not-an-email', kind: 'complaint' }]);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(out).toEqual({ suppressed: 0, failed: 0 });
    });

    it('reports a failed write instead of throwing, so the caller can ask for a redelivery', async () => {
      prisma.lead.updateMany
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ count: 1 });
      const out = await svc.suppress([
        { email: 'first@x.com', kind: 'bounce' },
        { email: 'second@x.com', kind: 'bounce' },
      ]);
      // One bad address never costs the rest of the batch.
      expect(out).toEqual({ suppressed: 1, failed: 1 });
    });
  });

  describe('EspFeedbackController', () => {
    let feedback: { suppress: jest.Mock };
    let ctrl: EspFeedbackController;
    const realSecret = process.env.ESP_FEEDBACK_SECRET;
    const SECRET = 'esp-secret';

    const res = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }) as any;
    const sign = (raw: string) => createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex');
    const req = (raw: string, sig?: string) => ({ body: Buffer.from(raw), headers: { 'x-esp-signature': sig ?? sign(raw) } }) as any;

    beforeEach(() => {
      process.env.ESP_FEEDBACK_SECRET = SECRET;
      feedback = { suppress: jest.fn().mockResolvedValue({ suppressed: 1, failed: 0 }) };
      ctrl = new EspFeedbackController(feedback as any, new WebhookReplayStore());
    });
    afterAll(() => {
      if (realSecret === undefined) delete process.env.ESP_FEEDBACK_SECRET;
      else process.env.ESP_FEEDBACK_SECRET = realSecret;
    });

    it('rejects a bad signature with 401 (and never suppresses)', async () => {
      const r = res();
      await ctrl.receive(req('[]', 'wrong'), r);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('is inert (401) when ESP_FEEDBACK_SECRET is unset', async () => {
      delete process.env.ESP_FEEDBACK_SECRET;
      const r = res();
      await ctrl.receive({ body: Buffer.from('[]'), headers: {} } as any, r);
      expect(r.status).toHaveBeenCalledWith(401);
    });

    it('ACKs "OK" and parses SendGrid hard-bounce + spamreport (skips soft block)', async () => {
      const payload = JSON.stringify([
        { email: 'hard@x.com', event: 'bounce' },
        { email: 'soft@x.com', event: 'bounce', type: 'blocked' },
        { email: 'spam@x.com', event: 'spamreport' },
        { email: 'open@x.com', event: 'open' },
      ]);
      const r = res();
      await ctrl.receive(req(payload), r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.send).toHaveBeenCalledWith('OK');
      const events = feedback.suppress.mock.calls[0][0];
      expect(events).toEqual([
        { email: 'hard@x.com', kind: 'bounce' },
        { email: 'spam@x.com', kind: 'complaint' },
      ]);
    });

    it('suppresses a SendGrid "dropped" only for a recipient-undeliverable reason', async () => {
      await ctrl.receive(req(JSON.stringify([
        { email: 'badcontent@x.com', event: 'dropped', reason: 'Spam Content' }, // sender-side → skip
        { email: 'dead@x.com', event: 'dropped', reason: 'Bounced Address' },     // recipient-side → suppress
      ])), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'dead@x.com', kind: 'drop' }]);
    });

    it('parses Postmark + Mailgun shapes', async () => {
      await ctrl.receive(req(JSON.stringify({ RecordType: 'SpamComplaint', Email: 'pm@x.com' })), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'pm@x.com', kind: 'complaint' }]);
      feedback.suppress.mockClear();
      await ctrl.receive(req(JSON.stringify({ 'event-data': { event: 'failed', recipient: 'mg@x.com', severity: 'permanent' } })), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'mg@x.com', kind: 'bounce' }]);
      feedback.suppress.mockClear();
      // a transient (soft) Mailgun failure must NOT suppress
      await ctrl.receive(req(JSON.stringify({ 'event-data': { event: 'failed', recipient: 'soft@x.com', severity: 'temporary' } })), res());
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('answers 5xx when the suppression write failed, so the provider redelivers', async () => {
      feedback.suppress.mockResolvedValue({ suppressed: 0, failed: 1 });
      const r = res();
      await ctrl.receive(req(JSON.stringify([{ email: 'hard@x.com', event: 'bounce' }])), r);
      expect(r.status).toHaveBeenCalledWith(500);
      expect(r.status).not.toHaveBeenCalledWith(200);
    });

    it('answers 5xx rather than 200 when the writer itself throws', async () => {
      feedback.suppress.mockRejectedValue(new Error('boom'));
      const r = res();
      await ctrl.receive(req(JSON.stringify([{ email: 'hard@x.com', event: 'bounce' }])), r);
      expect(r.status).toHaveBeenCalledWith(500);
    });
  });

  /**
   * The per-provider routes. The provider comes from the URL, so the verifier is
   * chosen before a byte of the payload is parsed — a payload-shape sniff would
   * let an attacker pick the verifier whose secret is unset.
   */
  describe('EspFeedbackController — per-provider routes', () => {
    const ENV = [
      'ESP_FEEDBACK_SECRET',
      'SENDGRID_EVENT_PUBLIC_KEY',
      'MAILGUN_WEBHOOK_SIGNING_KEY',
      'POSTMARK_WEBHOOK_USER',
      'POSTMARK_WEBHOOK_PASSWORD',
    ] as const;
    const saved: Record<string, string | undefined> = {};
    let feedback: { suppress: jest.Mock };
    let ctrl: EspFeedbackController;

    const res = () => ({ status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }) as any;
    const req = (raw: string, headers: Record<string, string> = {}) =>
      ({ body: Buffer.from(raw), headers, ip: '1.2.3.4' }) as any;

    beforeEach(() => {
      for (const k of ENV) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      feedback = { suppress: jest.fn().mockResolvedValue({ suppressed: 1, failed: 0 }) };
      ctrl = new EspFeedbackController(feedback as any, new WebhookReplayStore());
    });
    afterEach(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const SENDGRID_BODY = JSON.stringify([{ email: 'dead@x.com', event: 'bounce' }]);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sendgridHeaders = (raw: string) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const s = createSign('sha256');
      s.update(Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(raw)]));
      s.end();
      return {
        'x-twilio-email-event-webhook-timestamp': ts,
        'x-twilio-email-event-webhook-signature': s.sign(privateKey).toString('base64'),
      };
    };

    it('verifies a real SendGrid signature and suppresses', async () => {
      process.env.SENDGRID_EVENT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const r = res();
      await ctrl.receiveFrom('sendgrid', req(SENDGRID_BODY, sendgridHeaders(SENDGRID_BODY)), r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'dead@x.com', kind: 'bounce' }]);
    });

    it('is inert (401, never 500) for a provider whose key is unset', async () => {
      const r = res();
      await ctrl.receiveFrom('sendgrid', req(SENDGRID_BODY, sendgridHeaders(SENDGRID_BODY)), r);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(r.status).not.toHaveBeenCalledWith(500);
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('will not let the generic HMAC authenticate a provider route', async () => {
      // The whole point of routing by URL: a valid generic signature must not
      // open the sendgrid door just because ESP_FEEDBACK_SECRET happens to be set.
      process.env.ESP_FEEDBACK_SECRET = 'esp-secret';
      const sig = createHmac('sha256', 'esp-secret').update(Buffer.from(SENDGRID_BODY)).digest('hex');
      const r = res();
      await ctrl.receiveFrom('sendgrid', req(SENDGRID_BODY, { 'x-esp-signature': sig }), r);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('verifies Mailgun from its body-carried signature block', async () => {
      process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'mg-key';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const token = 'c'.repeat(50);
      const body = JSON.stringify({
        signature: {
          timestamp,
          token,
          signature: createHmac('sha256', 'mg-key').update(timestamp + token).digest('hex'),
        },
        'event-data': { event: 'complained', recipient: 'angry@x.com' },
      });
      const r = res();
      await ctrl.receiveFrom('mailgun', req(body), r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'angry@x.com', kind: 'complaint' }]);
    });

    it('verifies Postmark basic auth', async () => {
      process.env.POSTMARK_WEBHOOK_USER = 'jeeta';
      process.env.POSTMARK_WEBHOOK_PASSWORD = 'hunter2';
      const body = JSON.stringify({ RecordType: 'SpamComplaint', Email: 'pm@x.com' });
      const r = res();
      await ctrl.receiveFrom(
        'postmark',
        req(body, { authorization: `Basic ${Buffer.from('jeeta:hunter2').toString('base64')}` }),
        r,
      );
      expect(r.status).toHaveBeenCalledWith(200);
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'pm@x.com', kind: 'complaint' }]);
    });

    it('404s an unknown provider instead of guessing one', async () => {
      process.env.ESP_FEEDBACK_SECRET = 'esp-secret';
      const r = res();
      await ctrl.receiveFrom('brevo', req('[]'), r);
      expect(r.status).toHaveBeenCalledWith(404);
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('accepts the generic verifier on its own named route', async () => {
      process.env.ESP_FEEDBACK_SECRET = 'esp-secret';
      const body = JSON.stringify([{ email: 'relay@x.com', type: 'bounce' }]);
      const sig = createHmac('sha256', 'esp-secret').update(Buffer.from(body)).digest('hex');
      const r = res();
      await ctrl.receiveFrom('generic', req(body, { 'x-esp-signature': sig }), r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'relay@x.com', kind: 'bounce' }]);
    });
  });
});
