import { ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as bodyParser from 'body-parser';
import express from 'express';
import request from 'supertest';
import { EmailWebhookController } from './email-webhook.controller';
import { EmailChannelAdapter } from '../channels/adapters/email.adapter';
import { emailInboundToken } from '../channels/email-inbound-callback.util';

const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');

/** The real adapter — its own-address guard and From parsing are part of what
 *  the webhook path is supposed to run, so stubbing it would test nothing. */
const adapter = new EmailChannelAdapter({ register: () => undefined } as any, {} as any);

type Mocks = {
  resolver: { channelForInbound: jest.Mock; byExternalId: jest.Mock };
  registry: { has: jest.Mock; get: jest.Mock; resolveConfig: jest.Mock };
  ingress: { ingest: jest.Mock };
  suppression: { suppress: jest.Mock };
  prisma: any;
  items: { open: jest.Mock; done: jest.Mock; skipped: jest.Mock; failed: jest.Mock };
};

const CHANNEL = {
  id: 'chan-1',
  workspaceId: 'ws-1',
  type: 'EMAIL',
  status: 'ACTIVE',
  externalId: 'destek@acme.test',
  configSealed: null,
};

function build(channel: any = CHANNEL): { controller: EmailWebhookController } & Mocks {
  const resolver = {
    channelForInbound: jest.fn().mockResolvedValue(channel),
    byExternalId: jest.fn().mockResolvedValue(null),
  };
  const registry = {
    has: jest.fn().mockReturnValue(true),
    get: jest.fn().mockReturnValue(adapter),
    resolveConfig: jest.fn().mockImplementation((c: any) => ({
      channelId: c.id,
      workspaceId: c.workspaceId,
      type: c.type,
      externalId: c.externalId,
      secrets: { fromEmail: c.externalId, smtpUser: c.externalId },
      public: {},
    })),
  };
  const ingress = { ingest: jest.fn().mockResolvedValue({ conversationId: 'c1', messageId: 'm1' }) };
  const suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
  // The REPLIES_AND_KNOWN lookups. Every one answers "never heard of them" by
  // default; a test that wants a sender recognised says which way.
  const prisma: any = {
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    mailLog: { findFirst: jest.fn().mockResolvedValue(null) },
    contactIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const items = {
    open: jest.fn().mockResolvedValue({ id: 'it-1' }),
    done: jest.fn().mockResolvedValue(undefined),
    skipped: jest.fn().mockResolvedValue(undefined),
    failed: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new EmailWebhookController(
    resolver as any,
    registry as any,
    ingress as any,
    suppression as any,
    prisma as any,
    items as any,
  );
  return { controller, resolver, registry, ingress, suppression, prisma, items };
}

/** A body in the shape an express raw mount hands the controller. */
function req(body: unknown, headers: Record<string, string> = {}): any {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return { body: raw, headers: { 'content-type': 'application/json', ...headers } };
}

beforeEach(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.MARKETING_SECRET_KEY;
  delete process.env.EMAIL_FROM;
  jest.restoreAllMocks();
});

/**
 * The legacy route's trust boundary is still the HMAC-SHA256 over the RAW body
 * against EMAIL_INBOUND_SECRET. A custom relay may already sign it, so these
 * cases lock that it did not change under the new tokenized route.
 */
describe('EmailWebhookController — legacy HMAC signature', () => {
  const SECRET = 'inbound-secret';
  let controller: EmailWebhookController;

  beforeEach(() => {
    process.env.EMAIL_INBOUND_SECRET = SECRET;
    controller = build().controller;
  });
  afterEach(() => {
    delete process.env.EMAIL_INBOUND_SECRET;
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

  it('POST returns 401 on a bad signature and never ACKs', async () => {
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.receive(req({}, { 'x-email-signature': 'nope' }), res);
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

/**
 * The tokenized route is the fix for `inbound-webhook-unusable` and
 * `webhook-to-header-routing` at once: a relay needs no platform secret, and the
 * URL — not a header the sender wrote — names the tenant.
 */
describe('EmailWebhookController — tokenized per-channel inbound', () => {
  it('ingests into the channel the URL names, scoped to that workspace', async () => {
    const { controller, resolver, ingress } = build();
    const token = emailInboundToken('chan-1');
    const out = await controller.inbound(
      'chan-1',
      token,
      req({ from: 'Jane Buyer <jane@buyer.test>', recipient: 'destek@acme.test', text: 'merhaba' }),
    );
    expect(out).toEqual({ ok: true, received: 1 });
    expect(resolver.channelForInbound).toHaveBeenCalledWith('chan-1');
    // NOT byExternalId — the address never picks the tenant on this route.
    expect(resolver.byExternalId).not.toHaveBeenCalled();
    expect(ingress.ingest).toHaveBeenCalledWith(
      { id: 'chan-1', workspaceId: 'ws-1', type: 'EMAIL' },
      expect.objectContaining({ externalUserId: 'jane@buyer.test', displayName: 'Jane Buyer' }),
    );
  });

  it('refuses a token minted for another channel (401, nothing resolved)', async () => {
    const { controller, resolver, ingress } = build();
    const otherToken = emailInboundToken('chan-2');
    await expect(
      controller.inbound('chan-1', otherToken, req({ from: 'a@b.test', text: 'hi' })),
    ).rejects.toMatchObject({ status: 401 });
    expect(resolver.channelForInbound).not.toHaveBeenCalled();
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('refuses when MARKETING_SECRET_KEY is absent rather than opening up', async () => {
    const { controller } = build();
    const token = emailInboundToken('chan-1');
    delete process.env.MARKETING_SECRET_KEY;
    await expect(
      controller.inbound('chan-1', token, req({ from: 'a@b.test', text: 'hi' })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('acks without ingesting when the channel is not a usable EMAIL channel', async () => {
    const { controller, ingress } = build({ ...CHANNEL, status: 'DISABLED' });
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'a@b.test', text: 'hi' }),
    );
    expect(out).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('ingests even when the To header names a different tenant — the URL decides', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        To: 'destek@rakip.test',
        recipient: 'destek@acme.test',
        text: 'merhaba',
      }),
    );
    expect(ingress.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1' }),
      expect.objectContaining({ externalUserId: 'jane@buyer.test' }),
    );
  });

  it('returns 5xx when the ingest fails, so the relay redelivers', async () => {
    const { controller, ingress } = build();
    ingress.ingest.mockRejectedValueOnce(new Error('db down'));
    await expect(
      controller.inbound(
        'chan-1',
        emailInboundToken('chan-1'),
        req({ from: 'jane@buyer.test', text: 'merhaba' }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers the GET health twin only for a valid token', async () => {
    const { controller } = build();
    expect(await controller.tokenHealth('chan-1', emailInboundToken('chan-1'))).toBe('ok');
    await expect(controller.tokenHealth('chan-1', 'nope')).rejects.toMatchObject({ status: 401 });
  });
});

/**
 * `webhook-no-machine-filter`: the webhook path had none of the IMAP machine-mail
 * rules, so a vacation auto-reply ping-ponged with the AI and a bounce became a
 * lead. It now runs the same shared classifier.
 */
describe('EmailWebhookController — machine mail is filtered', () => {
  const headers = (pairs: [string, string][]) => JSON.stringify(pairs);

  it('filters an out-of-office auto-reply', async () => {
    const { controller, ingress } = build();
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        text: 'Ofis dışındayım',
        'message-headers': headers([['Auto-Submitted', 'auto-replied']]),
      }),
    );
    expect(out).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('filters a mailing-list blast', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'news@list.test',
        text: 'bülten',
        'message-headers': headers([['List-Unsubscribe', '<mailto:u@list.test>']]),
      }),
    );
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('filters an unattended daemon sender with no headers at all', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'no-reply@vendor.test', text: 'sipariş güncellendi' }),
    );
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('filters the platform’s own notification mail', async () => {
    process.env.EMAIL_FROM = 'bildirim@jeetagrowth.com';
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'bildirim@jeetagrowth.com', text: 'günlük özet' }),
    );
    expect(ingress.ingest).not.toHaveBeenCalled();
  });

  it('routes a DSN to suppression instead of creating a lead', async () => {
    const { controller, ingress, suppression } = build();
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'MAILER-DAEMON@relay.test',
        text: [
          'Reporting-MTA: dns; relay.test',
          '',
          'Final-Recipient: rfc822; olmayan@musteri.test',
          'Action: failed',
          'Status: 5.1.1',
        ].join('\n'),
        'message-headers': headers([
          ['Content-Type', 'multipart/report; report-type=delivery-status; boundary=b'],
        ]),
      }),
    );
    expect(out).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(suppression.suppress).toHaveBeenCalledWith(
      'ws-1',
      'olmayan@musteri.test',
      'EMAIL',
      'HARD_BOUNCE',
      expect.objectContaining({ source: 'dsn' }),
    );
  });

  it('never suppresses on a transient 4.x.x DSN', async () => {
    const { controller, suppression } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'MAILER-DAEMON@relay.test',
        text: 'Final-Recipient: rfc822; dolu@musteri.test\nAction: delayed\nStatus: 4.2.2',
        'message-headers': headers([
          ['Content-Type', 'multipart/report; report-type=delivery-status; boundary=b'],
        ]),
      }),
    );
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('treats a read receipt as neither a bounce nor a message', async () => {
    const { controller, ingress, suppression } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        text: 'okundu',
        'message-headers': headers([
          ['Content-Type', 'multipart/report; report-type=disposition-notification; boundary=b'],
        ]),
      }),
    );
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('drops the mailbox reading its own send back (echo loop guard)', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'destek@acme.test', text: 'bizim mailimiz' }),
    );
    expect(ingress.ingest).not.toHaveBeenCalled();
  });
});

/**
 * The body the webhook posts is not a `ParsedMail`, so everything the IMAP path
 * gets from mailparser has to be rebuilt here — including the quote stripping
 * that keeps the AI from reading its own previous message back.
 */
describe('EmailWebhookController — body normalisation', () => {
  it('prefers the provider’s stripped body when it sent one', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        'stripped-text': 'Evet, uygundur.',
        'body-plain': 'Evet, uygundur.\n\n> eski mesaj\n> devamı',
      }),
    );
    expect(ingress.ingest.mock.calls[0][1].text).toBe('Evet, uygundur.');
  });

  it('strips the quoted thread itself when the provider sent none', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        text: 'Evet, uygundur.\n\nOn Mon, 1 Jan 2026, Destek <destek@acme.test> wrote:\n> teklifimiz',
      }),
    );
    const text = ingress.ingest.mock.calls[0][1].text as string;
    expect(text).toBe('Evet, uygundur.');
  });

  it('falls back to the HTML part when there is no text part', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', 'body-html': '<p>Merhaba</p><p>te&#351;ekk&uuml;rler</p>' }),
    );
    expect(ingress.ingest.mock.calls[0][1].text).toContain('Merhaba');
  });

  it('ingests an attachment-only mail with a body that says the file was not read', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        text: '',
        attachments: JSON.stringify([{ name: 'sozlesme.pdf', 'content-type': 'application/pdf', size: 12 }]),
      }),
    );
    const text = ingress.ingest.mock.calls[0][1].text as string;
    expect(text).toContain('sozlesme.pdf');
    expect(text).toContain('okunamadı');
  });

  it('attributes a forged display name to the real sender, not the decoration', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: '"<patron@musteri.test>" <saldirgan@evil.test>', text: 'acil havale' }),
    );
    expect(ingress.ingest.mock.calls[0][1].externalUserId).toBe('saldirgan@evil.test');
  });

  it('carries the authentication verdict through to the message audit trail', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'patron@musteri.test',
        text: 'acil havale',
        'message-headers': JSON.stringify([
          ['Authentication-Results', 'mx.acme.test; dmarc=fail header.from=musteri.test'],
          ['Authentication-Results', 'mx.acme.test; dmarc=pass header.from=musteri.test'],
        ]),
      }),
    );
    const raw = ingress.ingest.mock.calls[0][1].raw as any;
    // The FIRST line is the border MTA's; an injected duplicate cannot flip it.
    expect(raw.auth).toMatchObject({ verdict: 'fail' });
  });
});

/**
 * `webhook-to-header-routing` step 1: the legacy route keeps its HMAC but stops
 * picking the tenant out of a header the sender wrote.
 */
describe('EmailWebhookController — legacy recipient routing', () => {
  const SECRET = 'inbound-secret';
  beforeEach(() => {
    process.env.EMAIL_INBOUND_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.EMAIL_INBOUND_SECRET;
  });

  const post = async (body: Record<string, unknown>, m: Mocks & { controller: EmailWebhookController }) => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await m.controller.receive(
      { body: raw, headers: { 'content-type': 'application/json', 'x-email-signature': sig } } as any,
      res,
    );
    return res;
  };

  it('prefers the envelope recipient over a crafted To header', async () => {
    const m = build();
    m.resolver.byExternalId.mockImplementation(async (_t: string, addr: string) =>
      addr === 'destek@acme.test' ? CHANNEL : null,
    );
    const res = await post(
      {
        from: 'jane@buyer.test',
        text: 'merhaba',
        recipient: 'destek@acme.test',
        To: 'destek@rakip.test',
      },
      m,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(m.resolver.byExternalId).toHaveBeenCalledWith('EMAIL', 'destek@acme.test');
    expect(m.ingress.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1' }),
      expect.anything(),
    );
  });

  it('reads Postmark’s OriginalRecipient envelope field', async () => {
    const m = build();
    m.resolver.byExternalId.mockImplementation(async (_t: string, addr: string) =>
      addr === 'destek@acme.test' ? CHANNEL : null,
    );
    await post({ From: 'jane@buyer.test', TextBody: 'merhaba', OriginalRecipient: 'destek@acme.test' }, m);
    expect(m.ingress.ingest).toHaveBeenCalled();
  });

  it('JSON-parses the SendGrid envelope string, which never resolved before', async () => {
    const m = build();
    m.resolver.byExternalId.mockImplementation(async (_t: string, addr: string) =>
      addr === 'destek@acme.test' ? CHANNEL : null,
    );
    await post(
      {
        from: 'jane@buyer.test',
        text: 'merhaba',
        envelope: JSON.stringify({ to: ['destek@acme.test'], from: 'jane@buyer.test' }),
      },
      m,
    );
    expect(m.resolver.byExternalId).toHaveBeenCalledWith('EMAIL', 'destek@acme.test');
    expect(m.ingress.ingest).toHaveBeenCalled();
  });

  it('drops a Bcc-shaped delivery whose fallback tier names two tenants', async () => {
    const m = build();
    const other = { ...CHANNEL, id: 'chan-2', workspaceId: 'ws-2', externalId: 'destek@rakip.test' };
    m.resolver.byExternalId.mockImplementation(async (_t: string, addr: string) => {
      if (addr === 'destek@acme.test') return CHANNEL;
      if (addr === 'destek@rakip.test') return other;
      return null;
    });
    const res = await post(
      { from: 'jane@buyer.test', text: 'merhaba', To: 'destek@acme.test, destek@rakip.test' },
      m,
    );
    // ACKed (the relay must not retry a mail we will always refuse) but nothing
    // is ingested: guessing here is exactly the cross-tenant delivery.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(m.ingress.ingest).not.toHaveBeenCalled();
  });

  it('still routes on the header tier when it names exactly one tenant', async () => {
    const m = build();
    m.resolver.byExternalId.mockImplementation(async (_t: string, addr: string) =>
      addr === 'destek@acme.test' ? CHANNEL : null,
    );
    await post({ from: 'jane@buyer.test', text: 'merhaba', To: 'Destek <destek@acme.test>' }, m);
    expect(m.ingress.ingest).toHaveBeenCalled();
  });

  it('returns 5xx when a legacy ingest fails, rather than ACKing the loss away', async () => {
    const m = build();
    m.resolver.byExternalId.mockResolvedValue(CHANNEL);
    m.ingress.ingest.mockRejectedValueOnce(new Error('db down'));
    const res = await post({ from: 'jane@buyer.test', text: 'merhaba', recipient: 'destek@acme.test' }, m);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

/**
 * `app.use` is PREFIX matching, so the raw parser mounted on
 * `/api/public/channels/email/webhook` never covered `:channelId/:token/inbound`
 * — the new route would have fallen through to the 200kb JSON parser and
 * rejected every real mail. Mounting the prefix covers both; this proves the
 * legacy path still lands on raw, which is what its HMAC is computed over.
 */
describe('inbound raw-body mount', () => {
  const PREFIX = '/api/public/channels/email';

  it('app.config mounts the raw parser on the whole email prefix', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../app.config.ts'), 'utf8');
    expect(src).toMatch(/app\.use\(\s*'\/api\/public\/channels\/email'\s*,\s*bodyParser\.raw/);
  });

  it('hands both the legacy and the tokenized path the exact bytes', async () => {
    const app = express();
    app.use(PREFIX, bodyParser.raw({ type: '*/*', limit: '2mb' }));
    app.use(bodyParser.json({ limit: '200kb' }));
    const seen: Record<string, boolean> = {};
    app.post(`${PREFIX}/webhook`, (r, res) => {
      seen.legacy = Buffer.isBuffer(r.body);
      res.status(200).send('ok');
    });
    app.post(`${PREFIX}/:channelId/:token/inbound`, (r, res) => {
      seen.tokenized = Buffer.isBuffer(r.body);
      res.status(200).send('ok');
    });

    await request(app)
      .post(`${PREFIX}/webhook`)
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('sender=jane%40x.test');
    await request(app)
      .post(`${PREFIX}/chan-1/abc/inbound`)
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('sender=jane%40x.test');

    expect(seen.legacy).toBe(true);
    expect(seen.tokenized).toBe(true);
  });
});

describe('EmailWebhookController — the same policy both doors run', () => {
  const PRIVATE = { ...CHANNEL, configPublic: { inboundPolicy: 'REPLIES_AND_KNOWN' } };

  it('lets a stranger through on a channel connected before the knob existed', async () => {
    // G3: a missing `inboundPolicy` reads as ALL_SENDERS — today's behaviour.
    const { controller, ingress, prisma } = build();
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba' }),
    );
    expect(out).toEqual({ ok: true, received: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
    // And costs no query at all.
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
  });

  it('records a stranger as policy-not-a-lead under REPLIES_AND_KNOWN', async () => {
    const { controller, ingress, items } = build(PRIVATE);
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba' }),
    );
    expect(out).toEqual({ ok: true, received: 0 });
    expect(ingress.ingest).not.toHaveBeenCalled();
    expect(items.skipped).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', channelId: 'chan-1', source: 'webhook' }),
      'policy-not-a-lead',
      expect.anything(),
    );
  });

  it('lets a known lead through under REPLIES_AND_KNOWN', async () => {
    const { controller, ingress, prisma } = build(PRIVATE);
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba' }),
    );
    expect(ingress.ingest).toHaveBeenCalled();
  });
});

describe('EmailWebhookController — every examined item leaves a row', () => {
  it('records an ingested mail as DONE, keyed to this channel and workspace', async () => {
    const { controller, items } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba', 'message-id': '<m-7@buyer.test>' }),
    );
    expect(items.open).toHaveBeenCalled();
    expect(items.done).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', channelId: 'chan-1', source: 'webhook', itemKey: 'm-7@buyer.test' },
      expect.objectContaining({ fromAddress: 'jane@buyer.test' }),
    );
  });

  it('records a filtered auto-reply with its reason', async () => {
    const { controller, items } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'jane@buyer.test',
        text: 'Ofis dışındayım',
        'message-headers': JSON.stringify([['Auto-Submitted', 'auto-replied']]),
      }),
    );
    expect(items.skipped).toHaveBeenCalledWith(expect.anything(), 'auto-reply', expect.anything());
  });

  it('records a FAILED ingest and still answers 5xx so the relay redelivers', async () => {
    // Redelivery is the primary recovery — unlike a mailbox uid, these bytes
    // exist nowhere else. The row covers the case where it never comes:
    // without it the open() above leaves a NEW row nobody will settle.
    const { controller, ingress, items } = build();
    ingress.ingest.mockRejectedValue(new Error('P2024 pool timeout'));

    await expect(
      controller.inbound(
        'chan-1',
        emailInboundToken('chan-1'),
        req({ from: 'jane@buyer.test', text: 'merhaba', 'message-id': '<m-9@buyer.test>' }),
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(items.failed).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'm-9@buyer.test', source: 'webhook' }),
      expect.stringContaining('P2024'),
      expect.anything(),
    );
    expect(items.done).not.toHaveBeenCalled();
  });

  it('still receives the mail when the ledger write throws', async () => {
    // Losing the mail to protect its own audit trail would be exactly backwards.
    const { controller, items, ingress } = build();
    items.open.mockRejectedValue(new Error('ledger down'));
    items.done.mockRejectedValue(new Error('ledger down'));
    const out = await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba' }),
    );
    expect(out).toEqual({ ok: true, received: 1 });
    expect(ingress.ingest).toHaveBeenCalled();
  });
});

describe('EmailWebhookController — what the transport could prove', () => {
  it('carries an authentication FAILURE all the way to the ingress', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({
        from: 'ceo@victim.test',
        text: 'wire the money to this new account',
        'message-headers': JSON.stringify([
          ['Authentication-Results', 'mx.acme.test; spf=fail; dkim=fail; dmarc=fail'],
        ]),
      }),
    );
    // Still ingested and still attached to the lead: a human must see it.
    expect(ingress.ingest).toHaveBeenCalled();
    expect(ingress.ingest.mock.calls[0][1].senderVerified).toBe(false);
  });

  it('leaves it UNSET for ordinary mail nobody authenticated', async () => {
    const { controller, ingress } = build();
    await controller.inbound(
      'chan-1',
      emailInboundToken('chan-1'),
      req({ from: 'jane@buyer.test', text: 'merhaba' }),
    );
    expect(ingress.ingest.mock.calls[0][1].senderVerified).toBeUndefined();
  });
});
