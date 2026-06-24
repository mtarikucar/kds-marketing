import { BadRequestException } from '@nestjs/common';
import * as client from './meta-ads-management.client';
import { AdManagementService } from './ad-management.service';

jest.mock('./meta-ads-management.client');
jest.mock('../../../common/crypto/secret-box.helper', () => ({ openSecret: () => 'TOKEN' }));

const mClient = client as jest.Mocked<typeof client>;

describe('AdManagementService', () => {
  let prisma: any;
  let svc: AdManagementService;

  beforeAll(() => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
  });
  afterAll(() => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });
  beforeEach(() => {
    prisma = { adAccount: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) } };
    svc = new AdManagementService(prisma);
    jest.clearAllMocks();
  });

  const metaAcc = () => ({ id: 'acc', workspaceId: 'ws', provider: 'META', externalAdId: 'act_1', accessToken: 'sealed' });

  it('rejects management on a non-Meta account', async () => {
    prisma.adAccount.findFirst.mockResolvedValue({ id: 'acc', provider: 'TIKTOK', accessToken: 'x' });
    await expect(svc.campaigns('ws', 'acc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists campaigns with budgets converted cents→major', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.listCampaigns.mockResolvedValue({
      ok: true,
      items: [{ id: 'c1', name: 'C1', status: 'ACTIVE', dailyBudget: 5000, lifetimeBudget: null }],
    });
    const out = await svc.campaigns('ws', 'acc');
    expect(out[0].dailyBudget).toBe(50);
    expect(mClient.listCampaigns).toHaveBeenCalledWith('TOKEN', 'act_1');
  });

  it('setDailyBudget converts major→cents', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.updateEntity.mockResolvedValue({ ok: true, id: 'c1' });
    await svc.setDailyBudget('ws', 'acc', 'c1', 75);
    expect(mClient.updateEntity).toHaveBeenCalledWith('TOKEN', 'c1', { daily_budget: 7500 });
  });

  it('setStatus rejects an invalid status', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    await expect(svc.setStatus('ws', 'acc', 'c1', 'FOO' as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('flips account to TOKEN_EXPIRED on an auth error', async () => {
    prisma.adAccount.findFirst.mockResolvedValue(metaAcc());
    mClient.listCampaigns.mockResolvedValue({ ok: false, items: [], error: 'bad token', isAuthError: true });
    await expect(svc.campaigns('ws', 'acc')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.adAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'TOKEN_EXPIRED' }) }),
    );
  });
});
