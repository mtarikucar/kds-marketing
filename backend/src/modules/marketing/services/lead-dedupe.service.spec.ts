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

// merge() reads each collision-keyed child's canonical rows via findMany; default
// them to empty so a happy-path merge doesn't choke on an unmocked delegate.
function mockCollisionTablesEmpty(prisma: MockPrismaClient) {
  for (const t of ['enrollment', 'customObjectLink', 'communityMember', 'earnedBadge', 'certificate', 'pointsLedger'] as const) {
    (prisma as any)[t].findMany.mockResolvedValue([]);
  }
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

  // "Active" must mean NOT merged AND NOT soft-deleted. A bulk-deleted/archived
  // lead sharing a phone/email would otherwise cluster with live leads and get
  // suggested for merge — re-surfacing (or merging a live lead INTO) a hidden,
  // deleted record. Same dedup-soft-deleted class as forms/booking/import.
  it('excludes soft-deleted leads from dedup clustering', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([] as any);
    await svc.findDuplicates(WS);
    const where = (prisma.lead.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: WS, mergedIntoId: null, deletedAt: null });
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
    mockCollisionTablesEmpty(prisma);
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

  it('carries a per-channel opt-out from a duplicate onto the canonical (never re-subscribes)', async () => {
    const { prisma, svc } = makeSvc();
    // The canonical is still subscribed; the duplicate had unsubscribed from email
    // + WhatsApp. The merge must NOT drop those opt-outs — the campaign audience +
    // send-time guard read them off the canonical, so losing them resumes mailing
    // an unsubscribed contact (a consent violation).
    const subCanon = { ...canonical, emailOptOut: false, smsOptOut: false, waOptOut: false };
    const optedOutDup = { ...dup, emailOptOut: true, smsOptOut: false, waOptOut: true };
    prisma.lead.findMany.mockResolvedValue([subCanon, optedOutDup] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([] as any);
    mockCollisionTablesEmpty(prisma);
    (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });

    await svc.merge(WS, 'a', ['b']);

    const updArg = (prisma.lead.update as jest.Mock).mock.calls[0][0];
    expect(updArg.data.emailOptOut).toBe(true);
    expect(updArg.data.waOptOut).toBe(true);
    // sms: neither lead opted out → not forced (stays its default; not written).
    expect(updArg.data.smsOptOut).toBeUndefined();
  });

  it('re-parents the lead-owned business records too (deals, documents, estimates, consent, ...)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([canonical, dup] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([] as any);
    mockCollisionTablesEmpty(prisma);
    (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });

    await svc.merge(WS, 'a', ['b']);

    // These 1:N children were previously NOT re-parented, so a merge orphaned the
    // dup's deals/documents/estimates/etc. on the tombstoned (query-hidden) row.
    for (const delegate of [
      'opportunity', 'document', 'estimate', 'triggerLinkClick', 'dialSessionItem',
      'dataRequest', 'surveyResponse', 'consentRecord', 'customerSubscription', 'couponRedemption',
    ]) {
      expect((prisma as any)[delegate].updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { leadId: { in: ['b'] } }, data: { leadId: 'a' } }),
      );
    }
  });

  it('re-parents collision-keyed children with the dedup dance (enrollment, badges, certs, ...)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([canonical, dup] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([] as any);
    mockCollisionTablesEmpty(prisma);
    // Canonical already owns course c1 (enrollment + certificate), so the dup's
    // rows on c1 must be DROPPED (not moved → P2002), and the rest re-parented.
    prisma.enrollment.findMany.mockResolvedValue([{ courseId: 'c1' }] as any);
    prisma.certificate.findMany.mockResolvedValue([{ courseId: 'c1' }] as any);
    (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });

    await svc.merge(WS, 'a', ['b']);

    // collision drop on the shared course, then re-parent the survivors
    expect(prisma.enrollment.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { leadId: { in: ['b'] }, courseId: { in: ['c1'] } } }),
    );
    expect(prisma.enrollment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ leadId: { in: ['b'] } }), data: { leadId: 'a' } }),
    );
    // certificate's unique includes workspaceId — the dedup is workspace-scoped
    expect(prisma.certificate.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ leadId: { in: ['b'] }, courseId: { in: ['c1'] }, workspaceId: WS }) }),
    );
    // a collision-keyed table with NO canonical overlap re-parents without a delete
    expect(prisma.communityMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ leadId: { in: ['b'] } }), data: { leadId: 'a' } }),
    );
    expect(prisma.communityMember.deleteMany).not.toHaveBeenCalled();
  });

  it('dedups pointsLedger on the composite source+refId key, then re-parents the rest', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([canonical, dup] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    prisma.campaignRecipient.findMany.mockResolvedValue([] as any);
    mockCollisionTablesEmpty(prisma);
    // canonical already earned points for lesson l1 → the dup's same award must be
    // dropped (not moved → P2002), and any other awards re-parented.
    prisma.pointsLedger.findMany.mockResolvedValue([{ source: 'LESSON_COMPLETE', refId: 'l1' }] as any);
    (prisma.lead.updateMany as any).mockResolvedValue({ count: 1 });

    await svc.merge(WS, 'a', ['b']);

    expect(prisma.pointsLedger.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leadId: { in: ['b'] },
          workspaceId: WS,
          OR: [{ source: 'LESSON_COMPLETE', refId: 'l1' }],
        }),
      }),
    );
    expect(prisma.pointsLedger.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ leadId: { in: ['b'] }, workspaceId: WS }), data: { leadId: 'a' } }),
    );
  });

  it('refuses to merge when a duplicate holds a non-zero wallet balance (no silent money loss)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([canonical, dup] as any);
    prisma.customerWallet.findFirst.mockResolvedValue({ id: 'w1' } as any);
    await expect(svc.merge(WS, 'a', ['b'])).rejects.toBeInstanceOf(ConflictException);
    // guard fires before any re-parenting work
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
