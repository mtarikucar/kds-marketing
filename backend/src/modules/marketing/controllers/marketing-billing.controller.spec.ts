import { MarketingBillingController } from './marketing-billing.controller';

/**
 * Wallet top-up endpoint (Growth Autopilot spec D2): mounted next to checkout
 * with the same OWNER + billing.manage guards; delegates to
 * BillingService.walletTopup with the actor's workspace and buyer context.
 */
describe('MarketingBillingController.walletTopup', () => {
  it('delegates to BillingService.walletTopup with the actor workspace + buyer ctx', async () => {
    const billing: any = {
      walletTopup: jest.fn().mockResolvedValue({ orderId: 'o1', handle: { kind: 'redirect', url: 'https://pay/x' } }),
    };
    const ctrl = new MarketingBillingController(billing, {} as any, {} as any);
    const req: any = { ip: '9.9.9.9', headers: {} };

    const out = await ctrl.walletTopup(
      { workspaceId: 'ws-1', email: 'owner@ws.com' } as any,
      { amount: 250, provider: 'paytr' } as any,
      req,
    );

    expect(billing.walletTopup).toHaveBeenCalledWith(
      'ws-1',
      { amount: 250, provider: 'paytr' },
      { buyerEmail: 'owner@ws.com', buyerIp: '9.9.9.9' },
    );
    expect(out.orderId).toBe('o1');
  });
});

/**
 * summary() merges the env-gated platform features into the SAME
 * entitlements.features map the SPA nav gates its menu items on. These three
 * were false in production for months because their keys were never rendered
 * by deploy.yml (see deploy-env-parity.spec.ts) — this pins both directions:
 * unset = hidden exactly as today, set = the flag flips.
 */
describe('MarketingBillingController.summary (platform feature gates)', () => {
  const KEYS = ['PAGESPEED_API_KEY', 'SENDING_DOMAIN_ESP', 'CUSTOM_DOMAINS_ENABLED'] as const;
  const real: Record<string, string | undefined> = {};
  let ctrl: MarketingBillingController;

  beforeEach(() => {
    for (const k of KEYS) {
      real[k] = process.env[k];
      delete process.env[k];
    }
    const billing: any = {
      summary: jest.fn().mockResolvedValue({ entitlements: { features: { crm: true } } }),
    };
    ctrl = new MarketingBillingController(billing, {} as any, {} as any);
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (real[k] === undefined) delete process.env[k];
      else process.env[k] = real[k] as string;
    }
  });

  it('reports every platform feature off when no env key is set', async () => {
    const out: any = await ctrl.summary({ workspaceId: 'ws-1' } as any);

    expect(out.entitlements.features).toEqual({
      crm: true,
      prospecting: false,
      sendingDomains: false,
      customDomains: false,
    });
  });

  it('flips only the features whose env key is set', async () => {
    process.env.PAGESPEED_API_KEY = 'psi-key';
    process.env.SENDING_DOMAIN_ESP = 'postmark';

    const out: any = await ctrl.summary({ workspaceId: 'ws-1' } as any);

    expect(out.entitlements.features.prospecting).toBe(true);
    expect(out.entitlements.features.sendingDomains).toBe(true);
    expect(out.entitlements.features.customDomains).toBe(false);
  });
});
