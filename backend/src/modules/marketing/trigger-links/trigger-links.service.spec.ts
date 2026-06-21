import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TriggerLinksService } from './trigger-links.service';
import { MarketingEventTypes } from '../events/marketing-event-types';

const WS = 'ws-1';

function makePrisma() {
  return {
    triggerLink: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    triggerLinkClick: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'click-1' }),
    },
    lead: { findFirst: jest.fn() },
  };
}

describe('TriggerLinksService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let outbox: { append: jest.Mock };
  let svc: TriggerLinksService;

  beforeEach(() => {
    prisma = makePrisma();
    outbox = { append: jest.fn().mockResolvedValue('e') };
    const config = { get: () => 'https://app.test' } as any;
    svc = new TriggerLinksService(prisma as any, outbox as any, config);
  });

  describe('create', () => {
    it('rejects a non-http(s) target', async () => {
      await expect(
        svc.create(WS, { name: 'x', targetUrl: 'javascript:alert(1)' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates with a generated slug + workspaceId and returns the public url', async () => {
      prisma.triggerLink.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 't1', slug: data.slug, ...data }),
      );
      const res = await svc.create(WS, { name: 'Promo', targetUrl: 'https://x.test/promo' });
      const arg = prisma.triggerLink.create.mock.calls[0][0].data;
      expect(arg.workspaceId).toBe(WS);
      expect(arg.slug).toMatch(/^l[0-9a-f]{10}$/);
      expect(res.url).toBe(`https://app.test/api/public/l/${arg.slug}`);
    });
  });

  describe('click', () => {
    it('returns null for an unknown slug (no record, no emit)', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue(null);
      expect(await svc.click('nope')).toBeNull();
      expect(prisma.triggerLinkClick.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('refuses to redirect to a stored non-http(s) target (defense in depth)', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue({ id: 't1', workspaceId: WS, slug: 's', targetUrl: 'data:text/html,x' });
      expect(await svc.click('s')).toBeNull();
    });

    it('records the click, increments, emits link.clicked, returns the target', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue({ id: 't1', workspaceId: WS, slug: 's', targetUrl: 'https://x.test' });
      const target = await svc.click('s', { contactId: undefined, ip: '1.2.3.4' });
      expect(target).toBe('https://x.test');
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.workspaceId).toBe(WS);
      expect(prisma.triggerLink.update.mock.calls[0][0].data.clickCount).toEqual({ increment: 1 });
      const emit = outbox.append.mock.calls[0][0];
      expect(emit.type).toBe(MarketingEventTypes.LinkClicked);
      expect(emit.payload).toMatchObject({ workspaceId: WS, triggerLinkId: 't1', leadId: null });
    });

    it('attributes a click to a lead ONLY when the contact resolves in the link workspace', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue({ id: 't1', workspaceId: WS, slug: 's', targetUrl: 'https://x.test' });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
      await svc.click('s', { contactId: 'lead-9' });
      expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'lead-9', workspaceId: WS });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBe('lead-9');
      expect(outbox.append.mock.calls[0][0].payload.leadId).toBe('lead-9');
    });

    it('coerces a repeated/array ?c= param to no-attribution (no throw, click still recorded)', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue({ id: 't1', workspaceId: WS, slug: 's', targetUrl: 'https://x.test' });
      const target = await svc.click('s', { contactId: ['a', 'b'] as any });
      expect(target).toBe('https://x.test');
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(prisma.triggerLinkClick.create).toHaveBeenCalled();
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBeNull();
    });

    it('drops a contact id that is not in the link workspace (no cross-tenant attribution)', async () => {
      prisma.triggerLink.findUnique.mockResolvedValue({ id: 't1', workspaceId: WS, slug: 's', targetUrl: 'https://x.test' });
      prisma.lead.findFirst.mockResolvedValue(null);
      await svc.click('s', { contactId: 'foreign-lead' });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBeNull();
    });
  });

  describe('remove', () => {
    it('404s a link in another workspace', async () => {
      prisma.triggerLink.findFirst.mockResolvedValue(null);
      await expect(svc.remove(WS, 't1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.triggerLink.delete).not.toHaveBeenCalled();
    });
  });
});
