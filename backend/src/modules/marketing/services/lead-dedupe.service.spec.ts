import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LeadDedupeService } from './lead-dedupe.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const outbox = { append: jest.fn().mockResolvedValue('ob-1') };
  // run $transaction callbacks against the same mock
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  const svc = new LeadDedupeService(prisma as any, outbox as any);
  return { prisma, outbox, svc };
}

describe('LeadDedupeService.findDuplicates', () => {
  it('clusters leads sharing a normalized phone or email and suggests the oldest as canonical', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([
      { id: 'a', phoneNormalized: '5551234', emailNormalized: 'x@y.com', createdAt: new Date('2026-01-01'), convertedTenantId: null, businessName: 'A' },
      { id: 'b', phoneNormalized: '5551234', emailNormalized: null, createdAt: new Date('2026-02-01'), convertedTenantId: null, businessName: 'B' },
      { id: 'c', phoneNormalized: '9999', emailNormalized: null, createdAt: new Date('2026-03-01'), convertedTenantId: null, businessName: 'C' },
    ] as any);

    const clusters = await svc.findDuplicates(WS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].suggestedCanonicalId).toBe('a');
    expect(clusters[0].leads.map((l: any) => l.id).sort()).toEqual(['a', 'b']);
  });

  it('prefers a converted lead as the suggested canonical', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([
      { id: 'a', phoneNormalized: '111', emailNormalized: null, createdAt: new Date('2026-01-01'), convertedTenantId: null },
      { id: 'b', phoneNormalized: '111', emailNormalized: null, createdAt: new Date('2026-02-01'), convertedTenantId: 'tenant-9' },
    ] as any);
    const clusters = await svc.findDuplicates(WS);
    expect(clusters[0].suggestedCanonicalId).toBe('b');
  });
});

describe('LeadDedupeService.merge', () => {
  const canonical = { id: 'a', workspaceId: WS, customFields: { tier: 'gold' }, phone: '111', email: null, city: null, mergedIntoId: null, convertedTenantId: null };
  const dup = { id: 'b', workspaceId: WS, customFields: { budget: 500 }, phone: null, email: 'b@x.com', city: 'Ankara', mergedIntoId: null, convertedTenantId: null };

  it('rejects when the canonical is in the duplicate list', async () => {
    const { svc } = makeSvc();
    await expect(svc.merge(WS, 'a', ['a'])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the canonical is missing', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([dup] as any);
    await expect(svc.merge(WS, 'a', ['b'])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to merge a converted lead as a duplicate', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([
      canonical,
      { ...dup, convertedTenantId: 'tenant-9' },
    ] as any);
    await expect(svc.merge(WS, 'a', ['b'])).rejects.toBeInstanceOf(ConflictException);
  });

  it('is a no-op when the duplicates are already merged', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([
      canonical,
      { ...dup, mergedIntoId: 'a' },
    ] as any);
    const res = await svc.merge(WS, 'a', ['b']);
    expect(res).toEqual({ canonicalId: 'a', merged: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('re-parents children, unions customFields, tombstones the dup, and emits an event', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([canonical, dup] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([] as any);
    // The tombstone updateMany now claims convertedTenantId:null and asserts the
    // count matches the dup count (TOCTOU guard) — return the 1 dup it touched.
    (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });

    const res = await svc.merge(WS, 'a', ['b']);

    expect(res).toEqual({ canonicalId: 'a', merged: 1 });
    // a representative child re-parent happened
    expect(prisma.leadActivity.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: { in: ['b'] } }, data: { leadId: 'a' } }),
    );
    // canonical updated with the unioned custom fields (canonical wins per key)
    const updArg = (prisma.lead.update as jest.Mock).mock.calls[0][0];
    expect(updArg.data.customFields).toEqual({ budget: 500, tier: 'gold' });
    // blank canonical city filled from the dup
    expect(updArg.data.city).toBe('Ankara');
    // dup tombstoned, scoped by workspace
    expect(prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['b'] }, workspaceId: WS, convertedTenantId: null },
        data: expect.objectContaining({ mergedIntoId: 'a' }),
      }),
    );
    expect((outbox.append as jest.Mock).mock.calls[0][0]).toMatchObject({
      type: 'marketing.lead.merged.v1',
      payload: { canonicalId: 'a', mergedIds: ['b'], workspaceId: WS },
    });
  });
});
