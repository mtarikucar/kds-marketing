import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BillingService, WALLET_TOPUP_MAX } from './billing.service';

/**
 * Growth-wallet top-up checkout (Growth Autopilot spec D2): an amount-based
 * PaymentOrder (type WALLET_TOPUP, no package) minted through the SAME
 * provider-handle + 10-min dedup pre-check discipline as checkout(). The
 * wallet credit itself happens at settlement, never here.
 */
function makeSvc() {
  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ defaultCurrency: 'TRY', status: 'ACTIVE' }),
    },
    paymentOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'topup-new', ...data })),
    },
    growthWallet: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const entitlements: any = { getEffective: jest.fn() };
  const config: any = { get: jest.fn().mockReturnValue('https://app.test') };
  const provider: any = {
    id: 'paytr',
    isConfigured: jest.fn().mockReturnValue(true),
    supports: jest.fn().mockReturnValue(true),
    createCheckout: jest.fn().mockResolvedValue({ kind: 'iframe', token: 't', iframeUrl: 'https://pay/x' }),
  };
  const svc = new BillingService(prisma, entitlements, config, [provider]);
  return { prisma, provider, svc };
}

const CTX = { buyerEmail: 'owner@ws.com', buyerIp: '1.2.3.4' };

describe('BillingService.walletTopup', () => {
  it('creates a WALLET_TOPUP order (no package) in the workspace currency and mints the provider handle', async () => {
    const { prisma, provider, svc } = makeSvc();

    const out = await svc.walletTopup('ws-1', { amount: 500, provider: 'paytr' }, CTX);

    expect(out.orderId).toBe('topup-new');
    expect(out.handle).toMatchObject({ kind: 'iframe' });
    const data = prisma.paymentOrder.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: 'ws-1',
      type: 'WALLET_TOPUP',
      currency: 'TRY',
      provider: 'paytr',
    });
    expect(data.packageId).toBeUndefined(); // amount-based order — no package
    expect(data.amount.toString()).toBe('500');
    expect(typeof data.idempotencyKey).toBe('string');
    // Handle minted exactly like checkout(): same order object + /billing return URL.
    const [orderArg, ctxArg] = provider.createCheckout.mock.calls[0];
    expect(orderArg.id).toBe('topup-new');
    expect(ctxArg).toMatchObject({
      buyerEmail: 'owner@ws.com',
      buyerIp: '1.2.3.4',
      returnUrl: 'https://app.test/billing',
    });
  });

  it('locks the wallet currency to the workspace default, ignoring/rejecting a divergent client currency (FIX 3)', async () => {
    const { prisma, svc } = makeSvc(); // TRY-default workspace
    // A client-supplied currency that diverges from the workspace's spend
    // denomination is refused — a wallet must never be seeded off-currency.
    await expect(
      svc.walletTopup('ws-1', { amount: 100, provider: 'paytr', currency: 'USD' }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
  });

  it('accepts an explicit currency that matches the workspace default', async () => {
    const { prisma, svc } = makeSvc(); // TRY-default workspace
    await svc.walletTopup('ws-1', { amount: 100, provider: 'paytr', currency: 'TRY' }, CTX);
    expect(prisma.paymentOrder.create.mock.calls[0][0].data.currency).toBe('TRY');
  });

  it('derives a USD wallet currency from a USD-default workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue({ defaultCurrency: 'USD', status: 'ACTIVE' });
    await svc.walletTopup('ws-1', { amount: 100, provider: 'paytr' }, CTX);
    expect(prisma.paymentOrder.create.mock.calls[0][0].data.currency).toBe('USD');
  });

  it('rejects amounts below the minimum, above the cap, and non-finite ones', async () => {
    const { prisma, svc } = makeSvc();

    await expect(svc.walletTopup('ws-1', { amount: 0, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.walletTopup('ws-1', { amount: 0.5, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.walletTopup('ws-1', { amount: WALLET_TOPUP_MAX + 1, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.walletTopup('ws-1', { amount: Number.NaN, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
  });

  it('reuses a recent PENDING top-up for the same amount+currency+provider (retry dedup)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.paymentOrder.findFirst.mockResolvedValue({ id: 'existing-topup' });

    const out = await svc.walletTopup('ws-1', { amount: 500, provider: 'paytr' }, CTX);

    expect(out.orderId).toBe('existing-topup');
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    const where = prisma.paymentOrder.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      workspaceId: 'ws-1',
      status: 'PENDING',
      type: 'WALLET_TOPUP',
      currency: 'TRY',
      provider: 'paytr',
    });
    expect(where.amount.toString()).toBe('500'); // dedup intent includes the amount
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('404s on a missing or inactive workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(svc.walletTopup('ws-x', { amount: 100, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(NotFoundException);

    prisma.workspace.findUnique.mockResolvedValue({ defaultCurrency: 'TRY', status: 'SUSPENDED' });
    await expect(svc.walletTopup('ws-1', { amount: 100, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unconfigured provider and an unsupported currency', async () => {
    const { provider, svc } = makeSvc();
    provider.isConfigured.mockReturnValue(false);
    await expect(svc.walletTopup('ws-1', { amount: 100, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    provider.isConfigured.mockReturnValue(true);
    provider.supports.mockReturnValue(false);
    await expect(svc.walletTopup('ws-1', { amount: 100, provider: 'paytr' }, CTX))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  // Audit A2 (checkout-side guard): the wallet has NO FX, so a top-up in a
  // different currency than the existing wallet must be rejected BEFORE the
  // customer pays — rejecting only at settlement would take their money and
  // then refuse the credit.
  it('rejects a top-up whose currency differs from the existing wallet currency (pre-payment)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.growthWallet.findUnique.mockResolvedValue({ currency: 'USD' });

    await expect(
      svc.walletTopup('ws-1', { amount: 100, provider: 'paytr', currency: 'TRY' }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
  });

  it('seeds the wallet in the workspace default currency on first top-up (no client override needed)', async () => {
    const { prisma, svc } = makeSvc(); // TRY-default workspace, no wallet yet
    prisma.growthWallet.findUnique.mockResolvedValue(null);

    const out = await svc.walletTopup('ws-1', { amount: 100, provider: 'paytr' }, CTX);
    expect(out.orderId).toBe('topup-new');
    expect(prisma.paymentOrder.create.mock.calls[0][0].data.currency).toBe('TRY');
  });
});
