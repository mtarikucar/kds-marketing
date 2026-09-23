import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TriggerLinksService } from './trigger-links.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { signTriggerLinkContact } from './trigger-link-contact.token';

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
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    lead: { findFirst: jest.fn() },
  };
}

const LINK = { id: 't1', workspaceId: WS, slug: 's', targetUrl: 'https://x.test' };

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
      // No MARKETING_SECRET_KEY here: nothing can MINT a signed ?c= on this
      // deployment either, so the raw id keeps working exactly as it always has.
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

  /**
   * `scanner-clicks`. Safe Links detonating a campaign's links is not a click:
   * it must leave the audit row (that row is the KVKK export/erasure record)
   * and change nothing a human would have caused.
   */
  describe('click — automated hits', () => {
    beforeEach(() => {
      prisma.triggerLink.findUnique.mockResolvedValue({ ...LINK });
    });

    it('still redirects and still records the row', async () => {
      const target = await svc.click('s', { ip: '1.2.3.4', automated: true });
      expect(target).toBe('https://x.test');
      expect(prisma.triggerLinkClick.create).toHaveBeenCalledTimes(1);
    });

    it('does not fire link.clicked', async () => {
      await svc.click('s', { ip: '1.2.3.4', automated: true });
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('does not count the click', async () => {
      await svc.click('s', { ip: '1.2.3.4', automated: true });
      expect(prisma.triggerLink.update).not.toHaveBeenCalled();
    });

    it('still attributes the row to the lead, so the history stays complete', async () => {
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
      await svc.click('s', { contactId: 'lead-9', automated: true });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBe('lead-9');
    });
  });

  /**
   * `trigger-link-throttle`. The click ROW is the analytics truth and is always
   * written; it is the workflow event that must collapse, because
   * workflow-executor has no other dedupe for a leadless enrolment.
   */
  describe('click — burst collapse', () => {
    beforeEach(() => {
      prisma.triggerLink.findUnique.mockResolvedValue({ ...LINK });
    });

    it('gives a burst from one lead ONE idempotency key (the outbox dedupes it)', async () => {
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
      await svc.click('s', { contactId: 'lead-9', ip: '1.2.3.4' });
      await svc.click('s', { contactId: 'lead-9', ip: '9.9.9.9' });
      expect(prisma.triggerLinkClick.create).toHaveBeenCalledTimes(2);
      const [a, b] = outbox.append.mock.calls.map((c) => c[0].idempotencyKey);
      expect(a).toBe(b);
      expect(a).toContain('lead-9');
    });

    it('keys a leadless burst on the client IP', async () => {
      await svc.click('s', { ip: '1.2.3.4' });
      await svc.click('s', { ip: '1.2.3.4' });
      await svc.click('s', { ip: '5.6.7.8' });
      const [a, b, c] = outbox.append.mock.calls.map((x) => x[0].idempotencyKey);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('keeps two different leads apart', async () => {
      prisma.lead.findFirst.mockResolvedValueOnce({ id: 'lead-1' }).mockResolvedValueOnce({ id: 'lead-2' });
      await svc.click('s', { contactId: 'lead-1' });
      await svc.click('s', { contactId: 'lead-2' });
      const [a, b] = outbox.append.mock.calls.map((x) => x[0].idempotencyKey);
      expect(a).not.toBe(b);
    });

    it('keeps two different links apart', async () => {
      prisma.triggerLink.findUnique
        .mockResolvedValueOnce({ ...LINK })
        .mockResolvedValueOnce({ ...LINK, id: 't2', slug: 's2' });
      await svc.click('s', { ip: '1.2.3.4' });
      await svc.click('s2', { ip: '1.2.3.4' });
      const [a, b] = outbox.append.mock.calls.map((x) => x[0].idempotencyKey);
      expect(a).not.toBe(b);
    });
  });

  /**
   * `trigger-link-throttle`. A raw lead id in a query string is a claim anyone
   * who has ever seen one can type — and the claim fires workflows.
   */
  describe('click — signed ?c=', () => {
    const KEY = Buffer.alloc(32, 3).toString('base64');

    beforeEach(() => {
      process.env.MARKETING_SECRET_KEY = KEY;
      prisma.triggerLink.findUnique.mockResolvedValue({ ...LINK });
      prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    });
    afterEach(() => {
      delete process.env.MARKETING_SECRET_KEY;
    });

    it('attributes a signed token', async () => {
      await svc.click('s', { contactId: signTriggerLinkContact(WS, 'lead-9')! });
      expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'lead-9', workspaceId: WS });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBe('lead-9');
    });

    it('ignores an unsigned raw lead id — no lookup, no attribution, click still recorded', async () => {
      const target = await svc.click('s', { contactId: 'lead-9' });
      expect(target).toBe('https://x.test');
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBeNull();
      expect(outbox.append.mock.calls[0][0].payload.leadId).toBeNull();
    });

    it('ignores a token minted for another workspace', async () => {
      await svc.click('s', { contactId: signTriggerLinkContact('ws-other', 'lead-9')! });
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBeNull();
    });

    it('still scopes the lead lookup to the link workspace (belt and braces)', async () => {
      prisma.lead.findFirst.mockResolvedValue(null); // lead deleted / moved
      await svc.click('s', { contactId: signTriggerLinkContact(WS, 'lead-9')! });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBeNull();
    });

    it('mints the signed param on publicUrl', async () => {
      const url = svc.publicUrl('s', { workspaceId: WS, leadId: 'lead-9' });
      expect(url).toMatch(/^https:\/\/app\.test\/api\/public\/l\/s\?c=/);
      // Round-trips through click, so what we print is what we accept.
      const token = new URL(url).searchParams.get('c')!;
      await svc.click('s', { contactId: token });
      expect(prisma.triggerLinkClick.create.mock.calls[0][0].data.leadId).toBe('lead-9');
    });

    it('omits ?c= rather than emitting an unsigned one when there is no lead', () => {
      expect(svc.publicUrl('s')).toBe('https://app.test/api/public/l/s');
    });
  });

  describe('stats', () => {
    it('separates human clicks from recorded machine hits without a new column', async () => {
      prisma.triggerLink.findFirst.mockResolvedValue({ ...LINK, clickCount: 12 });
      prisma.triggerLinkClick.count.mockResolvedValue(30);
      const res = await svc.stats(WS, 't1');
      expect(res.clickCount).toBe(12);
      expect(res.totalClicks).toBe(30);
      expect(res.botCount).toBe(18);
    });

    it('never reports a negative bot count when the cache ran ahead', async () => {
      prisma.triggerLink.findFirst.mockResolvedValue({ ...LINK, clickCount: 5 });
      prisma.triggerLinkClick.count.mockResolvedValue(3);
      const res = await svc.stats(WS, 't1');
      expect(res.botCount).toBe(0);
    });
  });

  /**
   * `clickCount` CHANGED MEANING and nothing on the page said so.
   *
   * It is now the HUMAN counter: a mail-security scanner sweeping the links no
   * longer bumps it. For a tenant with no scanner traffic the number is exactly
   * what it was; for everyone else it went down overnight, and A5.1 says a
   * tenant must be able to see why. The list is the only surface that renders
   * these links, so the list is where the answer has to be.
   */
  describe('list — the filtered clicks are visible', () => {
    it('carries the raw total and the machine share beside the human count', async () => {
      prisma.triggerLink.findMany.mockResolvedValue([
        { ...LINK, id: 't1', clickCount: 7 },
        { ...LINK, id: 't2', slug: 's2', clickCount: 0 },
      ] as any);
      prisma.triggerLinkClick.groupBy.mockResolvedValue([
        { triggerLinkId: 't1', _count: { _all: 11 } },
        { triggerLinkId: 't2', _count: { _all: 3 } },
      ] as any);

      const rows: any[] = await svc.list(WS);

      expect(prisma.triggerLinkClick.groupBy.mock.calls[0][0]).toMatchObject({
        where: { workspaceId: WS, triggerLinkId: { in: ['t1', 't2'] } },
      });
      expect(rows[0]).toMatchObject({ clickCount: 7, totalClicks: 11, botCount: 4 });
      expect(rows[1]).toMatchObject({ clickCount: 0, totalClicks: 3, botCount: 3 });
    });

    it('never reports a negative machine share', async () => {
      // A counter bumped by a path that wrote no row (or a row purged by
      // retention) would otherwise produce a negative, which reads as nonsense.
      prisma.triggerLink.findMany.mockResolvedValue([{ ...LINK, clickCount: 9 }] as any);
      prisma.triggerLinkClick.groupBy.mockResolvedValue([
        { triggerLinkId: 't1', _count: { _all: 2 } },
      ] as any);

      expect((await svc.list(WS))[0]).toMatchObject({ totalClicks: 2, botCount: 0 });
    });

    it('asks for nothing when the workspace has no links', async () => {
      prisma.triggerLink.findMany.mockResolvedValue([] as any);
      expect(await svc.list(WS)).toEqual([]);
      // An `in: []` would be a full-table scan wearing a filter.
      expect(prisma.triggerLinkClick.groupBy).not.toHaveBeenCalled();
    });

    it('survives a counting read that fails, rather than emptying the page', async () => {
      prisma.triggerLink.findMany.mockResolvedValue([{ ...LINK, clickCount: 4 }] as any);
      prisma.triggerLinkClick.groupBy.mockRejectedValue(new Error('db down'));

      const rows: any[] = await svc.list(WS);
      expect(rows[0]).toMatchObject({ clickCount: 4 });
      // Unknown, not zero: "0 filtered" is a claim, and we cannot make it.
      expect(rows[0].botCount).toBeNull();
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
