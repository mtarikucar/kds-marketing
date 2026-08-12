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
    brandProfile: { findUnique: jest.fn().mockResolvedValue(null) },
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
    // Brand name absent → workspace product name wins; the brief's product
    // DESCRIPTION is only a last resort (it is a sentence, not a label).
    expect(dto.name).toBe('Metin2 Sunucu Asistanı');
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

/**
 * `brief.identity.product` is a DESCRIPTION — strategists write it as a full
 * sentence. Using it as the agent label produced an agent literally named after
 * a truncated paragraph on the first real customer workspace.
 */
describe('StrategyProvisioningService — agent naming', () => {
  const longProduct =
    "Custom, hand-painted resin figurines sculpted from customers' own photos — a keepsake version of the people they love";

  it('prefers the BRAND name over everything', async () => {
    const { svc, prisma, agents } = makeDeps(0);
    prisma.brandProfile.findUnique.mockResolvedValue({ brandName: 'Figurunica' });

    await svc.ensureDefaultAgent(WS, { ...BRIEF, identity: { ...BRIEF.identity, product: longProduct } });

    expect(agents.create.mock.calls[0][1].name).toBe('Figurunica Asistanı');
  });

  it('falls back to the workspace product NAME when there is no brand', async () => {
    const { svc, agents } = makeDeps(0);

    await svc.ensureDefaultAgent(WS, { ...BRIEF, identity: { ...BRIEF.identity, product: longProduct } });

    expect(agents.create.mock.calls[0][1].name).toBe('Metin2 Sunucu Asistanı');
  });

  it('trims a description fallback at a word boundary, never mid-word', async () => {
    const { svc, prisma, agents } = makeDeps(0);
    prisma.brandProfile.findUnique.mockResolvedValue(null);
    prisma.workspace.findUnique.mockResolvedValue({ productName: null, defaultLanguage: 'tr' });

    await svc.ensureDefaultAgent(WS, { ...BRIEF, identity: { ...BRIEF.identity, product: longProduct } });

    const name = agents.create.mock.calls[0][1].name as string;
    expect(name.endsWith(' Asistanı')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60);
    // Cut on a word boundary: the label is a whole-word prefix of the source.
    expect(longProduct.startsWith(name.replace(' Asistanı', ''))).toBe(true);
    expect(name).toBe('Custom, hand-painted resin figurines Asistanı');
  });
});
