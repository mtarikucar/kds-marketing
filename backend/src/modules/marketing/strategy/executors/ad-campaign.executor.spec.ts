import { BadRequestException } from '@nestjs/common';
import { AdCampaignExecutor } from './ad-campaign.executor';

function deps(overrides: { account?: any; createResult?: any; createError?: any } = {}) {
  const prisma = {
    adAccount: {
      findFirst: jest.fn().mockResolvedValue(
        overrides.account === undefined
          ? { id: 'acc1', workspaceId: 'ws1', provider: 'META', status: 'ACTIVE' }
          : overrides.account,
      ),
    },
  };
  const ads = {
    create: jest.fn(async () => {
      if (overrides.createError) throw overrides.createError;
      return overrides.createResult ?? { ok: true, id: 'camp1' };
    }),
    // spend/activation surfaces — the executor must NEVER touch these.
    setStatus: jest.fn(),
    setDailyBudget: jest.fn(),
    launchAdFromCreative: jest.fn(),
    duplicate: jest.fn(),
  };
  const svc = new AdCampaignExecutor(prisma as any, ads as any);
  return { svc, prisma, ads };
}

const PAYLOAD = {
  objective: 'leads',
  channelKey: 'meta',
  dailyBudget: 25,
  audience: 'salon owners in Istanbul',
  angle: 'Book more appointments',
};

describe('AdCampaignExecutor', () => {
  it('has kind AD_CAMPAIGN', () => {
    expect(deps().svc.kind).toBe('AD_CAMPAIGN');
  });

  it('creates a PAUSED campaign shell and returns campaign ref', async () => {
    const { svc, prisma, ads } = deps();
    const r = await svc.run('ws1', PAYLOAD);

    // Finds a connected, ACTIVE Meta ad account for the workspace.
    expect(prisma.adAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws1', provider: 'META', status: 'ACTIVE' }) }),
    );
    // Creates the shell (name + mapped Meta objective) — nothing else.
    expect(ads.create).toHaveBeenCalledWith(
      'ws1',
      'acc1',
      expect.objectContaining({ objective: 'OUTCOME_LEADS', name: expect.any(String) }),
    );
    expect(r).toEqual({ resultRef: 'campaign:camp1' });
  });

  it('NEVER calls any start/activate/spend path (pure shell)', async () => {
    const { svc, ads } = deps();
    await svc.run('ws1', PAYLOAD);
    expect(ads.setStatus).not.toHaveBeenCalled();
    expect(ads.setDailyBudget).not.toHaveBeenCalled();
    expect(ads.launchAdFromCreative).not.toHaveBeenCalled();
    expect(ads.duplicate).not.toHaveBeenCalled();
    // create is only ever called with the default-PAUSED shape (no status/ACTIVE).
    expect(ads.create).toHaveBeenCalledTimes(1);
    const input = ads.create.mock.calls[0][2];
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('dailyBudget');
  });

  it('degrades gracefully (resultRef undefined) when no Meta ad account is connected', async () => {
    const { svc, ads } = deps({ account: null });
    const r = await svc.run('ws1', PAYLOAD);
    expect(r).toEqual({ resultRef: undefined });
    expect(ads.create).not.toHaveBeenCalled();
  });

  it('maps common objectives to Meta OUTCOME_* and defaults unknown to traffic', async () => {
    const { svc, ads } = deps();
    await svc.run('ws1', { objective: 'awareness' });
    expect(ads.create).toHaveBeenLastCalledWith('ws1', 'acc1', expect.objectContaining({ objective: 'OUTCOME_AWARENESS' }));
    await svc.run('ws1', { objective: 'something-weird' });
    expect(ads.create).toHaveBeenLastCalledWith('ws1', 'acc1', expect.objectContaining({ objective: 'OUTCOME_TRAFFIC' }));
    await svc.run('ws1', { objective: 'OUTCOME_SALES' });
    expect(ads.create).toHaveBeenLastCalledWith('ws1', 'acc1', expect.objectContaining({ objective: 'OUTCOME_SALES' }));
  });

  it('returns undefined ref when the create result carries no id', async () => {
    const { svc } = deps({ createResult: { ok: true } });
    expect(await svc.run('ws1', PAYLOAD)).toEqual({ resultRef: undefined });
  });

  it('throws on a missing objective', async () => {
    const { svc, prisma } = deps();
    await expect(svc.run('ws1', {})).rejects.toThrow(BadRequestException);
    await expect(svc.run('ws1', { objective: '  ' })).rejects.toThrow(BadRequestException);
    expect(prisma.adAccount.findFirst).not.toHaveBeenCalled();
  });

  it('throws on a non-object payload', async () => {
    const { svc } = deps();
    await expect(svc.run('ws1', null)).rejects.toThrow(BadRequestException);
  });
});
