import 'reflect-metadata';
import { PackagesAdminController } from './packages-admin.controller';
import { PlatformGuard } from '../guards/platform.guard';
import { PlatformModule } from '../platform.module';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

/** Prisma Decimal stand-in: what the driver actually hands back for money columns. */
class Dec {
  constructor(private readonly v: string) {}
  toString() {
    return this.v;
  }
  valueOf() {
    return Number(this.v);
  }
}

function makeCtrl(rows: any[]) {
  const prisma: any = {
    package: { findMany: jest.fn().mockResolvedValue(rows) },
  };
  return { prisma, ctrl: new PackagesAdminController(prisma) };
}

const GROWTH = {
  code: 'GROWTH',
  name: 'Growth',
  description: 'For growing teams.',
  isPublic: true,
  sortOrder: 2,
  trialDays: 0,
  dailyLeadQuota: 50,
  maxUsers: 10,
  maxResearchProfiles: 3,
  limits: { aiCreditsMonthly: 5000, maxAgents: 3 },
  priceMonthlyTRY: new Dec('2400.00'),
  priceMonthlyUSD: new Dec('79.00'),
  priceYearlyTRY: new Dec('24000.00'),
  priceYearlyUSD: null,
};

const OPERATOR = {
  code: 'OPERATOR',
  name: 'Operator (internal)',
  description: 'Unlimited internal package for the platform-owner workspace.',
  isPublic: false,
  sortOrder: 9,
  trialDays: 0,
  dailyLeadQuota: -1,
  maxUsers: -1,
  maxResearchProfiles: -1,
  limits: null,
  priceMonthlyTRY: new Dec('0'),
  priceMonthlyUSD: new Dec('0'),
  priceYearlyTRY: null,
  priceYearlyUSD: null,
};

describe('PackagesAdminController — GET /platform/packages', () => {
  it('sits behind PlatformGuard (this catalog exposes non-public packages)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PackagesAdminController);
    expect(guards).toContain(PlatformGuard);
  });

  it('is registered on PlatformModule at platform/packages (an unwired controller is unreachable)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PackagesAdminController)).toBe(
      'platform/packages',
    );
    const controllers = Reflect.getMetadata('controllers', PlatformModule) ?? [];
    expect(controllers).toContain(PackagesAdminController);
  });

  it('lists only ACTIVE packages, in catalog order', async () => {
    const { prisma, ctrl } = makeCtrl([GROWTH, OPERATOR]);
    const res = await ctrl.list();

    expect(prisma.package.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'ACTIVE' },
        orderBy: { sortOrder: 'asc' },
      }),
    );
    expect(res.map((p) => p.code)).toEqual(['GROWTH', 'OPERATOR']);
  });

  it('keeps the non-public internal packages the marketing catalog hides', async () => {
    // The whole reason this route exists: BillingService.listPackages() filters
    // isPublic:true, which would drop the one package this console grants.
    const { ctrl } = makeCtrl([GROWTH, OPERATOR]);
    const res = await ctrl.list();

    const operator = res.find((p) => p.code === 'OPERATOR');
    expect(operator).toBeDefined();
    expect(operator!.isPublic).toBe(false);
    expect(res.find((p) => p.code === 'GROWTH')!.isPublic).toBe(true);
  });

  it('returns prices as numbers, not Prisma Decimals (null yearly stays null)', async () => {
    const { ctrl } = makeCtrl([GROWTH]);
    const [growth] = await ctrl.list();

    expect(growth.prices).toEqual({
      monthlyTRY: 2400,
      monthlyUSD: 79,
      yearlyTRY: 24000,
      yearlyUSD: null,
    });
    expect(typeof growth.prices.monthlyUSD).toBe('number');
  });

  it('folds plan quotas + the limits JSON into one summary (like the assignment result)', async () => {
    const { ctrl } = makeCtrl([GROWTH, OPERATOR]);
    const [growth, operator] = await ctrl.list();

    expect(growth.limits).toEqual({
      dailyLeadQuota: 50,
      maxUsers: 10,
      maxResearchProfiles: 3,
      aiCreditsMonthly: 5000,
      maxAgents: 3,
    });
    // A null limits JSON must not blow up the spread.
    expect(operator.limits).toEqual({
      dailyLeadQuota: -1,
      maxUsers: -1,
      maxResearchProfiles: -1,
    });
  });
});
