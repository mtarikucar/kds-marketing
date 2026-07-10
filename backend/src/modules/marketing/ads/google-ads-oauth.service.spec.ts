import { BadRequestException } from '@nestjs/common';
import { GoogleAdsOAuthService } from './google-ads-oauth.service';
import * as stateUtil from '../social-planner/oauth/social-oauth-state.util';
import * as secretBox from '../../../common/crypto/secret-box.helper';
import * as config from './google-ads-oauth.config';
import * as safeFetchModule from '../../../common/util/safe-fetch';
import * as util from './google-ads.util';

const WS = 'ws-g-1';
const NETWORK = 'google-ads';

function makePrisma() {
  return {
    pendingSocialConnection: { create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  };
}

describe('GoogleAdsOAuthService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let adAccounts: { connect: jest.Mock };
  let svc: GoogleAdsOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    adAccounts = { connect: jest.fn() };
    svc = new GoogleAdsOAuthService(prisma as any, adAccounts as any);
    jest.restoreAllMocks();
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
    jest.spyOn(config, 'isGoogleAdsConfigured').mockReturnValue(true);
    jest.spyOn(secretBox, 'sealSecret').mockImplementation((s: string) => `sealed:${s}`);
    jest.spyOn(secretBox, 'openSecret').mockImplementation((s: string) => s.replace(/^sealed:/, ''));
  });

  describe('start', () => {
    it('throws when secret box is not configured', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('throws when the Google ads app is not configured', async () => {
      jest.spyOn(config, 'isGoogleAdsConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('returns an authorize URL bound to the workspace', async () => {
      jest.spyOn(stateUtil, 'signState').mockReturnValue('STATE');
      jest.spyOn(config, 'buildGoogleAdsAuthorizeUrl').mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?state=STATE');
      const out = await svc.start(WS);
      expect(out.authorizeUrl).toContain('state=STATE');
      expect((stateUtil.signState as jest.Mock).mock.calls[0][0]).toEqual({ workspaceId: WS, network: NETWORK });
    });
  });

  describe('handleCallback', () => {
    it('rejects an invalid/expired state', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue(null as any);
      await expect(svc.handleCallback('code', 'bad')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exchanges the code, lists customers, and seals a pending row', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({ workspaceId: WS, network: NETWORK } as any);
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({
        json: async () => ({ access_token: 'AT', refresh_token: 'RT' }),
      } as any);
      const gf = jest.spyOn(util, 'googleAdsFetch');
      // 1st call: listAccessibleCustomers
      gf.mockResolvedValueOnce({ ok: true, status: 200, data: { resourceNames: ['customers/123-456-7890'] }, error: null } as any);
      // 2nd call: per-customer descriptive query
      gf.mockResolvedValueOnce({ ok: true, status: 200, data: [{ results: [{ customer: { descriptiveName: 'Acme', currencyCode: 'USD' } }] }], error: null } as any);
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: 'pend-1' });

      const out = await svc.handleCallback('code', 'state');
      expect(out).toEqual({ pendingId: 'pend-1', workspaceId: WS });
      // refresh token (not the access token) is sealed into the pending payload.
      const payload = JSON.parse((prisma.pendingSocialConnection.create.mock.calls[0][0].data.payload as string).replace(/^sealed:/, ''));
      expect(payload.refreshToken).toBe('RT');
      expect(payload.accounts[0]).toMatchObject({ externalAdId: '1234567890', displayName: 'Acme', currency: 'USD' });
    });

    it('throws when the exchange returns no refresh token', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({ workspaceId: WS, network: NETWORK } as any);
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue({ json: async () => ({ access_token: 'AT' }) } as any);
      await expect(svc.handleCallback('code', 'state')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('confirm', () => {
    it('connects the selected customers with the sealed refresh token', async () => {
      const payload = { refreshToken: 'RT', accounts: [{ externalAdId: '111', displayName: 'A', currency: 'USD' }, { externalAdId: '222', displayName: 'B', currency: null }] };
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({ id: 'p', workspaceId: WS, network: NETWORK, payload: `sealed:${JSON.stringify(payload)}`, expiresAt: new Date(Date.now() + 60000) });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
      const out = await svc.confirm(WS, 'p', ['111']);
      expect(out).toEqual({ connected: 1 });
      expect(adAccounts.connect).toHaveBeenCalledTimes(1);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, expect.objectContaining({ provider: 'GOOGLE', externalAdId: '111', accessToken: 'RT' }));
    });

    it('rejects an expired pending row', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({ id: 'p', workspaceId: WS, network: NETWORK, payload: 'sealed:{}', expiresAt: new Date(Date.now() - 1000) });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
      await expect(svc.confirm(WS, 'p', ['111'])).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
