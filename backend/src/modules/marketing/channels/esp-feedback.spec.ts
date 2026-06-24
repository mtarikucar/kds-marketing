import { createHmac } from 'crypto';
import { EspFeedbackService } from './esp-feedback.service';
import { EspFeedbackController } from '../controllers/esp-feedback.controller';

describe('ESP feedback (bounce/complaint suppression)', () => {
  describe('EspFeedbackService.suppress', () => {
    let prisma: any;
    let svc: EspFeedbackService;
    beforeEach(() => {
      prisma = { lead: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) } };
      svc = new EspFeedbackService(prisma as any);
    });

    it('stamps emailBouncedAt + emailOptOut globally by normalized address', async () => {
      const n = await svc.suppress([{ email: ' John.Doe@Gmail.com ', kind: 'bounce' }]);
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      expect(arg.where.emailNormalized).toBe('john.doe@gmail.com'); // trimmed + lowercased
      expect(arg.where.emailBouncedAt).toBeNull(); // only un-suppressed rows
      expect(arg.data).toEqual({ emailBouncedAt: expect.any(Date), emailOptOut: true });
      expect(n).toBe(2);
    });

    it('skips an unparseable address without throwing', async () => {
      const n = await svc.suppress([{ email: 'not-an-email', kind: 'complaint' }]);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(n).toBe(0);
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
      feedback = { suppress: jest.fn().mockResolvedValue(1) };
      ctrl = new EspFeedbackController(feedback as any);
    });
    afterAll(() => {
      if (realSecret === undefined) delete process.env.ESP_FEEDBACK_SECRET;
      else process.env.ESP_FEEDBACK_SECRET = realSecret;
    });

    it('rejects a bad signature with 401 (and never suppresses)', () => {
      const r = res();
      ctrl.receive(req('[]', 'wrong'), r);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(feedback.suppress).not.toHaveBeenCalled();
    });

    it('is inert (401) when ESP_FEEDBACK_SECRET is unset', () => {
      delete process.env.ESP_FEEDBACK_SECRET;
      const r = res();
      ctrl.receive({ body: Buffer.from('[]'), headers: {} } as any, r);
      expect(r.status).toHaveBeenCalledWith(401);
    });

    it('ACKs "OK" and parses SendGrid hard-bounce + spamreport (skips soft block)', () => {
      const payload = JSON.stringify([
        { email: 'hard@x.com', event: 'bounce' },
        { email: 'soft@x.com', event: 'bounce', type: 'blocked' },
        { email: 'spam@x.com', event: 'spamreport' },
        { email: 'open@x.com', event: 'open' },
      ]);
      const r = res();
      ctrl.receive(req(payload), r);
      expect(r.status).toHaveBeenCalledWith(200);
      expect(r.send).toHaveBeenCalledWith('OK');
      const events = feedback.suppress.mock.calls[0][0];
      expect(events).toEqual([
        { email: 'hard@x.com', kind: 'bounce' },
        { email: 'spam@x.com', kind: 'complaint' },
      ]);
    });

    it('suppresses a SendGrid "dropped" only for a recipient-undeliverable reason', () => {
      ctrl.receive(req(JSON.stringify([
        { email: 'badcontent@x.com', event: 'dropped', reason: 'Spam Content' }, // sender-side → skip
        { email: 'dead@x.com', event: 'dropped', reason: 'Bounced Address' },     // recipient-side → suppress
      ])), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'dead@x.com', kind: 'drop' }]);
    });

    it('parses Postmark + Mailgun shapes', () => {
      ctrl.receive(req(JSON.stringify({ RecordType: 'SpamComplaint', Email: 'pm@x.com' })), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'pm@x.com', kind: 'complaint' }]);
      feedback.suppress.mockClear();
      ctrl.receive(req(JSON.stringify({ 'event-data': { event: 'failed', recipient: 'mg@x.com', severity: 'permanent' } })), res());
      expect(feedback.suppress.mock.calls[0][0]).toEqual([{ email: 'mg@x.com', kind: 'bounce' }]);
      feedback.suppress.mockClear();
      // a transient (soft) Mailgun failure must NOT suppress
      ctrl.receive(req(JSON.stringify({ 'event-data': { event: 'failed', recipient: 'soft@x.com', severity: 'temporary' } })), res());
      expect(feedback.suppress).not.toHaveBeenCalled();
    });
  });
});
