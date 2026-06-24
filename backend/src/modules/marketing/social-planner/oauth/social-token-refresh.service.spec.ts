jest.mock('../../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: (_p: unknown, _n: string, run: () => Promise<void>) => run(),
}));
jest.mock('./social-oauth.providers', () => ({ providerFor: jest.fn() }));

import { SocialTokenRefreshService } from './social-token-refresh.service';
import { providerFor } from './social-oauth.providers';
import { sealSecret } from '../../../../common/crypto/secret-box.helper';

const providerForMock = providerFor as jest.Mock;

describe('SocialTokenRefreshService', () => {
  let prisma: any;
  let svc: SocialTokenRefreshService;

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 3).toString('base64');
  });

  beforeEach(() => {
    prisma = {
      socialAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    svc = new SocialTokenRefreshService(prisma as any);
    providerForMock.mockReset();
  });

  it('refreshes a due account and clears lastError', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      { id: 'a1', network: 'LINKEDIN', refreshToken: sealSecret('rt') },
    ]);
    providerForMock.mockReturnValue({
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'newtok',
        refreshToken: 'newref',
        expiresAt: new Date(Date.now() + 1000),
      }),
    });
    await svc.refreshExpiring();
    // The write is now a CAS updateMany (guarded on the refreshToken snapshot).
    expect(prisma.socialAccount.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.socialAccount.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'a1' });
    expect(call.where.refreshToken).toBeDefined(); // CAS snapshot guard
    expect(call.data.lastError).toBeNull();
    expect(call.data.accessToken).not.toBe('newtok'); // sealed
  });

  it('disables the account and flags reauth on refresh failure (CAS-guarded)', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      { id: 'a2', network: 'TIKTOK', refreshToken: sealSecret('rt') },
    ]);
    providerForMock.mockReturnValue({
      refresh: jest.fn().mockRejectedValue(new Error('invalid_grant')),
    });
    await svc.refreshExpiring();
    const call = prisma.socialAccount.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'a2' });
    expect(call.where.refreshToken).toBeDefined();
    expect(call.data).toEqual({ enabled: false, lastError: 'reauth_required' });
  });

  it('skips a provider without a refresh method (non-refreshable token)', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      { id: 'a3', network: 'FACEBOOK', refreshToken: sealSecret('rt') },
    ]);
    providerForMock.mockReturnValue({}); // no refresh()
    await svc.refreshExpiring();
    expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
  });
});
