import {
  InboundWebhooksService,
  hashWebhookSecret,
  extractContact,
  sanitizeBody,
  WEBHOOK_SECRET_PREFIX,
} from './inbound-webhooks.service';
import { MarketingEventTypes } from '../events/marketing-event-types';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    inboundWebhook: {
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: 'wh1', name: data.name, slug: data.slug, secretHash: data.secretHash,
        enabled: true, lastReceivedAt: null, receivedCount: 0, createdAt: new Date(),
      })),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    lead: { findFirst: jest.fn() },
  };
  const outbox = { append: jest.fn().mockResolvedValue('evt1') };
  const config = { get: () => 'https://app.test' };
  const svc = new InboundWebhooksService(prisma as any, outbox as any, config as any);
  return { svc, prisma, outbox };
}

describe('InboundWebhooksService', () => {
  describe('extractContact', () => {
    it('pulls email/phone from common top-level keys', () => {
      expect(extractContact({ email: 'A@b.com', phone: '+90555' })).toEqual({ email: 'A@b.com', phone: '+90555' });
    });
    it('scans one level of wrapper objects', () => {
      expect(extractContact({ contact: { Email: 'x@y.com', mobile: '12345' } })).toEqual({ email: 'x@y.com', phone: '12345' });
    });
    it('returns empty for a body with no contact fields', () => {
      expect(extractContact({ foo: 'bar', nested: { deep: { email: 'too@deep.com' } } })).toEqual({});
    });
    it('ignores non-string values', () => {
      expect(extractContact({ email: 123, phone: null })).toEqual({});
    });
  });

  describe('sanitizeBody', () => {
    it('passes a normal body through', () => {
      expect(sanitizeBody({ a: 1 })).toEqual({ a: 1 });
    });
    it('truncates an oversized body', () => {
      const big = { blob: 'x'.repeat(40_000) };
      expect(sanitizeBody(big)).toMatchObject({ _truncated: true });
    });
  });

  it('mints a webhook with a hashed secret and returns the raw secret once', async () => {
    const { svc } = makeSvc();
    const res = await svc.create(WS, { name: 'Zapier' });
    expect(res.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(res.url).toBe(`https://app.test/api/public/hooks/${res.slug}`);
    // The returned shape never includes secretHash; only the one-time raw secret.
    expect((res as any).secretHash).toBeUndefined();
  });

  it('resolveActive returns null for a disabled webhook (no enabled oracle)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.inboundWebhook.findUnique.mockResolvedValue({ id: 'wh1', workspaceId: WS, enabled: false, secretHash: 'h' });
    expect(await svc.resolveActive('slug')).toBeNull();
  });

  it('receive resolves the lead by email, bumps counters and emits the trigger event', async () => {
    const { svc, prisma, outbox } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    const out = await svc.receive(
      { id: 'wh1', workspaceId: WS, slug: 'slug' },
      { email: 'buyer@acme.com', name: 'Buyer' },
    );
    expect(out).toEqual({ received: true, leadId: 'lead-9' });
    // Lead lookup is workspace-scoped.
    expect(prisma.lead.findFirst.mock.calls[0][0].where.workspaceId).toBe(WS);
    expect(prisma.inboundWebhook.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'wh1', workspaceId: WS } }),
    );
    const appended = outbox.append.mock.calls[0][0];
    expect(appended.type).toBe(MarketingEventTypes.WebhookReceived);
    expect(appended.payload).toMatchObject({ workspaceId: WS, leadId: 'lead-9', webhookId: 'wh1' });
    expect(appended.idempotencyKey).toContain('webhook-received:wh1:');
  });

  it('resolves the lead by NORMALIZED email/phone (matches the form/manual path, not just raw)', async () => {
    const { svc, prisma } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-7' });
    await svc.receive(
      { id: 'wh1', workspaceId: WS, slug: 'slug' },
      { email: 'A@Acme.com', phone: '+90 555 111 22 33' },
    );
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    // The normalized keys (indexed) are how every other lead-resolution path
    // matches, so an inbound webhook for an existing contact still attaches the
    // leadId even when the posted phone/email format differs.
    expect(where.OR).toEqual(
      expect.arrayContaining([{ emailNormalized: 'a@acme.com' }, { phoneNormalized: '905551112233' }]),
    );
  });

  it('receive emits with leadId null when nobody matches', async () => {
    const { svc, prisma, outbox } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(null);
    const out = await svc.receive({ id: 'wh1', workspaceId: WS, slug: 'slug' }, { note: 'no contact here' });
    expect(out.leadId).toBeNull();
    // No email/phone in the body → no lead lookup attempted at all.
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(outbox.append.mock.calls[0][0].payload.leadId).toBeNull();
  });

  it('uses a sender-supplied delivery id as the dedup key when present', async () => {
    const { svc, outbox } = makeSvc();
    await svc.receive({ id: 'wh1', workspaceId: WS, slug: 'slug' }, {}, { idempotencyKey: 'delivery-42' });
    expect(outbox.append.mock.calls[0][0].idempotencyKey).toBe('webhook-received:wh1:delivery-42');
  });

  it('hashWebhookSecret is stable and hex', () => {
    const h = hashWebhookSecret('whsec_abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashWebhookSecret('whsec_abc'));
  });
});
