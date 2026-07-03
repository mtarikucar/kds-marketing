import { TrendRemixService } from './trend-remix.service';

function makePrisma() {
  const create = jest.fn().mockResolvedValue({ id: 't1' });
  return { prisma: { trendTemplate: { create, findMany: jest.fn().mockResolvedValue([]) } } as any, create };
}

const svc = () => new TrendRemixService(makePrisma().prisma);

describe('TrendRemixService.buildRemixBrief (pure format intelligence)', () => {
  it('adapts the abstract hook/caption onto the brand subject, not a copy', () => {
    const brief = new TrendRemixService(makePrisma().prisma).buildRemixBrief(
      {
        sourcePlatform: 'TIKTOK',
        hookPattern: 'Think [product] is too expensive?',
        captionPattern: 'The truth about [product]',
        sceneStructure: [{ scene: 'Hook', note: 'close-up' }],
        riskScore: 10,
      },
      { name: 'Clinic', product: 'dental implants', audience: 'Istanbul', tone: 'reassuring', valueProps: ['0% interest', 'same-day'] },
    );
    expect(brief.hook).toContain('dental implants');
    expect(brief.hook).toContain('Istanbul');
    expect(brief.captionDraft).toContain('dental implants');
    expect(brief.captionDraft).toContain('0% interest');
    expect(brief.scenes[0].direction).toContain("Clinic's dental implants");
  });

  it('surfaces an elevated compliance note for high-risk templates', () => {
    const low = svc().buildRemixBrief({ sourcePlatform: 'TIKTOK', riskScore: 10 }, { name: 'B' });
    const high = svc().buildRemixBrief({ sourcePlatform: 'TIKTOK', riskScore: 80 }, { name: 'B' });
    expect(low.complianceNote).toMatch(/abstract format/i);
    expect(high.complianceNote).toMatch(/HIGH copy\/ToS risk/);
  });

  it('falls back to default scenes when the template has none', () => {
    const brief = svc().buildRemixBrief({ sourcePlatform: 'YOUTUBE' }, { name: 'B', product: 'X' });
    expect(brief.scenes.length).toBe(4);
    expect(brief.scenes[0].scene).toMatch(/Hook/);
  });

  it('clamps riskScore on save', async () => {
    const { prisma, create } = makePrisma();
    await new TrendRemixService(prisma).saveTemplate('ws1', { sourcePlatform: 'TIKTOK', riskScore: 250 });
    expect(create.mock.calls[0][0].data.riskScore).toBe(100);
  });
});
