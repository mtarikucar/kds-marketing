import { UnauthorizedException } from '@nestjs/common';
import { InboundWebhookGuard } from './inbound-webhook.guard';
import { hashWebhookSecret } from '../inbound-webhooks/inbound-webhooks.service';

const SECRET = 'whsec_topsecret';

function ctxFor(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('InboundWebhookGuard', () => {
  let webhooks: { resolveActive: jest.Mock };
  let guard: InboundWebhookGuard;

  beforeEach(() => {
    webhooks = { resolveActive: jest.fn() };
    guard = new InboundWebhookGuard(webhooks as any);
  });

  const liveWebhook = { id: 'wh1', workspaceId: 'ws-1', slug: 'abc', secretHash: hashWebhookSecret(SECRET) };

  it('401s when no secret is presented', async () => {
    await expect(guard.canActivate(ctxFor({ params: { slug: 'abc' }, headers: {}, query: {} })))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(webhooks.resolveActive).not.toHaveBeenCalled();
  });

  it('401s for an unknown/disabled slug (resolveActive null)', async () => {
    webhooks.resolveActive.mockResolvedValue(null);
    await expect(guard.canActivate(ctxFor({ params: { slug: 'abc' }, headers: { 'x-webhook-secret': SECRET }, query: {} })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s on a wrong secret', async () => {
    webhooks.resolveActive.mockResolvedValue(liveWebhook);
    await expect(guard.canActivate(ctxFor({ params: { slug: 'abc' }, headers: { 'x-webhook-secret': 'whsec_wrong' }, query: {} })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('passes with the right header secret and pins webhook context', async () => {
    webhooks.resolveActive.mockResolvedValue(liveWebhook);
    const req: any = { params: { slug: 'abc' }, headers: { 'x-webhook-secret': SECRET }, query: {} };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.inboundWebhook).toEqual({ id: 'wh1', workspaceId: 'ws-1', slug: 'abc' });
  });

  it('does NOT accept the secret via ?secret= query (would leak into access logs)', async () => {
    webhooks.resolveActive.mockResolvedValue(liveWebhook);
    const req: any = { params: { slug: 'abc' }, headers: {}, query: { secret: SECRET } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(webhooks.resolveActive).not.toHaveBeenCalled(); // rejected before any lookup
  });
});
