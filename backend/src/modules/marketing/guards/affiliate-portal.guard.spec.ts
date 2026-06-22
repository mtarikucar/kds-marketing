import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AffiliatePortalGuard, hashAffiliateToken, AFFILIATE_TOKEN_PREFIX } from './affiliate-portal.guard';

/**
 * Portal bearer-token guard (Epic 11a): hashes the presented token, resolves the
 * owning ACTIVE affiliate, and attaches it to the request. Unknown / non-ACTIVE
 * tokens die with the same generic 401.
 */
describe('AffiliatePortalGuard', () => {
  const RAW = `${AFFILIATE_TOKEN_PREFIX}${'a'.repeat(48)}`;
  let prisma: { affiliate: { findUnique: jest.Mock; update: jest.Mock } };
  let guard: AffiliatePortalGuard;
  let request: any;

  const ctx = () => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    prisma = { affiliate: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
    guard = new AffiliatePortalGuard(prisma as any);
    request = { headers: { 'x-affiliate-token': RAW } };
  });

  it('accepts an ACTIVE affiliate, attaches it, and looks up by sha256 (never the raw)', async () => {
    prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: 'ws-1', status: 'ACTIVE' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.affiliate).toEqual({ id: 'aff-1', workspaceId: 'ws-1' });
    const where = prisma.affiliate.findUnique.mock.calls[0][0].where;
    expect(where.portalTokenHash).toBe(hashAffiliateToken(RAW));
    expect(where.portalTokenHash).not.toContain(RAW);
  });

  it('also accepts an Authorization: Bearer token', async () => {
    request = { headers: { authorization: `Bearer ${RAW}` } };
    prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: 'ws-1', status: 'ACTIVE' });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(request.affiliate.id).toBe('aff-1');
  });

  it('rejects an unknown token', async () => {
    prisma.affiliate.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a PAUSED/DISABLED affiliate with the same generic error', async () => {
    prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: 'ws-1', status: 'PAUSED' });
    await expect(guard.canActivate(ctx())).rejects.toThrow('Invalid affiliate token');
  });

  it('rejects a missing token without touching the database', async () => {
    request = { headers: {} };
    await expect(guard.canActivate(ctx())).rejects.toThrow('Missing affiliate token');
    expect(prisma.affiliate.findUnique).not.toHaveBeenCalled();
  });

  it('does not fail the request when the lastLoginAt write breaks', async () => {
    prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: 'ws-1', status: 'ACTIVE' });
    prisma.affiliate.update.mockRejectedValue(new Error('db hiccup'));
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});
