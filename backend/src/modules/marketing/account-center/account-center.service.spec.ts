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
    it('returns an authorize URL routed through the identity provider network', () => {
      expect(svc.reauth(WS, 'META:P1')).toEqual({ authorizeUrl: 'https://fb/auth' });
      expect(socialOAuth.start).toHaveBeenCalledWith(WS, 'FACEBOOK', 'account-center');
    });

    it('rejects reauth for a non-OAuth provider', () => {
      expect(() => svc.reauth(WS, 'SMS:x')).toThrow(BadRequestException);
    });
  });
});
