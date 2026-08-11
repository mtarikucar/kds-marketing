import { StrategyProvisioningService } from './strategy-provisioning.service';
import { MarketingStrategyBrief } from '../strategy.types';

const WS = 'ws-1';

const BRIEF: MarketingStrategyBrief = {
  identity: {
    product: 'Nostaljik Metin2 Sunucusu',
    voice: 'samimi, oyuncu diliyle',
    positioning: 'Eski usul MMO deneyimi',
    usp: 'Pay-to-win yok',
  },
  audience: '25-35 yaş, nostaljik MMO oyuncuları',
  channels: [{ key: 'discord', fitScore: 0.9, rationale: 'community lives there' }],
  contentPillars: [{ title: 'Patch notes', angle: 'transparency', formats: ['post'], tone: 'playful' }],
  goals: { objective: 'İlk 3 ayda 500 aktif oyuncu', kpis: ['DAU'] },
  budget: 'bootstrap',
  competitors: ['other private servers'],
};

function makeDeps(agentCount = 0) {
  const prisma = {
    agentProfile: { count: jest.fn().mockResolvedValue(agentCount) },
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ productName: 'Metin2 Sunucu', defaultLanguage: 'tr' }),
    },
  };
  const agents = { create: jest.fn().mockResolvedValue({ id: 'agent-1' }) };
  return { svc: new StrategyProvisioningService(prisma as any, agents as any), prisma, agents };
}

describe('StrategyProvisioningService', () => {
  it('creates ONE default agent grounded in the strategy brief', async () => {
    const { svc, agents } = makeDeps(0);
    await svc.ensureDefaultAgent(WS, BRIEF);

    expect(agents.create).toHaveBeenCalledTimes(1);
    const [ws, dto] = agents.create.mock.calls[0];
    expect(ws).toBe(WS);
    expect(dto.name).toContain('Nostaljik Metin2 Sunucusu');
    // The persona comes from the brief, not a template — that is the whole
    // reason the system can build this instead of asking the user to.
    expect(dto.persona).toContain('Pay-to-win yok');
    expect(dto.persona).toContain('25-35 yaş');
    expect(dto.tone).toBe('samimi, oyuncu diliyle');
    expect(dto.goals).toBe('İlk 3 ayda 500 aktif oyuncu');
    expect(dto.language).toBe('tr');
    // No channels: nothing may start talking to customers before the user
    // connects and attaches one.
    expect(dto.channels).toBeUndefined();
  });

  it('never touches a workspace that already has agents (re-synthesis must not overwrite)', async () => {
    const { svc, agents } = makeDeps(2);
    await svc.ensureDefaultAgent(WS, BRIEF);
    expect(agents.create).not.toHaveBeenCalled();
  });

  it('swallows a provisioning failure — the strategy is the deliverable', async () => {
    const { svc, agents } = makeDeps(0);
    agents.create.mockRejectedValue(new Error('Agent limit reached'));
    await expect(svc.ensureDefaultAgent(WS, BRIEF)).resolves.toBeUndefined();
  });
});
