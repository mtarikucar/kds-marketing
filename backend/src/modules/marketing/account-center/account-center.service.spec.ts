import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountCenterService } from './account-center.service';

describe('AccountCenterService', () => {
  const WS = 'ws-1';
  let socialPlanner: any;
  let channels: any;
  let adAccounts: any;
  let entitlements: any;
  let socialOAuth: any;
  let svc: AccountCenterService;

  beforeEach(() => {
    socialPlanner = {
      listAccounts: jest.fn().mockResolvedValue([]),
      networkStatus: jest.fn().mockResolvedValue({ secretBoxConfigured: true, FACEBOOK: true }),
      disconnectAccount: jest.fn().mockResolvedValue({}),
    };
    channels = { list: jest.fn().mockResolvedValue([]), remove: jest.fn().mockResolvedValue({}) };
    adAccounts = {
      list: jest.fn().mockResolvedValue([]),
      status: jest.fn().mockReturnValue({ META: true, TIKTOK: false, LINKEDIN: false, secretBoxConfigured: true }),
      remove: jest.fn().mockResolvedValue({}),
    };
    entitlements = { getEffective: jest.fn().mockResolvedValue({ features: { conversationAi: true } }) };
    socialOAuth = { start: jest.fn().mockReturnValue({ authorizeUrl: 'https://fb/auth' }) };
    svc = new AccountCenterService(socialPlanner, channels, adAccounts, entitlements, socialOAuth);
  });

  const meta = (r: any) => r.providers.find((p: any) => p.provider === 'META');

  it('always emits the full provider catalog in order', async () => {
    const r = await svc.getConnections(WS);
    expect(r.providers.map((p: any) => p.provider)).toEqual([
      'META', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GOOGLE', 'SMS', 'EMAIL', 'WEBCHAT', 'VOICE',
    ]);
    expect(r.features.conversationAi).toBe(true);
  });

  it('collapses a Page that is BOTH a SocialAccount and a Messenger Channel into one group', async () => {
    socialPlanner.listAccounts.mockResolvedValue([
      { id: 'sa1', network: 'FACEBOOK', externalId: 'PAGE1', displayName: 'Acme', accountType: 'PAGE', connectedVia: 'OAUTH', enabled: true, lastError: null },
    ]);
    channels.list.mockResolvedValue([
      { id: 'ch1', type: 'MESSENGER', name: 'Acme', externalId: 'PAGE1', status: 'ACTIVE', configuredSecrets: ['pageAccessToken'] },
    ]);
    const groups = meta(await svc.getConnections(WS)).connections;
    expect(groups).toHaveLength(1);
    expect([...groups[0].capabilities].sort()).toEqual(['INBOX', 'PUBLISH']);
    expect(groups[0].sources.map((s: any) => s.model).sort()).toEqual(['Channel', 'SocialAccount']);
    expect(groups[0].externalId).toBe('PAGE1');
    expect(groups[0].health).toBe('HEALTHY');
  });

  it('keeps an ad account as its own ADS group under META (different identity)', async () => {
    adAccounts.list.mockResolvedValue([
      { id: 'ad1', provider: 'META', externalAdId: 'ACT9', displayName: 'Biz Ads', status: 'ACTIVE' },
    ]);
    const groups = meta(await svc.getConnections(WS)).connections;
    expect(groups).toHaveLength(1);
    expect(groups[0].capabilities).toEqual(['ADS']);
  });

  it('maps reauth_required and TOKEN_EXPIRED to REAUTH_REQUIRED health', async () => {
    socialPlanner.listAccounts.mockResolvedValue([
      { id: 'sa1', network: 'FACEBOOK', externalId: 'P1', displayName: 'A', accountType: 'PAGE', connectedVia: 'OAUTH', enabled: true, lastError: 'reauth_required' },
    ]);
    adAccounts.list.mockResolvedValue([
      { id: 'ad1', provider: 'TIKTOK', externalAdId: 'T1', displayName: 'T', status: 'TOKEN_EXPIRED' },
    ]);
    const r = await svc.getConnections(WS);
    expect(meta(r).connections[0].health).toBe('REAUTH_REQUIRED');
    expect(r.providers.find((p: any) => p.provider === 'TIKTOK').connections[0].health).toBe('REAUTH_REQUIRED');
  });

  it('never leaks sealed secrets in the response', async () => {
    socialPlanner.listAccounts.mockResolvedValue([
      { id: 'sa1', network: 'FACEBOOK', externalId: 'P1', displayName: 'A', accountType: 'PAGE', connectedVia: 'OAUTH', enabled: true, accessToken: 'v1:sealed:blob' },
    ]);
    const json = JSON.stringify(await svc.getConnections(WS));
    expect(json).not.toContain('accessToken');
    expect(json).not.toContain('configSealed');
    expect(json).not.toContain('v1:sealed');
  });

  it('reports META configured from EITHER social OR ads status', async () => {
    socialPlanner.networkStatus.mockResolvedValue({ secretBoxConfigured: true, FACEBOOK: false });
    adAccounts.status.mockReturnValue({ META: true });
    expect(meta(await svc.getConnections(WS)).configured).toBe(true);
  });

  describe('disconnect', () => {
    beforeEach(() => {
      // A Page that is both a publishing account AND a messenger channel.
      socialPlanner.listAccounts.mockResolvedValue([
        { id: 'sa1', network: 'FACEBOOK', externalId: 'P1', displayName: 'Acme', accountType: 'PAGE', connectedVia: 'OAUTH', enabled: true },
      ]);
      channels.list.mockResolvedValue([
        { id: 'ch1', type: 'MESSENGER', name: 'Acme', externalId: 'P1', status: 'ACTIVE' },
      ]);
    });

    it('removes ALL sources of an identity by default', async () => {
      const out = await svc.disconnect(WS, 'META:P1');
      expect(socialPlanner.disconnectAccount).toHaveBeenCalledWith(WS, 'sa1');
      expect(channels.remove).toHaveBeenCalledWith(WS, 'ch1');
      expect(out.removed).toHaveLength(2);
    });

    it('capability-selective: drops only INBOX, keeps PUBLISH', async () => {
      const out = await svc.disconnect(WS, 'META:P1', ['INBOX']);
      expect(channels.remove).toHaveBeenCalledWith(WS, 'ch1');
      expect(socialPlanner.disconnectAccount).not.toHaveBeenCalled();
      expect(out.removed).toHaveLength(1);
    });

    it('collects a per-source failure in skipped without aborting', async () => {
      channels.remove.mockRejectedValue(new Error('boom'));
      const out = await svc.disconnect(WS, 'META:P1');
      expect(out.removed.map((s: any) => s.model)).toEqual(['SocialAccount']);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0].reason).toContain('boom');
    });

    it('404s on an unknown identity', async () => {
      await expect(svc.disconnect(WS, 'META:NOPE')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reauth', () => {
    it('returns an authorize URL routed through the identity provider network', async () => {
      await expect(svc.reauth(WS, 'META:P1')).resolves.toEqual({ authorizeUrl: 'https://fb/auth' });
      expect(socialOAuth.start).toHaveBeenCalledWith(WS, 'FACEBOOK', 'account-center');
    });

    it('rejects reauth for a non-OAuth provider', async () => {
      await expect(svc.reauth(WS, 'SMS:x')).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * SOCIAL_PROVIDER has no INSTAGRAM_LOGIN key, so those accounts fall
     * through `?? 'META'` into the Meta bucket — and PROVIDER_NETWORK.META is
     * 'FACEBOOK', which cannot rotate an Instagram-Login token: it is a
     * separate Meta product with its own client id, secret and refresh call.
     * Reconnect launched a flow that could never repair the account, with no
     * error to say so.
     */
    it('routes an INSTAGRAM_LOGIN account through its OWN network, not the Meta bucket', async () => {
      socialPlanner.listAccounts.mockResolvedValue([
        { id: 'sa9', network: 'INSTAGRAM_LOGIN', externalId: 'IG9', displayName: 'figurunica', connectedVia: 'OAUTH', enabled: false, lastError: 'disconnected' },
      ]);

      await svc.reauth(WS, 'META:IG9');

      expect(socialOAuth.start).toHaveBeenCalledWith(WS, 'INSTAGRAM_LOGIN', 'account-center');
    });

    it('splits the identityKey on the FIRST colon so a urn externalId survives', async () => {
      socialPlanner.listAccounts.mockResolvedValue([
        { id: 'sa8', network: 'LINKEDIN', externalId: 'urn:li:org:1', displayName: 'Acme', connectedVia: 'OAUTH', enabled: true, lastError: null },
      ]);

      await svc.reauth(WS, 'LINKEDIN:urn:li:org:1');

      expect(socialOAuth.start).toHaveBeenCalledWith(WS, 'LINKEDIN', 'account-center');
    });

    it('still falls back to the bucket for an identity with no social account', async () => {
      socialPlanner.listAccounts.mockResolvedValue([]);

      await svc.reauth(WS, 'META:P1');

      expect(socialOAuth.start).toHaveBeenCalledWith(WS, 'FACEBOOK', 'account-center');
    });
  });
});

/**
 * An expired token is a reconnect prompt, even when nothing has failed yet.
 *
 * Health only looked at `lastError` and `enabled`, so an account whose token
 * had run out still rendered HEALTHY with no Reconnect button. The account most
 * likely to be in that state is the one the refresh cron never touches: its due
 * query requires a refreshToken, and a Meta page token has none. It sits there,
 * dead, looking fine.
 *
 * `needsReconnect` (social.tools.ts:67) already folds `expired`, so the two
 * views of the same account disagreed.
 */
describe('AccountCenterService — expired tokens surface as REAUTH_REQUIRED', () => {
  const WS = 'ws-1';
  const build = (account: any) => {
    const socialPlanner = {
      listAccounts: jest.fn().mockResolvedValue([account]),
      networkStatus: jest.fn().mockResolvedValue({ secretBoxConfigured: true, FACEBOOK: true }),
      disconnectAccount: jest.fn(),
    };
    return new AccountCenterService(
      socialPlanner as any,
      { list: jest.fn().mockResolvedValue([]) } as any,
      { list: jest.fn().mockResolvedValue([]), status: jest.fn().mockReturnValue({ secretBoxConfigured: true }) } as any,
      { getEffective: jest.fn().mockResolvedValue({ features: { conversationAi: true } }) } as any,
      { start: jest.fn() } as any,
    );
  };
  const base = {
    id: 'a1', network: 'FACEBOOK', externalId: 'P1', displayName: 'Acme',
    connectedVia: 'OAUTH', enabled: true, lastError: null,
  };
  const metaOf = (r: any) => r.providers.find((p: any) => p.provider === 'META');

  it('flags an account whose token has already expired', async () => {
    const svc = build({ ...base, tokenExpiresAt: new Date(Date.now() - 60_000) });

    const r = await svc.getConnections(WS);

    expect(metaOf(r).connections[0].health).toBe('REAUTH_REQUIRED');
  });

  it('leaves a token with time left alone', async () => {
    const svc = build({ ...base, tokenExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000) });

    const r = await svc.getConnections(WS);

    expect(metaOf(r).connections[0].health).toBe('HEALTHY');
  });

  it('treats an unknown expiry as healthy, not as expired', async () => {
    // Null is "we were never told", which is the normal state for a
    // non-expiring token — failing closed here would flag every one of them.
    const svc = build({ ...base, tokenExpiresAt: null });

    const r = await svc.getConnections(WS);

    expect(metaOf(r).connections[0].health).toBe('HEALTHY');
  });
});
