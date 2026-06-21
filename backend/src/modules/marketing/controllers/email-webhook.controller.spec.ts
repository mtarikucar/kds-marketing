import { createHmac } from 'crypto';
import { EmailWebhookController } from './email-webhook.controller';

/**
 * The Email webhook's trust boundary is the HMAC-SHA256 over the RAW body
 * against EMAIL_INBOUND_SECRET. These guard against spoofed inbound mail, so
 * they get a focused spec.
 */
describe('EmailWebhookController — signature', () => {
  const SECRET = 'inbound-secret';
  let controller: EmailWebhookController;

  beforeEach(() => {
    process.env.EMAIL_INBOUND_SECRET = SECRET;
    controller = new EmailWebhookController({} as any, { has: () => false } as any, {} as any);
  });

  const sign = (raw: Buffer) => createHmac('sha256', SECRET).update(raw).digest('hex');

  it('accepts a correctly-signed payload', () => {
    const raw = Buffer.from(JSON.stringify({ from: 'a@b.test', text: 'hi' }));
    expect((controller as any).validSignature(raw, sign(raw))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const raw = Buffer.from(JSON.stringify({ from: 'a@b.test', text: 'hi' }));
    const sig = sign(raw);
    const tampered = Buffer.from(JSON.stringify({ from: 'evil@x.test', text: 'pwn' }));
    expect((controller as any).validSignature(tampered, sig)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect((controller as any).validSignature(Buffer.from('{}'), undefined)).toBe(false);
  });

  it('rejects when no inbound secret is configured (inert)', () => {
    delete process.env.EMAIL_INBOUND_SECRET;
    const raw = Buffer.from('{}');
    expect((controller as any).validSignature(raw, sign(raw))).toBe(false);
  });

  it('POST returns 401 on a bad signature and never ACKs', () => {
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const req: any = { body: Buffer.from('{}'), headers: { 'x-email-signature': 'nope' } };
    controller.receive(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  describe('parseBody (provider encodings)', () => {
    it('parses JSON (Postmark)', () => {
      const raw = Buffer.from(JSON.stringify({ From: 'a@b.test', TextBody: 'hi' }));
      const body = (controller as any).parseBody(raw, 'application/json');
      expect(body.From).toBe('a@b.test');
    });

    it('parses urlencoded (Mailgun)', () => {
      const raw = Buffer.from('sender=jane%40x.test&recipient=support%40acme.test&stripped-text=hi');
      const body = (controller as any).parseBody(raw, 'application/x-www-form-urlencoded');
      expect(body.sender).toBe('jane@x.test');
      expect(body['stripped-text']).toBe('hi');
    });

    it('extracts multipart text fields (SendGrid)', () => {
      const b = 'XYZ';
      const raw = Buffer.from(
        `--${b}\r\nContent-Disposition: form-data; name="from"\r\n\r\njane@x.test\r\n` +
          `--${b}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n--${b}--\r\n`,
      );
      const body = (controller as any).parseBody(raw, `multipart/form-data; boundary=${b}`);
      expect(body.from).toBe('jane@x.test');
      expect(body.text).toBe('hello');
    });

    it('falls back to JSON when content-type is absent', () => {
      const raw = Buffer.from(JSON.stringify({ from: 'a@b.test', text: 'hi' }));
      const body = (controller as any).parseBody(raw, undefined);
      expect(body.from).toBe('a@b.test');
    });
  });
});
