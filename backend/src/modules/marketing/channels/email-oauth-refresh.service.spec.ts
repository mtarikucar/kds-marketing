import {
  EmailOAuthRefreshService,
  REFRESH_TICK,
  REFRESH_TICK_MS,
  REFRESH_WINDOW_MS,
} from './email-oauth-refresh.service';
import { isSecretBoxConfigured, openSecret, sealSecret } from '../../../common/crypto/secret-box.helper';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import {
  ACCESS_TOKEN_SLACK_SECONDS,
  DEFAULT_TOKEN_TTL_SECONDS,
  refreshAccessToken,
} from './email-oauth.sender';

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

const SOON = () => String(Date.now() + 60_000); // inside the refresh window
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
  let health: any;
  let svc: EmailOAuthRefreshService;

  beforeEach(() => {
    jest.clearAllMocks();
    isSecretBoxConfiguredMock.mockReturnValue(true);
    (sealSecret as unknown as jest.Mock).mockImplementation((s: string) => s);
    (openSecret as unknown as jest.Mock).mockImplementation((s: string) => s);
    lockMock.mockImplementation(async (_p: unknown, _k: string, fn: () => Promise<void>) => fn());
    prisma = {
      channel: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    health = {
      recordOAuthReauthRequired: jest.fn().mockResolvedValue(undefined),
      clearOAuthReauthRequired: jest.fn().mockResolvedValue(undefined),
    };
    svc = new EmailOAuthRefreshService(prisma, health);
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

  describe('what the owner sees', () => {
    // The sealed box is invisible to every read path — the channel card, the
    // account centre and the alert sweep all read `configPublic`. A revoked
    // consent recorded only inside the box is a mailbox that looks fine and
    // sends nothing (`oauth-revoked-invisible`).
    const row = (extra: Record<string, string> = {}) => ({
      id: 'c1',
      workspaceId: 'ws-1',
      configSealed: sealed({
        oauthProvider: 'GOOGLE',
        oauthRefreshToken: 'rt',
        oauthExpiresAt: SOON(),
        ...extra,
      }),
    });

    it('carries the workspace, so the marker can be written scope-first', async () => {
      await svc.refreshExpiring();
      expect(prisma.channel.findMany.mock.calls[0][0].select).toMatchObject({ workspaceId: true });
    });

    it('raises the reconnect marker in the clear when the provider refuses', async () => {
      prisma.channel.findMany.mockResolvedValue([row()]);
      refreshMock.mockResolvedValue({
        accessToken: null,
        expiresAt: null,
        refreshToken: null,
        error: 'GOOGLE token request 400: invalid_grant',
      });
      await svc.refreshExpiring();
      expect(health.recordOAuthReauthRequired).toHaveBeenCalledWith(
        { id: 'c1', workspaceId: 'ws-1' },
        { error: 'GOOGLE token request 400: invalid_grant' },
      );
    });

    it('takes the marker down again when the token heals itself', async () => {
      // A transient provider outage leaves the refresh token intact, so the
      // next tick succeeds — and the card must stop saying "reconnect".
      prisma.channel.findMany.mockResolvedValue([row({ oauthError: 'stale complaint' })]);
      refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: null, error: null });
      await svc.refreshExpiring();
      expect(health.clearOAuthReauthRequired).toHaveBeenCalledWith({ id: 'c1', workspaceId: 'ws-1' });
      expect(health.recordOAuthReauthRequired).not.toHaveBeenCalled();
    });

    it('raises it from an on-demand send refresh too', async () => {
      prisma.channel.findFirst.mockResolvedValue(row());
      refreshMock.mockResolvedValue({
        accessToken: null,
        expiresAt: null,
        refreshToken: null,
        error: 'invalid_grant',
      });
      await svc.refreshNow('ws-1', 'c1');
      expect(health.recordOAuthReauthRequired).toHaveBeenCalledWith(
        { id: 'c1', workspaceId: 'ws-1' },
        { error: 'invalid_grant' },
      );
    });

    it('never fails a refresh because the marker could not be written', async () => {
      // G2, and the ordering that goes with it: health is a description of what
      // happened, never a reason for it to have gone differently.
      health.clearOAuthReauthRequired.mockRejectedValue(new Error('db down'));
      prisma.channel.findMany.mockResolvedValue([row()]);
      refreshMock.mockResolvedValue({ accessToken: 'new', expiresAt: 999, refreshToken: null, error: null });
      await expect(svc.refreshExpiring()).resolves.toBeUndefined();
      expect(written(prisma).oauthAccessToken).toBe('new');
    });
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

  describe('the tick and the window', () => {
    it('sees a dying token at the last sweep before it dies', () => {
      // Invariant (a). A window narrower than the tick leaves a token that
      // expires between two sweeps first noticed already dead.
      expect(REFRESH_TICK).toBe('0 */10 * * * *');
      expect(REFRESH_WINDOW_MS).toBeGreaterThanOrEqual(REFRESH_TICK_MS);
    });

    it('revisits a freshly refreshed token before it expires', () => {
      // Invariant (b), and the one a wider window cannot buy: the effective
      // TTL is ~59 minutes, so an hourly sweep leaves a dead minute every
      // hour, forever. Only a shorter tick closes it.
      const effectiveTtlMs = (DEFAULT_TOKEN_TTL_SECONDS - ACCESS_TOKEN_SLACK_SECONDS) * 1000;
      expect(REFRESH_TICK_MS).toBeLessThan(effectiveTtlMs);
      // And still well short of the TTL, so the volume stays ~1 refresh/hour.
      expect(REFRESH_WINDOW_MS).toBeLessThan(effectiveTtlMs);
    });
  });

  describe('refreshNow — the send path asking for a token it can use', () => {
    // What the send path actually sees when it asks: `needsRefresh` said true,
    // so the stored token is past its (already slack-adjusted) expiry.
    const DEAD = () => String(Date.now() - 1_000);
    const row = (over: Record<string, string> = {}) => ({
      id: 'c1',
      configSealed: sealed({ oauthProvider: 'GOOGLE', oauthRefreshToken: 'rt', ...over }),
    });

    it('reads the channel scoped to its workspace', async () => {
      prisma.channel.findFirst.mockResolvedValue(row({ oauthExpiresAt: LATER(), oauthAccessToken: 'good' }));
      await svc.refreshNow('ws1', 'c1');
      expect(prisma.channel.findFirst.mock.calls[0][0].where).toEqual({ id: 'c1', workspaceId: 'ws1' });
    });

    it('hands back the stored token when it is still good, without asking the provider', async () => {
      // The hourly sweep may have just refreshed it; spending a token request
      // per send would be the cost of not looking.
      prisma.channel.findFirst.mockResolvedValue(row({ oauthExpiresAt: LATER(), oauthAccessToken: 'good' }));
      const r = await svc.refreshNow('ws1', 'c1');
      expect(r).toMatchObject({ accessToken: 'good', error: null });
      expect(refreshMock).not.toHaveBeenCalled();
      expect(prisma.channel.update).not.toHaveBeenCalled();
    });

    it('refreshes a dead token and returns the NEW one', async () => {
      prisma.channel.findFirst.mockResolvedValue(row({ oauthExpiresAt: DEAD(), oauthAccessToken: 'old' }));
      refreshMock.mockResolvedValue({ accessToken: 'fresh', expiresAt: 999, refreshToken: null, error: null });

      const r = await svc.refreshNow('ws1', 'c1');

      expect(r).toMatchObject({ accessToken: 'fresh', error: null });
      expect(written(prisma)).toMatchObject({ oauthAccessToken: 'fresh', oauthRefreshToken: 'rt' });
    });

    it('collapses concurrent asks for the same mailbox into one token request', async () => {
      // Microsoft ROTATES the refresh token, so two refreshes racing on one
      // mailbox can leave the loser holding a credential the provider has
      // already invalidated.
      prisma.channel.findFirst.mockResolvedValue(row({ oauthExpiresAt: DEAD(), oauthAccessToken: 'old' }));
      refreshMock.mockResolvedValue({ accessToken: 'fresh', expiresAt: 999, refreshToken: null, error: null });

      const [a, b] = await Promise.all([svc.refreshNow('ws1', 'c1'), svc.refreshNow('ws1', 'c1')]);

      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(a.accessToken).toBe('fresh');
      expect(b.accessToken).toBe('fresh');
    });

    it('returns the provider refusal and keeps the refresh token', async () => {
      prisma.channel.findFirst.mockResolvedValue(row({ oauthExpiresAt: DEAD(), oauthAccessToken: 'old' }));
      refreshMock.mockResolvedValue({
        accessToken: null, expiresAt: null, refreshToken: null,
        error: 'GOOGLE token request 400: invalid_grant',
      });

      const r = await svc.refreshNow('ws1', 'c1');

      expect(r).toMatchObject({ accessToken: null, error: 'GOOGLE token request 400: invalid_grant' });
      expect(written(prisma)).toMatchObject({
        oauthRefreshToken: 'rt',
        oauthError: 'GOOGLE token request 400: invalid_grant',
      });
    });

    it('answers with an error rather than throwing, whatever is missing', async () => {
      // G2: this is called from inside a send, and a throw there fails a whole
      // workflow run rather than one mail.
      isSecretBoxConfiguredMock.mockReturnValue(false);
      expect(await svc.refreshNow('ws1', 'c1')).toMatchObject({ accessToken: null, error: expect.any(String) });

      isSecretBoxConfiguredMock.mockReturnValue(true);
      prisma.channel.findFirst.mockResolvedValue(null);
      expect(await svc.refreshNow('ws1', 'gone')).toMatchObject({ accessToken: null, error: expect.any(String) });

      prisma.channel.findFirst.mockResolvedValue({ id: 'c1', configSealed: sealed({ smtpHost: 'h' }) });
      expect(await svc.refreshNow('ws1', 'c1')).toMatchObject({ accessToken: null, error: expect.any(String) });

      prisma.channel.findFirst.mockRejectedValue(new Error('db is down'));
      expect(await svc.refreshNow('ws1', 'c1')).toMatchObject({ accessToken: null, error: expect.any(String) });
    });
  });
});
