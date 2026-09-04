import { InvoicesService } from './invoices.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';

const retrieve = jest.fn();
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ checkout: { sessions: { retrieve: (...a: unknown[]) => retrieve(...a) } } })),
}));
jest.mock('../../../common/scheduling/advisory-lock', () => ({
  ...jest.requireActual('../../../common/scheduling/advisory-lock'),
  withAdvisoryLock: jest.fn(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn()),
}));

const lockMock = withAdvisoryLock as unknown as jest.Mock;

/**
 * THE PAYMENT NOBODY EVER HEARS ABOUT.
 *
 * Stripe confirms a Checkout payment by redirecting the BUYER to a return URL.
 * That is the entire confirmation — no server-to-server call, nothing retried.
 * A buyer who pays and closes the tab, loses signal, or is bounced by a bank's
 * 3-D Secure page never makes that request, so the money is taken and the
 * invoice stays SENT with nothing anywhere to say so: everything that could
 * notice lives in the browser that left.
 *
 * PayTR and iyzico post to us directly and have no such hole. This sweep closes
 * the one Stripe has, by asking Stripe ourselves about the exact session the
 * buyer was sent to.
 */
describe('reconciling Stripe payments the buyer never came back from', () => {
  const WS = 'ws-1';
  const INV = { id: 'inv1', workspaceId: WS, total: 2500, currency: 'TRY', pspSessionId: 'cs_1' };
  const sealedStripeKey = () => {
    // The service seals/opens PSP secrets with MARKETING_SECRET_KEY; go through
    // its own writer so the test never hand-rolls the envelope.
    return svc.setPspConfig(WS, { provider: 'STRIPE', secrets: { secretKey: 'sk_test' } });
  };

  let prisma: any;
  let outbox: { append: jest.Mock };
  let svc: InvoicesService;
  let sealed: string | null;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    lockMock.mockImplementation(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn());
    sealed = null;
    prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([INV]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      workspacePspConfig: {
        findUnique: jest.fn(async () => ({ provider: 'STRIPE', configSealed: sealed })),
        upsert: jest.fn(async ({ create }: any) => {
          sealed = create.configSealed;
          return {};
        }),
      },
      customerWallet: { findUnique: jest.fn().mockResolvedValue({ currency: 'TRY' }) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('e') };
    svc = new InvoicesService(
      prisma as any,
      { get: jest.fn().mockReturnValue('https://m.example') } as any,
      outbox as any,
      { resolveItemTaxes: jest.fn(async (_w: string, i: unknown[]) => i ?? []) } as any,
      { debit: jest.fn().mockResolvedValue({}) } as any,
    );
    await sealedStripeKey();
    // The setup writes the PSP config through the service's own writer, which
    // reads it once on the way. Clearing here keeps every count below about
    // what the SWEEP did, not about how the fixture was built.
    jest.clearAllMocks();
    retrieve.mockReset();
    lockMock.mockImplementation(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn());
    prisma.invoice.findMany.mockResolvedValue([INV]);
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspacePspConfig.findUnique.mockImplementation(async () => ({
      provider: 'STRIPE', configSealed: sealed,
    }));
  });

  const paidSession = (over: Record<string, unknown> = {}) => ({
    payment_status: 'paid',
    amount_total: 2500,
    currency: 'try',
    metadata: { invoiceId: 'inv1' },
    client_reference_id: 'inv1',
    ...over,
  });

  /** Did the invoice actually get marked paid? */
  const settled = () =>
    prisma.invoice.updateMany.mock.calls.some((c: any[]) => c[0]?.data?.status === 'PAID') ||
    prisma.invoice.update.mock.calls.some((c: any[]) => c[0]?.data?.status === 'PAID');

  it('settles the invoice the buyer paid for and walked away from', async () => {
    retrieve.mockResolvedValue(paidSession());
    await svc.reconcileStripeSessions();
    expect(retrieve).toHaveBeenCalledWith('cs_1');
    expect(settled()).toBe(true);
  });

  it('asks only about invoices that are still waiting AND have a session', async () => {
    // A real predicate, not a window. `take(N)` over an unfiltered table pins a
    // sweep to the oldest N forever; this set shrinks by one every time an
    // invoice settles, so it can never go blind.
    retrieve.mockResolvedValue(paidSession());
    await svc.reconcileStripeSessions();
    const where = prisma.invoice.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'SENT', pspSessionId: { not: null } });
    expect(prisma.invoice.findMany.mock.calls[0][0].take).toBeUndefined();
  });

  it('leaves an unpaid session alone', async () => {
    retrieve.mockResolvedValue(paidSession({ payment_status: 'unpaid' }));
    await svc.reconcileStripeSessions();
    expect(settled()).toBe(false);
  });

  describe('a paid session still has to be paid for THIS invoice', () => {
    it('refuses one bound to a different invoice', async () => {
      // Otherwise any paid session in the workspace's Stripe account — a cheap
      // invoice the buyer really did pay — settles a more expensive one free.
      retrieve.mockResolvedValue(
        paidSession({ metadata: { invoiceId: 'other' }, client_reference_id: 'other' }),
      );
      await svc.reconcileStripeSessions();
      expect(settled()).toBe(false);
    });

    it('refuses one whose amount does not match', async () => {
      retrieve.mockResolvedValue(paidSession({ amount_total: 100 }));
      await svc.reconcileStripeSessions();
      expect(settled()).toBe(false);
    });

    it('refuses one in another currency', async () => {
      retrieve.mockResolvedValue(paidSession({ currency: 'usd' }));
      await svc.reconcileStripeSessions();
      expect(settled()).toBe(false);
    });
  });

  it('keeps going when one invoice throws', async () => {
    // A revoked key, an expired session, a Stripe hiccup. None of them is a
    // reason to stop asking about everybody else's money.
    prisma.invoice.findMany.mockResolvedValue([
      { ...INV, id: 'bad', pspSessionId: 'cs_bad' },
      { ...INV, id: 'good', pspSessionId: 'cs_good' },
    ]);
    retrieve.mockRejectedValueOnce(new Error('No such session')).mockResolvedValue(
      paidSession({ metadata: { invoiceId: 'good' }, client_reference_id: 'good' }),
    );
    await svc.reconcileStripeSessions();
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(settled()).toBe(true);
  });

  it('does nothing for a workspace that is not on Stripe', async () => {
    prisma.workspacePspConfig.findUnique.mockResolvedValue({ provider: 'PAYTR', configSealed: sealed });
    await svc.reconcileStripeSessions();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('opens one Stripe client per workspace, not one per invoice', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { ...INV, id: 'a', pspSessionId: 'cs_a' },
      { ...INV, id: 'b', pspSessionId: 'cs_b' },
    ]);
    retrieve.mockResolvedValue(paidSession({ payment_status: 'unpaid' }));
    await svc.reconcileStripeSessions();
    expect(prisma.workspacePspConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not run without the single-replica lock', async () => {
    lockMock.mockImplementation(async () => undefined);
    await svc.reconcileStripeSessions();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });
});
