import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../../prisma/prisma.service';
import { AffiliateService } from './affiliate.service';

function makeSvc() {
  const prisma = mockDeep<PrismaService>();
  // $transaction: execute callback with the mocked prisma as the tx
  (prisma.$transaction as jest.Mock).mockImplementation(
    (fn: (tx: any) => Promise<any>) => fn(prisma),
  );
  const svc = new AffiliateService(prisma as any);
  return { prisma, svc };
}

const WS_A = 'ws-a';
const WS_B = 'ws-b';

const mockAffiliate = (overrides: Record<string, unknown> = {}) => ({
  id: 'aff-1',
  workspaceId: WS_A,
  name: 'Alice Affiliate',
  email: 'alice@example.com',
  code: 'ALICE10',
  commissionType: 'PERCENT',
  commissionValue: new Prisma.Decimal('10.00'),
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockReferral = (overrides: Record<string, unknown> = {}) => ({
  id: 'ref-1',
  workspaceId: WS_A,
  affiliateId: 'aff-1',
  referredLeadId: null,
  status: 'PENDING',
  convertedAt: null,
  createdAt: new Date(),
  affiliate: mockAffiliate(),
  ...overrides,
});

// ─── Commission math ──────────────────────────────────────────────────────────

describe('AffiliateService — commission math', () => {
  it('PERCENT: 10% of 1000 = 100.00', async () => {
    const { prisma, svc } = makeSvc();

    const affiliate = mockAffiliate({ commissionType: 'PERCENT', commissionValue: new Prisma.Decimal('10.00') });
    const referral = mockReferral({ affiliate });

    prisma.affiliateReferral.findFirst.mockResolvedValue(referral as never);
    prisma.affiliateReferral.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.affiliateReferral.findUniqueOrThrow.mockResolvedValue({ ...referral, status: 'CONVERTED' } as never);

    let capturedAmount: Prisma.Decimal | undefined;
    prisma.affiliateCommission.create.mockImplementation((args: any) => {
      capturedAmount = args.data.amount;
      return Promise.resolve({
        id: 'com-1',
        workspaceId: WS_A,
        affiliateId: 'aff-1',
        referralId: 'ref-1',
        amount: args.data.amount,
        status: 'OWED',
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never;
    });

    await svc.convertReferral(WS_A, 'ref-1', 1000);

    expect(capturedAmount).toBeDefined();
    expect(capturedAmount!.toFixed(2)).toBe('100.00');
  });

  it('PERCENT: clamps a >100% commission to 100% (no over-payout)', async () => {
    const { prisma, svc } = makeSvc();
    const affiliate = mockAffiliate({ commissionType: 'PERCENT', commissionValue: new Prisma.Decimal('5000') });
    const referral = mockReferral({ affiliate });
    prisma.affiliateReferral.findFirst.mockResolvedValue(referral as never);
    prisma.affiliateReferral.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.affiliateReferral.findUniqueOrThrow.mockResolvedValue({ ...referral, status: 'CONVERTED' } as never);
    let captured: Prisma.Decimal | undefined;
    prisma.affiliateCommission.create.mockImplementation((args: any) => {
      captured = args.data.amount;
      return Promise.resolve({ id: 'com-1', amount: args.data.amount }) as never;
    });

    await svc.convertReferral(WS_A, 'ref-1', 1000);

    // 5000% would be 50000; clamped to 100% → 1000.00
    expect(captured!.toFixed(2)).toBe('1000.00');
  });

  it('createAffiliate rejects a PERCENT commission above 100%', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.createAffiliate(WS_A, { name: 'X', email: 'x@x.com', code: 'X1', commissionType: 'PERCENT', commissionValue: 150 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // The commission-range guard must validate the EFFECTIVE (type, value) pair on
  // update — switching a FLAT-5000 affiliate to PERCENT while OMITTING the value
  // leaves the stored 5000 as a 5000% rate, which createAffiliate forbids. The old
  // guard validated the raw (dto.commissionValue = undefined) and short-circuited.
  it('updateAffiliate rejects switching to PERCENT when the retained value exceeds 100%', async () => {
    const { prisma, svc } = makeSvc();
    prisma.affiliate.findFirst.mockResolvedValue(
      mockAffiliate({ commissionType: 'FLAT', commissionValue: new Prisma.Decimal('5000') }) as never,
    );
    await expect(
      svc.updateAffiliate(WS_A, 'aff-1', { commissionType: 'PERCENT' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.affiliate.update).not.toHaveBeenCalled();
  });

  it('updateAffiliate allows switching to PERCENT with a valid value', async () => {
    const { prisma, svc } = makeSvc();
    prisma.affiliate.findFirst.mockResolvedValue(
      mockAffiliate({ commissionType: 'FLAT', commissionValue: new Prisma.Decimal('5000') }) as never,
    );
    prisma.affiliate.update.mockResolvedValue({ id: 'aff-1' } as never);
    await svc.updateAffiliate(WS_A, 'aff-1', { commissionType: 'PERCENT', commissionValue: 50 } as never);
    expect(prisma.affiliate.update).toHaveBeenCalled();
  });

  it('updateAffiliate does not spuriously reject a non-commission edit on a high FLAT value', async () => {
    const { prisma, svc } = makeSvc();
    prisma.affiliate.findFirst.mockResolvedValue(
      mockAffiliate({ commissionType: 'FLAT', commissionValue: new Prisma.Decimal('5000') }) as never,
    );
    prisma.affiliate.update.mockResolvedValue({ id: 'aff-1' } as never);
    await svc.updateAffiliate(WS_A, 'aff-1', { name: 'New Name' } as never);
    expect(prisma.affiliate.update).toHaveBeenCalled();
  });

  // TOCTOU: two concurrent same-code creates both pass the findFirst pre-check;
  // the 2nd insert trips the (workspaceId, code) unique → P2002. Map to a 409.
  it('createAffiliate maps a P2002 race on code to a 409', async () => {
    const { prisma, svc } = makeSvc();
    prisma.affiliate.findFirst.mockResolvedValue(null as never); // pre-check passes
    prisma.affiliate.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) as never,
    );
    await expect(
      svc.createAffiliate(WS_A, { name: 'X', email: 'x@x.com', code: 'X1', commissionType: 'PERCENT', commissionValue: 10 } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('FLAT: flat 50 regardless of conversion value', async () => {
    const { prisma, svc } = makeSvc();

    const affiliate = mockAffiliate({ commissionType: 'FLAT', commissionValue: new Prisma.Decimal('50.00') });
    const referral = mockReferral({ affiliate });

    prisma.affiliateReferral.findFirst.mockResolvedValue(referral as never);
    prisma.affiliateReferral.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.affiliateReferral.findUniqueOrThrow.mockResolvedValue({ ...referral, status: 'CONVERTED' } as never);

    let capturedAmount: Prisma.Decimal | undefined;
    prisma.affiliateCommission.create.mockImplementation((args: any) => {
      capturedAmount = args.data.amount;
      return Promise.resolve({
        id: 'com-2',
        workspaceId: WS_A,
        affiliateId: 'aff-1',
        referralId: 'ref-1',
        amount: args.data.amount,
        status: 'OWED',
        createdAt: new Date(),
        updatedAt: new Date(),
      }) as never;
    });

    await svc.convertReferral(WS_A, 'ref-1', 1000);

    expect(capturedAmount).toBeDefined();
    expect(capturedAmount!.toFixed(2)).toBe('50.00');
  });
});

// ─── convertReferral creates OWED commission ──────────────────────────────────

describe('AffiliateService — convertReferral', () => {
  it('creates an OWED commission row on successful conversion', async () => {
    const { prisma, svc } = makeSvc();

    const affiliate = mockAffiliate({ commissionType: 'FLAT', commissionValue: new Prisma.Decimal('25.00') });
    const referral = mockReferral({ affiliate });

    prisma.affiliateReferral.findFirst.mockResolvedValue(referral as never);
    prisma.affiliateReferral.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.affiliateReferral.findUniqueOrThrow.mockResolvedValue({ ...referral, status: 'CONVERTED' } as never);
    prisma.affiliateCommission.create.mockResolvedValue({
      id: 'com-3',
      status: 'OWED',
      amount: new Prisma.Decimal('25.00'),
    } as never);

    const result = await svc.convertReferral(WS_A, 'ref-1', 500);

    expect(prisma.affiliateCommission.create).toHaveBeenCalledTimes(1);
    const createCall = (prisma.affiliateCommission.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.status).toBe('OWED');
    expect(createCall.data.workspaceId).toBe(WS_A);
    expect(result.commission.status).toBe('OWED');
  });

  it('throws 400 if referral is already converted', async () => {
    const { prisma, svc } = makeSvc();

    const affiliate = mockAffiliate();
    const referral = mockReferral({ status: 'CONVERTED', affiliate });

    prisma.affiliateReferral.findFirst.mockResolvedValue(referral as never);

    await expect(svc.convertReferral(WS_A, 'ref-1', 1000)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ─── Cross-workspace isolation ────────────────────────────────────────────────

describe('AffiliateService — cross-workspace isolation', () => {
  it('affiliate of ws-A is not visible when queried with ws-B workspaceId', async () => {
    const { prisma, svc } = makeSvc();

    // Simulate DB returning null when workspaceId doesn't match
    prisma.affiliate.findFirst.mockResolvedValue(null as never);

    await expect(svc.getAffiliate(WS_B, 'aff-1')).rejects.toBeInstanceOf(NotFoundException);

    // Verify workspaceId was passed in the where clause
    expect(prisma.affiliate.findFirst).toHaveBeenCalledWith({
      where: { id: 'aff-1', workspaceId: WS_B },
    });
  });

  it('recordReferral with wrong workspaceId returns 404', async () => {
    const { prisma, svc } = makeSvc();

    // Code exists in WS_A but not in WS_B
    prisma.affiliate.findFirst.mockResolvedValue(null as never);

    await expect(svc.recordReferral(WS_B, 'ALICE10')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.affiliate.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: WS_B, code: 'ALICE10' },
    });
  });

  describe('portal (Epic 11a)', () => {
    it('regeneratePortalToken mints an aff_ token and stores only its hash', async () => {
      const { prisma, svc } = makeSvc();
      prisma.affiliate.findFirst.mockResolvedValue(mockAffiliate() as never);
      (prisma.affiliate.update as jest.Mock).mockResolvedValue({} as never);
      const { token } = await svc.regeneratePortalToken(WS_A, 'aff-1');
      expect(token).toMatch(/^aff_[0-9a-f]{48}$/);
      const data = (prisma.affiliate.update as jest.Mock).mock.calls[0][0].data;
      expect(data.portalTokenHash).toHaveLength(64); // sha256 hex
      expect(data.portalTokenHash).not.toContain(token); // raw never stored
    });

    it('regeneratePortalToken 404s an affiliate from another workspace', async () => {
      const { prisma, svc } = makeSvc();
      prisma.affiliate.findFirst.mockResolvedValue(null as never);
      await expect(svc.regeneratePortalToken(WS_B, 'aff-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.affiliate.update).not.toHaveBeenCalled();
    });

    it('portalSummary returns scoped profile + referral/commission rollups', async () => {
      const { prisma, svc } = makeSvc();
      prisma.affiliate.findFirst.mockResolvedValue({ id: 'aff-1', name: 'Alice', code: 'ALICE10', status: 'ACTIVE' } as never);
      (prisma.affiliateReferral.groupBy as any).mockResolvedValue([
        { status: 'PENDING', _count: { _all: 3 } },
        { status: 'CONVERTED', _count: { _all: 2 } },
      ]);
      (prisma.affiliateCommission.groupBy as any).mockResolvedValue([
        { status: 'OWED', _sum: { amount: new Prisma.Decimal('40.00') } },
        { status: 'PAID', _sum: { amount: new Prisma.Decimal('120.00') } },
      ]);
      const out = await svc.portalSummary(WS_A, 'aff-1');
      expect(out.referrals).toEqual({ PENDING: 3, CONVERTED: 2 });
      expect(out.commissions).toEqual({ OWED: '40', PAID: '120' });
      expect((prisma.affiliateReferral.groupBy as any).mock.calls[0][0].where).toEqual({ workspaceId: WS_A, affiliateId: 'aff-1' });
      expect((prisma.affiliateCommission.groupBy as any).mock.calls[0][0].where).toEqual({ workspaceId: WS_A, affiliateId: 'aff-1' });
    });

    it('portalSummary 404s an unknown affiliate', async () => {
      const { prisma, svc } = makeSvc();
      prisma.affiliate.findFirst.mockResolvedValue(null as never);
      await expect(svc.portalSummary(WS_A, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
