import { BadRequestException } from '@nestjs/common';
import { TiktokBusinessOAuthService } from './tiktok-business-oauth.service';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import { isSecretBoxConfigured, sealSecret, openSecret } from '../../../common/crypto/secret-box.helper';
import { isTiktokBusinessConfigured, buildTiktokBusinessAuthorizeUrl } from './tiktok-business-oauth.config';
import { safeFetch } from '../../../common/util/safe-fetch';
import { tiktokBusinessFetch } from '../channels/tiktok-business.util';

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
jest.mock('./tiktok-business-oauth.config', () => ({
  ...jest.requireActual('./tiktok-business-oauth.config'),
  isTiktokBusinessConfigured: jest.fn(),
  buildTiktokBusinessAuthorizeUrl: jest.fn(),
}));
jest.mock('../../../common/util/safe-fetch', () => ({
  ...jest.requireActual('../../../common/util/safe-fetch'),
  safeFetch: jest.fn(),
}));
jest.mock('../channels/tiktok-business.util', () => ({
  ...jest.requireActual('../channels/tiktok-business.util'),
  tiktokBusinessFetch: jest.fn(),
}));

const signStateMock = signState as unknown as jest.Mock;
const verifyStateMock = verifyState as unknown as jest.Mock;
const isSecretBoxConfiguredMock = isSecretBoxConfigured as unknown as jest.Mock;
const sealSecretMock = sealSecret as unknown as jest.Mock;
const openSecretMock = openSecret as unknown as jest.Mock;
const isTiktokBusinessConfiguredMock = isTiktokBusinessConfigured as unknown as jest.Mock;
const buildTiktokBusinessAuthorizeUrlMock = buildTiktokBusinessAuthorizeUrl as unknown as jest.Mock;
const safeFetchMock = safeFetch as unknown as jest.Mock;
const tiktokBusinessFetchMock = tiktokBusinessFetch as unknown as jest.Mock;
const allMocks = [
  signStateMock, verifyStateMock, isSecretBoxConfiguredMock, sealSecretMock, openSecretMock,
  isTiktokBusinessConfiguredMock, buildTiktokBusinessAuthorizeUrlMock, safeFetchMock, tiktokBusinessFetchMock,
];

const WS = 'ws-test-1';
const PENDING_ID = 'pending-uuid-1';

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
  return {
    connect: jest.fn(),
  };
}

function makeChannels() {
  return {
    create: jest.fn(),
  };
}

describe('TiktokBusinessOAuthService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let adAccounts: ReturnType<typeof makeAdAccounts>;
  let channels: ReturnType<typeof makeChannels>;
  let svc: TiktokBusinessOAuthService;

  beforeEach(() => {
    prisma = makePrisma();
    adAccounts = makeAdAccounts();
    channels = makeChannels();
    svc = new TiktokBusinessOAuthService(prisma as any, adAccounts as any, channels as any);
    jest.restoreAllMocks();
    allMocks.forEach((m) => m.mockReset());
    // Default: everything configured
    isSecretBoxConfiguredMock.mockReturnValue(true);
    isTiktokBusinessConfiguredMock.mockReturnValue(true);
  });

  // ── start ─────────────────────────────────────────────────────────────────

  describe('start', () => {
    it('throws BadRequest when secret box is not configured', async () => {
      isSecretBoxConfiguredMock.mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when TikTok Business is not configured', async () => {
      isTiktokBusinessConfiguredMock.mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns authorizeUrl built from state that encodes the workspaceId', async () => {
      signStateMock.mockReturnValue('signed-state-token');
      buildTiktokBusinessAuthorizeUrlMock.mockReturnValue('https://tiktok.com/auth?state=signed-state-token');
      const result = await svc.start(WS);
      expect(signStateMock).toHaveBeenCalledWith({ workspaceId: WS, network: 'TIKTOK_BUSINESS' });
      expect(result).toEqual({ authorizeUrl: 'https://tiktok.com/auth?state=signed-state-token' });
    });
  });

  // ── handleCallback ─────────────────────────────────────────────────────────

  describe('handleCallback', () => {
    const validState = 'valid.state';
    const code = 'auth-code-123';

    beforeEach(() => {
      verifyStateMock.mockReturnValue({
        workspaceId: WS,
        network: 'TIKTOK_BUSINESS',
        nonce: 'abc',
        exp: Date.now() + 60_000,
      });
    });

    it('throws BadRequest when state is null/invalid', async () => {
      verifyStateMock.mockReturnValue(null);
      await expect(svc.handleCallback(code, 'bad-state')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when network is wrong', async () => {
      verifyStateMock.mockReturnValue({
        workspaceId: WS,
        network: 'FACEBOOK',
        nonce: 'abc',
        exp: Date.now() + 60_000,
      });
      await expect(svc.handleCallback(code, validState)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('exchanges the code and creates a pending row, returning pendingId + workspaceId', async () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'app1';
      process.env.TIKTOK_BUSINESS_APP_SECRET = 'secret1';

      const mockResponse = {
        json: async () => ({
          code: 0,
          data: {
            access_token: 'tok-abc',
            advertiser_ids: ['adv_1', 'adv_2'],
            scope: ['advertiser', 'messaging_write'],
          },
        }),
      } as any;
      safeFetchMock.mockResolvedValue(mockResponse);

      // Mock advertiser info fetch
      tiktokBusinessFetchMock
        .mockResolvedValueOnce({ ok: true, data: { list: [{ name: 'Adv One', currency: 'USD' }] } })
        .mockResolvedValueOnce({ ok: true, data: { list: [{ name: 'Adv Two', currency: 'EUR' }] } });

      sealSecretMock.mockReturnValue('v1:sealed');
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      const result = await svc.handleCallback(code, validState);

      expect(safeFetchMock).toHaveBeenCalledWith(
        expect.stringContaining('oauth2/access_token'),
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toEqual({ pendingId: PENDING_ID, workspaceId: WS });
      const createArg = prisma.pendingSocialConnection.create.mock.calls[0][0] as any;
      expect(createArg.data.network).toBe('TIKTOK_BUSINESS');
      expect(createArg.data.workspaceId).toBe(WS);
    });

    it('falls back gracefully when advertiser info fetch fails', async () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'app1';
      process.env.TIKTOK_BUSINESS_APP_SECRET = 'secret1';

      const mockResponse = {
        json: async () => ({
          code: 0,
          data: {
            access_token: 'tok-abc',
            advertiser_ids: ['adv_1'],
            scope: [],
          },
        }),
      } as any;
      safeFetchMock.mockResolvedValue(mockResponse);
      tiktokBusinessFetchMock.mockResolvedValue({ ok: false, error: { message: 'fail' } as any });
      sealSecretMock.mockReturnValue('v1:sealed');
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      const result = await svc.handleCallback(code, validState);
      expect(result.pendingId).toBe(PENDING_ID);
      // Just verify create was called with the sealed payload
      const createArg = prisma.pendingSocialConnection.create.mock.calls[0][0] as any;
      expect(createArg.data.payload).toBe('v1:sealed');
    });

    it('detects messaging scope from scope array containing "messaging"', async () => {
      process.env.TIKTOK_BUSINESS_APP_ID = 'app1';
      process.env.TIKTOK_BUSINESS_APP_SECRET = 'secret1';

      const mockResponse = {
        json: async () => ({
          code: 0,
          data: {
            access_token: 'tok',
            advertiser_ids: ['adv_1'],
            scope: ['messaging_write', 'advertiser_basic'],
          },
        }),
      } as any;
      safeFetchMock.mockResolvedValue(mockResponse);
      tiktokBusinessFetchMock.mockResolvedValue({
        ok: true,
        data: { list: [{ name: 'A', currency: 'USD' }] },
      });
      sealSecretMock.mockImplementation((s) => `sealed:${s}`);
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      await svc.handleCallback(code, validState);

      // The payload sealed must include messaging:true
      const sealArg = sealSecretMock.mock.calls[0][0];
      const payload = JSON.parse(sealArg);
      expect(payload.messaging).toBe(true);
    });
  });

  // ── listPending ────────────────────────────────────────────────────────────

  describe('listPending', () => {
    it('throws BadRequest when the pending row does not exist', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue(null);
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns advertisers + messaging from sealed payload (no token)', async () => {
      const payloadObj = {
        token: 'secret-token',
        advertisers: [{ externalAdId: 'adv_1', displayName: 'Adv One', currency: 'USD' }],
        messaging: true,
      };
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed-payload',
        expiresAt: new Date(Date.now() + 600_000),
      });
      openSecretMock.mockReturnValue(JSON.stringify(payloadObj));

      const result = await svc.listPending(WS, PENDING_ID);
      expect(result).toEqual({
        advertisers: payloadObj.advertisers,
        messaging: true,
      });
      // MUST NOT leak the token
      expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it('treats an expired pending row as not-found and deletes it', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed-payload',
        expiresAt: new Date(Date.now() - 1000),
      });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
      await expect(svc.listPending(WS, PENDING_ID)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({
        where: { id: PENDING_ID },
      });
    });
  });

  // ── confirm ───────────────────────────────────────────────────────────────

  describe('confirm', () => {
    const payloadObj = {
      token: 'raw-tok',
      advertisers: [
        { externalAdId: 'adv_1', displayName: 'Adv One', currency: 'USD' },
        { externalAdId: 'adv_2', displayName: 'Adv Two', currency: 'EUR' },
      ],
      messaging: true,
    };

    beforeEach(() => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue({
        id: PENDING_ID,
        payload: 'sealed',
        expiresAt: new Date(Date.now() + 600_000),
      });
      openSecretMock.mockReturnValue(JSON.stringify(payloadObj));
      adAccounts.connect.mockResolvedValue({ id: 'acc1' });
      channels.create.mockResolvedValue({ id: 'ch1' });
      prisma.pendingSocialConnection.delete.mockResolvedValue({});
    });

    it('throws BadRequest when pending row not found', async () => {
      prisma.pendingSocialConnection.findFirst.mockResolvedValue(null);
      await expect(
        svc.confirm(WS, PENDING_ID, { selected: ['adv_1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('calls adAccounts.connect for each selected advertiser', async () => {
      await svc.confirm(WS, PENDING_ID, { selected: ['adv_1', 'adv_2'] });
      expect(adAccounts.connect).toHaveBeenCalledTimes(2);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, {
        provider: 'TIKTOK',
        externalAdId: 'adv_1',
        accessToken: 'raw-tok',
        displayName: 'Adv One',
        currency: 'USD',
      });
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, {
        provider: 'TIKTOK',
        externalAdId: 'adv_2',
        accessToken: 'raw-tok',
        displayName: 'Adv Two',
        currency: 'EUR',
      });
    });

    it('returns connectedAdAccounts count and dmChannel:false when enableMessaging is false', async () => {
      const result = await svc.confirm(WS, PENDING_ID, { selected: ['adv_1'], enableMessaging: false });
      expect(result.connectedAdAccounts).toBe(1);
      expect(result.dmChannel).toBe(false);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('provisions a DM channel when enableMessaging:true and payload.messaging is true', async () => {
      const result = await svc.confirm(WS, PENDING_ID, { selected: ['adv_1'], enableMessaging: true });
      expect(result.dmChannel).toBe(true);
      expect(channels.create).toHaveBeenCalledWith(WS, {
        type: 'TIKTOK',
        name: 'TikTok DM',
        externalId: 'adv_1',
        secrets: { accessToken: 'raw-tok' },
        configPublic: { connectedVia: 'OAUTH', messaging: 'granted' },
      });
    });

    it('skips DM channel (no error) when enableMessaging:true but payload.messaging is false', async () => {
      openSecretMock.mockReturnValue(
        JSON.stringify({ ...payloadObj, messaging: false }),
      );
      const result = await svc.confirm(WS, PENDING_ID, { selected: ['adv_1'], enableMessaging: true });
      expect(result.dmChannel).toBe(false);
      expect(channels.create).not.toHaveBeenCalled();
    });

    it('skips duplicate DM channel (ConflictException swallowed) and still returns dmChannel:false', async () => {
      const { ConflictException } = require('@nestjs/common');
      channels.create.mockRejectedValue(new ConflictException('already exists'));
      const result = await svc.confirm(WS, PENDING_ID, { selected: ['adv_1'], enableMessaging: true });
      expect(result.connectedAdAccounts).toBe(1);
      expect(result.dmChannel).toBe(false);
    });

    it('deletes the pending row after confirming', async () => {
      await svc.confirm(WS, PENDING_ID, { selected: ['adv_1'] });
      expect(prisma.pendingSocialConnection.delete).toHaveBeenCalledWith({ where: { id: PENDING_ID } });
    });

    it('only connects selected advertisers (not all in payload)', async () => {
      await svc.confirm(WS, PENDING_ID, { selected: ['adv_2'] });
      expect(adAccounts.connect).toHaveBeenCalledTimes(1);
      expect(adAccounts.connect).toHaveBeenCalledWith(WS, expect.objectContaining({ externalAdId: 'adv_2' }));
    });
  });
});
