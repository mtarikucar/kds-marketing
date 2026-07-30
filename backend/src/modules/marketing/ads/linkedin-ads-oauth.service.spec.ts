import { BadRequestException } from '@nestjs/common';
import { LinkedinAdsOAuthService } from './linkedin-ads-oauth.service';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import { isSecretBoxConfigured, sealSecret, openSecret } from '../../../common/crypto/secret-box.helper';
import {
  isLinkedinAdsConfigured,
  buildLinkedinAdsAuthorizeUrl,
  LINKEDIN_ADS_TOKEN_URL,
} from './linkedin-ads-oauth.config';
import { safeFetch } from '../../../common/util/safe-fetch';
import { linkedinRest } from '../../../common/util/linkedin-api.util';

// Module mocks (not jest.spyOn on the namespace objects): ESM->CJS emitters that
// define exports as non-configurable getters make namespace spying impossible.
// Everything not listed here stays the real implementation.
jest.mock('../social-planner/oauth/social-oauth-state.util', () => ({
  ...jest.requireActual('../social-planner/oauth/social-oauth-state.util'),
  signState: jest.fn(),
  verifyState: jest.fn(),
}));
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  ...jest.requireActual('../../../common/crypto/secret-box.helper'),
  isSecretBoxConfigured: jest.fn(),
  sealSecret: jest.fn(),
  openSecret: jest.fn(),
}));
jest.mock('./linkedin-ads-oauth.config', () => ({
  ...jest.requireActual('./linkedin-ads-oauth.config'),
  isLinkedinAdsConfigured: jest.fn(),
  buildLinkedinAdsAuthorizeUrl: jest.fn(),
}));
jest.mock('../../../common/util/safe-fetch', () => ({
  ...jest.requireActual('../../../common/util/safe-fetch'),
  safeFetch: jest.fn(),
}));
jest.mock('../../../common/util/linkedin-api.util', () => ({
  ...jest.requireActual('../../../common/util/linkedin-api.util'),
  linkedinRest: jest.fn(),
}));

const signStateMock = signState as unknown as jest.Mock;
const verifyStateMock = verifyState as unknown as jest.Mock;
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const sealSecretMock = sealSecret as unknown as jest.Mock;
const openSecretMock = openSecret as unknown as jest.Mock;
const isLinkedinAdsConfiguredMock = isLinkedinAdsConfigured as unknown as jest.Mock;
const buildLinkedinAdsAuthorizeUrlMock = buildLinkedinAdsAuthorizeUrl as unknown as jest.Mock;
const safeFetchMock = safeFetch as unknown as jest.Mock;
const linkedinRestMock = linkedinRest as unknown as jest.Mock;
const allMocks = [
  signStateMock, verifyStateMock, isSecretBoxConfiguredMock, sealSecretMock, openSecretMock,
  isLinkedinAdsConfiguredMock, buildLinkedinAdsAuthorizeUrlMock, safeFetchMock, linkedinRestMock,
];

const WS = 'ws-li-1';
const PENDING_ID = 'pending-li-1';
const NETWORK = 'linkedin-ads';

function makePrisma() {
  return {
    pendingSocialConnection: {
      create: jest.fn(),
      findFirst: jest.fn(),
      delete: jest.fn(),
    },
  };
}
function makeAdAccounts() {
  return { connect: jest.fn() };
}

describe('LinkedinAdsOAuthService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let adAccounts: ReturnType<typeof makeAdAccounts>;
  let svc: LinkedinAdsOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    adAccounts = makeAdAccounts();
    svc = new LinkedinAdsOAuthService(prisma as any, adAccounts as any);
    jest.restoreAllMocks();
    allMocks.forEach((m) => m.mockReset());
    isSecretBoxConfiguredMock.mockReturnValue(true);
    isLinkedinAdsConfiguredMock.mockReturnValue(true);
  });

  // ── start ──────────────────────────────────────────────────────────────────
  describe('start', () => {
    it('throws when secret box is not configured', async () => {
      isSecretBoxConfiguredMock.mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the LinkedIn ads app is not configured', async () => {
      isLinkedinAdsConfiguredMock.mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('signs state with the linkedin-ads network and returns the authorize URL', async () => {
      signStateMock.mockReturnValue('signed');
      buildLinkedinAdsAuthorizeUrlMock.mockReturnValue('https://li/auth?state=signed');
      const r = await svc.start(WS);
      expect(signStateMock).toHaveBeenCalledWith({ workspaceId: WS, network: NETWORK });
      expect(r).toEqual({ authorizeUrl: 'https://li/auth?state=signed' });
    });
  });

  // ── handleCallback ──────────────────────────────────────────────────────────
  describe('handleCallback', () => {
    beforeEach(() => {
      verifyStateMock.mockReturnValue({
        workspaceId: WS,
        network: NETWORK,
        nonce: 'n',
        exp: Date.now() + 60_000,
      });
    });

    it('throws when state is invalid', async () => {
      verifyStateMock.mockReturnValue(null);
      await expect(svc.handleCallback('code', 'bad')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws on a network mismatch', async () => {
      verifyStateMock.mockReturnValue({
        workspaceId: WS,
        network: 'linkedin', // social network, not ads
        nonce: 'n',
        exp: Date.now() + 60_000,
      });
      await expect(svc.handleCallback('code', 'st')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exchanges the code, lists ad accounts, seals a pending row', async () => {
      process.env.LINKEDIN_ADS_CLIENT_ID = 'cid';
      process.env.LINKEDIN_ADS_CLIENT_SECRET = 'sec';
      safeFetchMock.mockResolvedValue({
        json: async () => ({ access_token: 'li-tok', expires_in: 5184000 }),
      } as any);
      const restSpy = linkedinRestMock
        // adAccountUsers
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { elements: [{ account: 'urn:li:sponsoredAccount:111', role: 'ACCOUNT_MANAGER' }] },
          restliId: null,
          error: null,
        } as any)
        // adAccounts/111
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { id: 111, name: 'Acme Ads', currency: 'USD', status: 'ACTIVE' },
          restliId: null,
          error: null,
        } as any);
      sealSecretMock.mockReturnValue('v1:sealed');
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      const r = await svc.handleCallback('code', 'st');

      expect(safeFetchMock).toHaveBeenCalledWith(
        LINKEDIN_ADS_TOKEN_URL,
        expect.objectContaining({ method: 'POST' }),
      );
      expect(restSpy.mock.calls[0][0]).toContain('/rest/adAccountUsers?q=authenticatedUser');
      expect(r).toEqual({ pendingId: PENDING_ID, workspaceId: WS });
      const createArg = prisma.pendingSocialConnection.create.mock.calls[0][0] as any;
      expect(createArg.data.network).toBe(NETWORK);
      expect(createArg.data.workspaceId).toBe(WS);
      // sealed payload carries the account, never echoed
      const sealed = JSON.parse(sealSecretMock.mock.calls[0][0]);
      expect(sealed.token).toBe('li-tok');
      expect(sealed.accounts[0]).toMatchObject({ externalAdId: '111', displayName: 'Acme Ads', currency: 'USD' });
    });

    it('throws when the token exchange returns no access_token', async () => {
      safeFetchMock.mockResolvedValue({
        json: async () => ({ error: 'invalid_grant' }),
      } as any);
      await expect(svc.handleCallback('code', 'st')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── listPending ──────────────────────────────────────────────────────────────
  describe('listPending', () => {
    it('throws when the row is missing', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue(null);
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns accounts WITHOUT the token', async () => {
      const payload = {
        token: 'secret-token',
        accounts: [{ externalAdId: '111', displayName: 'Acme', currency: 'USD' }],
      };
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() + 600_000),
      });
      openSecretMock.mockReturnValue(JSON.stringify(payload));
      const r = await svc.listPending(WS, PENDING_ID);
      expect(r).toEqual({ accounts: payload.accounts });
      expect(JSON.stringify(r)).not.toContain('secret-token');
    });

    it('treats an expired row as not-found and deletes it', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() - 1000),
      });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    });
  });

  // ── confirm ───────────────────────────────────────────────────────────────────
  describe('confirm', () => {
    const payload = {
      token: 'raw-tok',
      accounts: [
        { externalAdId: '111', displayName: 'Acme', currency: 'USD' },
        { externalAdId: '222', displayName: 'Beta', currency: 'EUR' },
      ],
    };

    beforeEach(() => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() + 600_000),
      });
      openSecretMock.mockReturnValue(JSON.stringify(payload));
      adAccounts.connect.mockResolvedValue({ id: 'acc' });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
    });

    it('provisions a sealed LINKEDIN AdAccount via connect() for each selected account', async () => {
      const r = await svc.confirm(WS, PENDING_ID, ['111', '222']);
      expect(adAccounts.connect).toHaveBeenCalledTimes(2);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, {
        provider: 'LINKEDIN',
        externalAdId: '111',
        accessToken: 'raw-tok',
        displayName: 'Acme',
        currency: 'USD',
      });
      expect(r).toEqual({ connected: 2 });
    });

    it('only connects selected accounts', async () => {
      await svc.confirm(WS, PENDING_ID, ['222']);
      expect(adAccounts.connect).toHaveBeenCalledTimes(1);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, expect.objectContaining({ externalAdId: '222' }));
    });

    it('deletes the pending row after confirming', async () => {
      await svc.confirm(WS, PENDING_ID, ['111']);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    });
  });
});
