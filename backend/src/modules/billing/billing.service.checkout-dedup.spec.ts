import { BillingService } from './billing.service';

/**
 * Checkout retry idempotency: the schema's `idempotencyKey @unique` was meant to
 * collapse retried checkouts, but the key is generated per-call (randomUUID), so a
 * double-click / auto-retry of POST /checkout used to mint a SECOND PaymentOrder +
 * PSP handle → on a double-payment settlement grants/charges twice. A rolling-window
 * pre-check now reuses a recent PENDING order for the same intent.
 */
function makeSvc() {
  const prisma: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ defaultCurrency: 'TRY', status: 'ACTIVE' }) },
    package: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'pkg1', code: 'PRO', isPublic: true, status: 'ACTIVE', priceMonthlyTRY: 10000,
      }),
    },
    workspaceSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    paymentOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'new-order' }),
    },
  };
  const entitlements: any = { getEffective: jest.fn() };
  const config: any = { get: jest.fn().mockReturnValue('https://app.test') };
  const provider: any = {
    id: 'paytr',
    isConfigured: () => true,
    supports: () => true,
    createCheckout: jest.fn().mockResolvedValue({ url: 'https://pay/x' }),
  };
  const svc = new BillingService(prisma, entitlements, config, [provider]);
  return { prisma, provider, svc };
}

const CTX = { buyerEmail: 'a@b.com', buyerIp: '1.2.3.4' };
const PKG_INPUT = { packageCode: 'PRO', billingCycle: 'MONTHLY', provider: 'paytr' } as any;

describe('BillingService.checkout — retry idempotency', () => {
  it('reuses a recent PENDING order for the same package instead of minting a duplicate', async () => {
    const { prisma, svc } = makeSvc();
    prisma.paymentOrder.findFirst.mockResolvedValue({ id: 'existing-order' });

    const out = await svc.checkout('ws-1', PKG_INPUT, CTX as any);

    expect(out.orderId).toBe('existing-order');
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
  });

  it('mints a fresh order when there is no recent PENDING one (dedup scoped to the intent)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.paymentOrder.findFirst.mockResolvedValue(null);

    const out = await svc.checkout('ws-1', PKG_INPUT, CTX as any);

    expect(out.orderId).toBe('new-order');
    expect(prisma.paymentOrder.create).toHaveBeenCalled();
    const where = prisma.paymentOrder.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      workspaceId: 'ws-1',
      status: 'PENDING',
      packageId: 'pkg1',
      billingCycle: 'MONTHLY',
      currency: 'TRY',
      provider: 'paytr',
    });
  });
});
