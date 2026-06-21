// nodemailer mock — capture sendMail / verify calls without a real SMTP server.
const sendMail = jest.fn();
const verify = jest.fn();
const close = jest.fn();
const createTransport = jest.fn(() => ({ sendMail, verify, close }));
jest.mock('nodemailer', () => ({ createTransport: () => createTransport() }));

import { EmailChannelAdapter } from './email.adapter';

const SMTP = {
  smtpHost: 'smtp.acme.test',
  smtpPort: '587',
  smtpUser: 'bot@acme.test',
  smtpPass: 'secret',
  fromEmail: 'bot@acme.test',
};

describe('EmailChannelAdapter', () => {
  const registry = { register: jest.fn() } as any;
  let adapter: EmailChannelAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new EmailChannelAdapter(registry);
  });

  it('registers itself on module init as EMAIL', () => {
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
    expect(adapter.type).toBe('EMAIL');
  });

  it('send is inert (FAILED, no throw, no SMTP) without credentials', async () => {
    const res = await adapter.send({ config: { secrets: {} } as any, to: 'lead@x.test', text: 'hi' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('SMTP');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('send delivers via the workspace SMTP and returns the provider message id', async () => {
    sendMail.mockResolvedValue({ messageId: '<abc@acme.test>' });
    const res = await adapter.send({
      config: { secrets: SMTP, public: { subject: 'Re: hello' } } as any,
      to: 'Lead <lead@x.test>',
      text: 'thanks!',
    });
    expect(res.status).toBe('SENT');
    expect(res.externalMessageId).toBe('<abc@acme.test>');
    const mail = sendMail.mock.calls[0][0];
    expect(mail).toMatchObject({ from: 'bot@acme.test', to: 'Lead <lead@x.test>', subject: 'Re: hello', text: 'thanks!' });
  });

  it('send returns FAILED (not throw) on an SMTP error', async () => {
    sendMail.mockRejectedValue(new Error('535 auth failed'));
    const res = await adapter.send({ config: { secrets: SMTP } as any, to: 'lead@x.test', text: 'hi' });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('535');
  });

  it('parseInbound normalizes a Mailgun-style payload and tags it EMAIL', () => {
    const out = adapter.parseInbound({ secrets: SMTP, externalId: 'support@acme.test' } as any, {
      sender: 'Jane Doe <jane@buyer.test>',
      recipient: 'support@acme.test',
      subject: 'Question',
      'stripped-text': 'Do you ship to TR?',
      'message-id': '<m-1@buyer.test>',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalUserId: 'jane@buyer.test',
      kind: 'EMAIL',
      externalMessageId: '<m-1@buyer.test>',
      displayName: 'Jane Doe',
    });
    expect(out[0].text).toContain('Question');
    expect(out[0].text).toContain('Do you ship to TR?');
  });

  it('parseInbound supports a Postmark-style payload', () => {
    const out = adapter.parseInbound({ secrets: SMTP } as any, {
      From: 'buyer@x.test',
      Subject: 'Hi',
      TextBody: 'hello there',
      MessageID: 'pm-1',
    });
    expect(out[0]).toMatchObject({ externalUserId: 'buyer@x.test', externalMessageId: 'pm-1' });
  });

  it('parseInbound drops our own address (echo / auto-reply loop guard)', () => {
    const out = adapter.parseInbound({ secrets: SMTP, externalId: 'support@acme.test' } as any, {
      from: 'bot@acme.test',
      text: 'auto-reply echo',
    });
    expect(out).toHaveLength(0);
  });

  it('parseInbound drops an echo that matches smtpUser even when fromEmail is unset', () => {
    // send() From = fromEmail || smtpUser, so smtpUser alone must still guard.
    const out = adapter.parseInbound({ secrets: { smtpUser: 'Bot@Acme.test' } } as any, {
      from: 'bot@acme.test',
      text: 'echo',
    });
    expect(out).toHaveLength(0);
  });

  it('parseInbound ignores empty/whitespace bodies', () => {
    const out = adapter.parseInbound({ secrets: SMTP } as any, { from: 'a@b.test', text: '   ' });
    expect(out).toHaveLength(0);
  });
});
