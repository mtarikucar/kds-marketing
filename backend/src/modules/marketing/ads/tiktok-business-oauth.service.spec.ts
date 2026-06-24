import { BadRequestException } from '@nestjs/common';
import { TiktokBusinessOAuthService } from './tiktok-business-oauth.service';
import * as stateUtil from '../social-planner/oauth/social-oauth-state.util';
import * as secretBox from '../../../common/crypto/secret-box.helper';
import * as config from './tiktok-business-oauth.config';
import * as safeFetchModule from '../../../common/util/safe-fetch';
import * as tiktokUtil from '../channels/tiktok-business.util';

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
    // Default: everything configured
    jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(true);
    jest.spyOn(config, 'isTiktokBusinessConfigured').mockReturnValue(true);
  });

  // ── start ─────────────────────────────────────────────────────────────────

  describe('start', () => {
    it('throws BadRequest when secret box is not configured', async () => {
      jest.spyOn(secretBox, 'isSecretBoxConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when TikTok Business is not configured', async () => {
      jest.spyOn(config, 'isTiktokBusinessConfigured').mockReturnValue(false);
      await expect(svc.start(WS)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns authorizeUrl built from state that encodes the workspaceId', async () => {
      jest.spyOn(stateUtil, 'signState').mockReturnValue('signed-state-token');
      jest.spyOn(config, 'buildTiktokBusinessAuthorizeUrl').mockReturnValue('https://tiktok.com/auth?state=signed-state-token');
      const result = await svc.start(WS);
      expect(stateUtil.signState).toHaveBeenCalledWith({ workspaceId: WS, network: 'TIKTOK_BUSINESS' });
      expect(result).toEqual({ authorizeUrl: 'https://tiktok.com/auth?state=signed-state-token' });
    });
  });

  // ── handleCallback ─────────────────────────────────────────────────────────

  describe('handleCallback', () => {
    const validState = 'valid.state';
    const code = 'auth-code-123';

    beforeEach(() => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({
        workspaceId: WS,
        network: 'TIKTOK_BUSINESS',
        nonce: 'abc',
        exp: Date.now() + 60_000,
      });
    });

    it('throws BadRequest when state is null/invalid', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue(null);
      await expect(svc.handleCallback(code, 'bad-state')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when network is wrong', async () => {
      jest.spyOn(stateUtil, 'verifyState').mockReturnValue({
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
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(mockResponse);

      // Mock advertiser info fetch
      jest.spyOn(tiktokUtil, 'tiktokBusinessFetch')
        .mockResolvedValueOnce({ ok: true, data: { list: [{ name: 'Adv One', currency: 'USD' }] } })
        .mockResolvedValueOnce({ ok: true, data: { list: [{ name: 'Adv Two', currency: 'EUR' }] } });

      jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      const result = await svc.handleCallback(code, validState);

      expect(safeFetchModule.safeFetch).toHaveBeenCalledWith(
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
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(mockResponse);
      jest.spyOn(tiktokUtil, 'tiktokBusinessFetch').mockResolvedValue({ ok: false, error: { message: 'fail' } as any });
      jest.spyOn(secretBox, 'sealSecret').mockReturnValue('v1:sealed');
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
      jest.spyOn(safeFetchModule, 'safeFetch').mockResolvedValue(mockResponse);
      jest.spyOn(tiktokUtil, 'tiktokBusinessFetch').mockResolvedValue({
        ok: true,
        data: { list: [{ name: 'A', currency: 'USD' }] },
      });
      jest.spyOn(secretBox, 'sealSecret').mockImplementation((s) => `sealed:${s}`);
      prisma.pendingSocialConnection.create.mockResolvedValue({ id: PENDING_ID });

      await svc.handleCallback(code, validState);

      // The payload sealed must include messaging:true
      const sealArg = (secretBox.sealSecret as jest.Mock).mock.calls[0][0];
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
      });
      jest.spyOn(secretBox, 'openSecret').mockReturnValue(JSON.stringify(payloadObj));

      const result = await svc.listPending(WS, PENDING_ID);
      expect(result).toEqual({
        advertisers: payloadObj.advertisers,
        messaging: true,
      });
      // MUST NOT leak the token
      expect(JSON.stringify(result)).not.toContain('secret-token');
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
      });
      jest.spyOn(secretBox, 'openSecret').mockReturnValue(JSON.stringify(payloadObj));
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
      jest.spyOn(secretBox, 'openSecret').mockReturnValue(
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
