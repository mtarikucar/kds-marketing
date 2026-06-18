import {
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from './agency.service';
import {
  RebillingService,
  REBILLED_USAGE_METRICS,
  monthKeysInRange,
} from './rebilling.service';
import { AI_CREDITS_METRIC } from '../ai/ai-credits.service';
import { MESSAGES_METRIC } from '../channels/message-quota.service';

/**
 * Epic D1 — agency REBILLING / SaaS-mode unit specs (no database).
 *
 * Proves:
 *  - plan CRUD is scoped to the agency's OWN children — assertAgencyOwns gates every
 *    location reference, so a foreign location 404s (cross-agency isolation);
 *  - computeCharge math is correct: base + meteredUnits × unitPrice × (1 + markup/100),
 *    rounded to Decimal(10,2) TRY; and it persists a DRAFT;
 *  - computeCharge meters REAL usage from the EXISTING source — it aggregates the
 *    `UsageCounter` table for the location, on the `ai.credits` + `messages.sent`
 *    metrics, over the months the period spans (asserted on a seeded scenario);
 *  - chargeViaStripeConnect is INERT when the env is unset (charge stays DRAFT, clean
 *    error, NO Stripe call), idempotent (already-settled charges aren't re-charged),
 *    and — when configured — charges the location's connected account and flips to PAID;
 *  - the EXISTING customer billing flow is untouched: this service references none of
 *    its delegates (paymentOrder / workspaceSubscription / package / invoice).
 */

const AGENCY_A = 'agency-a';
const AGENCY_B = 'agency-b';
const LOCATION_A1 = 'loc-a1';
const FOREIGN_LOC = 'loc-foreign';

function makeSvc(configOver: Record<string, string | undefined> = {}) {
  const prisma = mockDeep<PrismaService>();
  const agency = mockDeep<AgencyService>();
  const config = {
    get: (key: string) => configOver[key],
  } as unknown as ConfigService;

  // By default assertAgencyOwns RESOLVES (the location is owned). Specific tests
  // override it to reject a foreign location.
  (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 } as never);

  const svc = new RebillingService(prisma as any, agency as any, config);
  return { prisma, agency, svc };
}

describe('monthKeysInRange', () => {
  it('returns every UTC month the half-open window touches', () => {
    expect(
      monthKeysInRange(new Date('2026-01-15T00:00:00Z'), new Date('2026-03-10T00:00:00Z')),
    ).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('a window fully inside one month yields that single month', () => {
    expect(
      monthKeysInRange(new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z')),
    ).toEqual(['2026-06']);
  });

  it('rejects an empty/inverted range', () => {
    expect(() =>
      monthKeysInRange(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z')),
    ).toThrow(BadRequestException);
    expect(() =>
      monthKeysInRange(new Date('2026-03-02T00:00:00Z'), new Date('2026-03-01T00:00:00Z')),
    ).toThrow(BadRequestException);
  });
});

describe('RebillingService — plan CRUD (scoped to agency children)', () => {
  it('upsertPlan asserts agency ownership FIRST and upserts by (agency, location)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (prisma.rebillingPlan.upsert as jest.Mock).mockResolvedValue({
      id: 'plan-1',
      workspaceId: AGENCY_A,
      locationWorkspaceId: LOCATION_A1,
    } as never);

    await svc.upsertPlan(AGENCY_A, LOCATION_A1, {
      basePrice: '100.00',
      usageUnitPrice: '1.50',
      markupPercent: '20',
    });

    expect(agency.assertAgencyOwns).toHaveBeenCalledWith(AGENCY_A, LOCATION_A1);
    const arg = (prisma.rebillingPlan.upsert as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId_locationWorkspaceId).toEqual({
      workspaceId: AGENCY_A,
      locationWorkspaceId: LOCATION_A1,
    });
    expect(arg.create.workspaceId).toBe(AGENCY_A);
    // Money is coerced to Decimal(10,2).
    expect(new Prisma.Decimal(arg.create.basePrice).toFixed(2)).toBe('100.00');
    expect(new Prisma.Decimal(arg.create.markupPercent).toFixed(2)).toBe('20.00');
  });

  it('upsertPlan rejects a foreign location (cross-agency isolation → 404)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockRejectedValue(
      new NotFoundException('Location not found in this agency'),
    );

    await expect(
      svc.upsertPlan(AGENCY_B, FOREIGN_LOC, {
        basePrice: '10',
        usageUnitPrice: '1',
        markupPercent: '0',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.rebillingPlan.upsert).not.toHaveBeenCalled();
  });

  it('upsertPlan rejects negative money', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.upsertPlan(AGENCY_A, LOCATION_A1, {
        basePrice: '-5',
        usageUnitPrice: '1',
        markupPercent: '0',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listPlans is scoped to the calling agency', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.rebillingPlan.findMany as jest.Mock).mockResolvedValue([] as never);
    await svc.listPlans(AGENCY_A);
    const arg = (prisma.rebillingPlan.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId).toBe(AGENCY_A);
  });

  it('getPlan 404s when no plan exists for an owned location', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue(null as never);
    await expect(svc.getPlan(AGENCY_A, LOCATION_A1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RebillingService — computeCharge (REAL usage metering + math)', () => {
  const plan = {
    id: 'plan-1',
    workspaceId: AGENCY_A,
    locationWorkspaceId: LOCATION_A1,
    basePrice: new Prisma.Decimal('100.00'),
    usageUnitPrice: new Prisma.Decimal('2.00'),
    markupPercent: new Prisma.Decimal('25'), // 25% markup
    enabled: true,
  };

  it('meters REAL usage from UsageCounter (ai.credits + messages.sent) and computes base + usage×(1+markup)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue(plan as never);
    // 40 metered units across the location's real usage counters.
    (prisma.usageCounter.aggregate as jest.Mock).mockResolvedValue({
      _sum: { value: 40 },
    } as never);
    (prisma.rebillCharge.create as jest.Mock).mockImplementation(
      (args: any) => Promise.resolve({ id: 'charge-1', ...args.data }) as never,
    );

    const periodStart = new Date('2026-05-01T00:00:00Z');
    const periodEnd = new Date('2026-06-01T00:00:00Z');
    const charge = await svc.computeCharge(AGENCY_A, LOCATION_A1, periodStart, periodEnd);

    // assertAgencyOwns gated the location reference.
    expect(agency.assertAgencyOwns).toHaveBeenCalledWith(AGENCY_A, LOCATION_A1);

    // The metering reads the REAL usage source: UsageCounter, scoped to the LOCATION,
    // on exactly the ai.credits + messages.sent metrics, for the period's month key.
    const aggArg = (prisma.usageCounter.aggregate as jest.Mock).mock.calls[0][0];
    expect(aggArg._sum.value).toBe(true);
    expect(aggArg.where.workspaceId).toBe(LOCATION_A1);
    expect(aggArg.where.metric.in.sort()).toEqual(
      [AI_CREDITS_METRIC, MESSAGES_METRIC].sort(),
    );
    expect([...REBILLED_USAGE_METRICS].sort()).toEqual(
      [AI_CREDITS_METRIC, MESSAGES_METRIC].sort(),
    );
    expect(aggArg.where.periodKey.in).toEqual(['2026-05']);

    // Math: meteredCost = 40 × 2.00 = 80.00; usageAmount = 80 × 1.25 = 100.00;
    // base = 100.00; total = 200.00.
    expect(new Prisma.Decimal(charge.baseAmount).toFixed(2)).toBe('100.00');
    expect(new Prisma.Decimal(charge.usageAmount).toFixed(2)).toBe('100.00');
    expect(new Prisma.Decimal(charge.totalAmount).toFixed(2)).toBe('200.00');
    expect(charge.usageUnits).toBe(40);
    expect(charge.status).toBe('DRAFT');
    expect(charge.workspaceId).toBe(AGENCY_A);
    expect(charge.locationWorkspaceId).toBe(LOCATION_A1);
  });

  it('is idempotent per period — returns the existing charge, never mints a 2nd (no double Stripe charge)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue(plan as never);
    (prisma.usageCounter.aggregate as jest.Mock).mockResolvedValue({ _sum: { value: 40 } } as never);
    // A DRAFT charge already exists for this (location, period).
    const existing = { id: 'charge-existing', status: 'DRAFT', workspaceId: AGENCY_A, locationWorkspaceId: LOCATION_A1 };
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(existing as never);

    const charge = await svc.computeCharge(
      AGENCY_A,
      LOCATION_A1,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );

    // Returned the existing row and did NOT create a duplicate.
    expect(charge.id).toBe('charge-existing');
    expect(prisma.rebillCharge.create).not.toHaveBeenCalled();
    // The dedupe lookup is scoped to (agency, location, period) and excludes FAILED.
    const where = (prisma.rebillCharge.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.workspaceId).toBe(AGENCY_A);
    expect(where.locationWorkspaceId).toBe(LOCATION_A1);
    expect(where.status).toEqual({ not: 'FAILED' });
  });

  it('zero usage → usageAmount 0, total = basePrice', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue(plan as never);
    (prisma.usageCounter.aggregate as jest.Mock).mockResolvedValue({
      _sum: { value: null }, // no usage rows
    } as never);
    (prisma.rebillCharge.create as jest.Mock).mockImplementation(
      (args: any) => Promise.resolve({ id: 'c', ...args.data }) as never,
    );

    const charge = await svc.computeCharge(
      AGENCY_A,
      LOCATION_A1,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(new Prisma.Decimal(charge.usageAmount).toFixed(2)).toBe('0.00');
    expect(new Prisma.Decimal(charge.totalAmount).toFixed(2)).toBe('100.00');
    expect(charge.usageUnits).toBe(0);
  });

  it('404s when no plan exists; rejects a disabled plan', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValueOnce(null as never);
    await expect(
      svc.computeCharge(
        AGENCY_A,
        LOCATION_A1,
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValueOnce({
      ...plan,
      enabled: false,
    } as never);
    await expect(
      svc.computeCharge(
        AGENCY_A,
        LOCATION_A1,
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a foreign location before any metering (cross-agency isolation)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockRejectedValue(
      new NotFoundException('Location not found in this agency'),
    );
    await expect(
      svc.computeCharge(
        AGENCY_B,
        FOREIGN_LOC,
        new Date('2026-05-01T00:00:00Z'),
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.usageCounter.aggregate).not.toHaveBeenCalled();
    expect(prisma.rebillCharge.create).not.toHaveBeenCalled();
  });
});

describe('RebillingService — chargeViaStripeConnect (env-gated + idempotent)', () => {
  const draftCharge = {
    id: 'charge-1',
    workspaceId: AGENCY_A,
    locationWorkspaceId: LOCATION_A1,
    totalAmount: new Prisma.Decimal('200.00'),
    status: 'DRAFT',
    stripeChargeId: null,
  };

  it('is INERT when Stripe Connect env is unset: charge stays DRAFT, clean error, NO Stripe call', async () => {
    const { prisma, svc } = makeSvc(/* no env */);
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(draftCharge as never);
    const stripeSpy = jest.spyOn(svc, 'getStripeClient');

    await expect(
      svc.chargeViaStripeConnect(AGENCY_A, 'charge-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // No write that would move it off DRAFT, and no Stripe SDK construction.
    expect(prisma.rebillCharge.update).not.toHaveBeenCalled();
    expect(stripeSpy).not.toHaveBeenCalled();
    expect(svc.isStripeConnectConfigured()).toBe(false);
  });

  it('is idempotent: an already-INVOICED/PAID charge is returned unchanged (never re-charged)', async () => {
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue({
      ...draftCharge,
      status: 'PAID',
      stripeChargeId: 'pi_existing',
    } as never);
    const stripeSpy = jest.spyOn(svc, 'getStripeClient');

    const res = await svc.chargeViaStripeConnect(AGENCY_A, 'charge-1');
    expect(res.status).toBe('PAID');
    expect(prisma.rebillCharge.update).not.toHaveBeenCalled();
    expect(stripeSpy).not.toHaveBeenCalled();
  });

  it('stays DRAFT when configured but the location has no connected account', async () => {
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(draftCharge as never);
    // PSP config exists but has no connectAccountId.
    (prisma.workspacePspConfig.findUnique as jest.Mock).mockResolvedValue({
      provider: 'STRIPE',
      configPublic: {},
    } as never);

    await expect(
      svc.chargeViaStripeConnect(AGENCY_A, 'charge-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.rebillCharge.update).not.toHaveBeenCalled();
  });

  it('when fully configured: charges the location’s connected account and flips to PAID', async () => {
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(draftCharge as never);
    (prisma.workspacePspConfig.findUnique as jest.Mock).mockResolvedValue({
      provider: 'STRIPE',
      configPublic: { connectAccountId: 'acct_loc1' },
    } as never);
    (prisma.rebillCharge.update as jest.Mock).mockImplementation(
      (args: any) => Promise.resolve({ ...draftCharge, ...args.data }) as never,
    );

    // Mock the Stripe seam.
    const create = jest.fn().mockResolvedValue({ id: 'pi_live_1' });
    jest
      .spyOn(svc, 'getStripeClient')
      .mockReturnValue({ paymentIntents: { create } } as any);

    const res = await svc.chargeViaStripeConnect(AGENCY_A, 'charge-1');

    // Charged on the connected account, in TRY minor units (200.00 → 20000), idempotent key.
    expect(create).toHaveBeenCalledTimes(1);
    const [body, opts] = create.mock.calls[0];
    expect(body.amount).toBe(20000);
    expect(body.currency).toBe('try');
    expect(opts.stripeAccount).toBe('acct_loc1');
    expect(opts.idempotencyKey).toBe('rebill:charge-1');

    expect(res.status).toBe('PAID');
    const updateArg = (prisma.rebillCharge.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.status).toBe('PAID');
    expect(updateArg.data.stripeChargeId).toBe('pi_live_1');
  });

  it('flips to FAILED and surfaces the error when Stripe rejects', async () => {
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(draftCharge as never);
    (prisma.workspacePspConfig.findUnique as jest.Mock).mockResolvedValue({
      provider: 'STRIPE',
      configPublic: { connectAccountId: 'acct_loc1' },
    } as never);
    (prisma.rebillCharge.update as jest.Mock).mockResolvedValue({
      ...draftCharge,
      status: 'FAILED',
    } as never);

    const create = jest.fn().mockRejectedValue(new Error('card_declined'));
    jest
      .spyOn(svc, 'getStripeClient')
      .mockReturnValue({ paymentIntents: { create } } as any);

    await expect(
      svc.chargeViaStripeConnect(AGENCY_A, 'charge-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const updateArg = (prisma.rebillCharge.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.status).toBe('FAILED');
  });

  it('404s a charge owned by another agency (cross-agency isolation)', async () => {
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    // findFirst is scoped by (id, workspaceId=AGENCY_B) → null for AGENCY_A's charge.
    (prisma.rebillCharge.findFirst as jest.Mock).mockResolvedValue(null as never);
    await expect(
      svc.chargeViaStripeConnect(AGENCY_B, 'charge-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const arg = (prisma.rebillCharge.findFirst as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId).toBe(AGENCY_B);
  });
});

describe('RebillingService — does NOT touch the existing customer billing flow', () => {
  it('references none of the customer-billing delegates', async () => {
    // Static guarantee: exercise the full surface and assert the customer-billing
    // delegates are never read/written — rebilling is a separate, additive ledger.
    const { prisma, svc } = makeSvc({
      STRIPE_CONNECT_CLIENT_ID: 'ca_x',
      STRIPE_SECRET_KEY: 'sk_test_x',
    });
    (prisma.rebillingPlan.upsert as jest.Mock).mockResolvedValue({ id: 'p' } as never);
    (prisma.rebillingPlan.findUnique as jest.Mock).mockResolvedValue({
      id: 'p',
      workspaceId: AGENCY_A,
      locationWorkspaceId: LOCATION_A1,
      basePrice: new Prisma.Decimal('10'),
      usageUnitPrice: new Prisma.Decimal('1'),
      markupPercent: new Prisma.Decimal('0'),
      enabled: true,
    } as never);
    (prisma.usageCounter.aggregate as jest.Mock).mockResolvedValue({
      _sum: { value: 3 },
    } as never);
    (prisma.rebillCharge.create as jest.Mock).mockResolvedValue({
      id: 'c',
      status: 'DRAFT',
    } as never);

    await svc.upsertPlan(AGENCY_A, LOCATION_A1, {
      basePrice: '10',
      usageUnitPrice: '1',
      markupPercent: '0',
    });
    await svc.computeCharge(
      AGENCY_A,
      LOCATION_A1,
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    );

    // The customer-billing tables are NEVER touched by rebilling.
    expect(prisma.paymentOrder).not.toBeUndefined();
    for (const delegate of [
      'paymentOrder',
      'workspaceSubscription',
      'package',
      'invoice',
    ] as const) {
      const d = (prisma as any)[delegate];
      for (const method of ['create', 'update', 'upsert', 'updateMany', 'deleteMany']) {
        expect(d[method]).not.toHaveBeenCalled();
      }
    }
  });
});
