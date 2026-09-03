import { EmailOAuthRefreshService } from './email-oauth-refresh.service';
import { isSecretBoxConfigured, openSecret, sealSecret } from '../../../common/crypto/secret-box.helper';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { refreshAccessToken } from './email-oauth.sender';

jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: jest.fn(() => true),
  // Identity box, so a test can read what was written without a key.
  sealSecret: jest.fn((s: string) => s),
  openSecret: jest.fn((s: string) => s),
}));
jest.mock('../../../common/scheduling/advisory-lock', () => ({
  ...jest.requireActual('../../../common/scheduling/advisory-lock'),
  withAdvisoryLock: jest.fn(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn()),
}));
jest.mock('./email-oauth.sender', () => ({
  ...jest.requireActual('./email-oauth.sender'),
  refreshAccessToken: jest.fn(),
}));

const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const refreshMock = refreshAccessToken as unknown as jest.Mock;
const lockMock = withAdvisoryLock as unknown as jest.Mock;

const SOON = () => String(Date.now() + 60_000); // inside the 15-minute window
const LATER = () => String(Date.now() + 60 * 60_000);

function sealed(o: Record<string, string>): string {
  return JSON.stringify(o);
}

/** What the row's box holds after the sweep. */
function written(prisma: any): Record<string, string> {
  return JSON.parse(prisma.channel.update.mock.calls[0][0].data.configSealed);
}

describe('keeping a connected mailbox alive', () => {
  let prisma: any;
  let svc: EmailOAuthRefreshService;

  beforeEach(() => {
    jest.clearAllMocks();
    isSecretBoxConfiguredMock.mockReturnValue(true);
    (sealSecret as unknown as jest.Mock).mockImplementation((s: string) => s);
    (openSecret as unknown as jest.Mock).mockImplementation((s: string) => s);
    lockMock.mockImplementation(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn());
    prisma = {
      channel: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    };
    svc = new EmailOAuthRefreshService(prisma);
  });

  it('does nothing at all without a key to open the box with', async () => {
    isSecretBoxConfiguredMock.mockReturnValue(false);
    await svc.refreshExpiring();
    expect(prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it('sweeps every candidate row, with no take-N window to fall behind', async () => {
    // A take(N) over a set with no queryable expiry pins the sweep to the same
    // N rows forever; every mailbox connected afterwards silently stops.
    await svc.refreshExpiring();
    const args = prisma.channel.findMany.mock.calls[0][0];
    expect(args.take).toBeUndefined();
    expect(args.where).toMatchObject({ type: 'EMAIL', status: 'ACTIVE' });
  });

  it('leaves an SMTP channel alone', async () => {
    prisma.channel.findMany.mockResolvedValue([
      { id: 'c1', configSealed: sealed({ smtpHost: 'h', smtpPass: 'p' }) },
    ]);
    await svc.refreshExpiring();
    expect(refreshMock).not.toHaveBeenCalled();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('leaves a token that is not due yet', async () => {
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'c1',
        configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt', oauthExpiresAt: LATER() }),
      },
    ]);
    await svc.refreshExpiring();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('treats an unrecorded expiry as due', async () => {
    // Matches needsRefresh on the send path: an unknown age is assumed expired,
    // because one wasted refresh beats a send that fails on a customer.
    prisma.channel.findMany.mockResolvedValue([
      { id: 'c1', configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt' }) },
    ]);
    refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 123, refreshToken: null, error: null });
    await svc.refreshExpiring();
    expect(refreshMock).toHaveBeenCalledWith('GOOGLE', 'rt');
  });

  it('stores the new access token and keeps the old refresh token Google did not rotate', async () => {
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'c1',
        configSealed: sealed({
          oauthProvider: 'GOOGLE',
          oauthRefreshToken: 'rt-original',
          oauthExpiresAt: SOON(),
          fromEmail: 'a@b.com',
        }),
      },
    ]);
    refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: null, error: null });

    await svc.refreshExpiring();

    expect(written(prisma)).toMatchObject({
      oauthAccessToken: 'new',
      oauthExpiresAt: '999',
      oauthRefreshToken: 'rt-original',
      fromEmail: 'a@b.com',
    });
  });

  it('stores a rotated refresh token, because Microsoft invalidates the old one', async () => {
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'c1',
        configSealed: sealed({ oauthProvider: 'MICROSOFT', oauthRefreshToken: 'old', oauthExpiresAt: SOON() }),
      },
    ]);
    refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: 'rotated', error: null });

    await svc.refreshExpiring();

    expect(written(prisma).oauthRefreshToken).toBe('rotated');
  });

  it('records a refusal WITHOUT discarding the refresh token', async () => {
    // A provider having a bad minute must not cost a working connection: the
    // error is what the owner sees, the credential is what gets them back.
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'c1',
        configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt', oauthExpiresAt: SOON() }),
      },
    ]);
    refreshMock.mockResolvedValue({
      accessToken: null,
      expiresAt: null,
      refreshToken: null,
      error: 'GOOGLE token request 400: invalid_grant',
    });

    await svc.refreshExpiring();

    expect(written(prisma)).toMatchObject({
      oauthRefreshToken: 'rt',
      oauthError: 'GOOGLE token request 400: invalid_grant',
    });
  });

  it('clears a previous error once the mailbox works again', async () => {
    prisma.channel.findMany.mockResolvedValue([
      {
        id: 'c1',
        configSealed: sealed({
          oauthProvider: 'GOOGLE',
          oauthRefreshToken: 'rt',
          oauthExpiresAt: SOON(),
          oauthError: 'stale complaint',
        }),
      },
    ]);
    refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: null, error: null });

    await svc.refreshExpiring();

    expect(written(prisma).oauthError).toBeUndefined();
  });

  it('keeps going when one mailbox throws', async () => {
    // One revoked consent must not stop every mailbox queued behind it.
    prisma.channel.findMany.mockResolvedValue([
      { id: 'bad', configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt' }) },
      { id: 'good', configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt2' }) },
    ]);
    refreshMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: null, error: null });

    await svc.refreshExpiring();

    expect(prisma.channel.update).toHaveBeenCalledTimes(1);
    expect(prisma.channel.update.mock.calls[0][0].where).toEqual({ id: 'good' });
  });

  it('skips a box it cannot open instead of destroying it', async () => {
    (openSecret as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('bad key');
    });
    prisma.channel.findMany.mockResolvedValue([{ id: 'c1', configSealed: 'gibberish' }]);
    await svc.refreshExpiring();
    expect(prisma.channel.update).not.toHaveBeenCalled();
  });
});
