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
