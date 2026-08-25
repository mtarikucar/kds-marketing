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

  it('disables the account and flags reauth once the token has EXPIRED and refresh still fails', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      {
        id: 'a2',
        network: 'TIKTOK',
        refreshToken: sealSecret('rt'),
        tokenExpiresAt: new Date(Date.now() - 60_000), // out of runway
      },
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

  /**
   * Disabling on the FIRST failure was a one-way door: the due query filters
   * `enabled: true`, so a disabled account is never picked up again. Providers
   * throw a plain Error, so a 401 invalid_grant and a socket timeout are
   * indistinguishable — meaning a momentary blip permanently killed a healthy
   * connection until a human noticed.
   *
   * Accounts enter the query 7 days before expiry and the cron runs hourly, so
   * there are ~168 attempts available. While the token is still valid, a failed
   * refresh costs nothing.
   */
  it('leaves a still-valid account completely untouched when refresh fails', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      {
        id: 'a4',
        network: 'TIKTOK',
        refreshToken: sealSecret('rt'),
        tokenExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days of runway
      },
    ]);
    providerForMock.mockReturnValue({
      refresh: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
    });

    await svc.refreshExpiring();

    // No write at all. Not even a lastError: `needsReconnect` folds
    // Boolean(lastError), so writing one would tell the owner to reconnect an
    // account that is working fine and will be retried within the hour.
    expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
  });

  it('does not disable an account whose expiry is unknown', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      { id: 'a5', network: 'TIKTOK', refreshToken: sealSecret('rt'), tokenExpiresAt: null },
    ]);
    providerForMock.mockReturnValue({
      refresh: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await svc.refreshExpiring();

    // Null expiry is not evidence of expiry — fail open and retry.
    expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
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
