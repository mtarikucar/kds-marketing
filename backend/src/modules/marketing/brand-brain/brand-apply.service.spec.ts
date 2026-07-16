import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BrandApplyService } from './brand-apply.service';
import { BrandAnalysisDraft } from './brand-synthesis.service';

function makeSvc() {
  const prisma: any = {
    brandAnalysisRun: { findFirst: jest.fn(), update: jest.fn() },
    brandKit: { findUnique: jest.fn() },
    researchProfile: { findFirst: jest.fn() },
    knowledgeDoc: { deleteMany: jest.fn() },
    workspace: { findUnique: jest.fn(), update: jest.fn() },
  };
  const profiles: any = { upsert: jest.fn() };
  const brandKit: any = { upsert: jest.fn() };
  const research: any = { create: jest.fn(), update: jest.fn() };
  const knowledge: any = { create: jest.fn() };
  const brain: any = { reindexWorkspace: jest.fn() };
  const svc = new BrandApplyService(prisma, profiles, brandKit, research, knowledge, brain);
  return { svc, prisma, profiles, brandKit, research, knowledge, brain };
}

const FULL_DRAFT: BrandAnalysisDraft = {
  profile: {
    brandName: 'Acme',
    tagline: 'Do more',
    description: 'Acme makes widgets',
    valueProps: ['fast', 'cheap'],
    toneWords: ['bold'],
    voiceGuide: 'be direct',
    icpDescription: 'small businesses that need widgets fast and reliably every week',
    audienceObjections: ['too expensive'],
    offerings: [{ name: 'Widget Pro', blurb: 'the best widget', price: '$10' }],
    socialHandles: [{ network: 'INSTAGRAM', handle: '@acme' }],
  },
  researchProfile: {
    icpDescription: 'small businesses that need widgets fast and reliably every week',
    businessTypes: ['retail'],
    geo: { country: 'US', regions: ['CA'], cities: ['SF'] },
  },
  brandKitHints: { palette: ['#abcdef'], tone: 'bold and direct', hashtags: ['#acme'], cta: 'Shop now' },
  knowledgeDocs: [
    { title: 'About Acme', content: 'Acme was founded to make the best widgets.' },
    { title: 'FAQ', content: 'Q: Do you ship? A: Yes.' },
  ],
};

describe('BrandApplyService', () => {
  describe('apply', () => {
    it('not found: rejects NotFoundException when the run does not exist', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue(null);

      await expect(svc.apply('ws1', 'run1')).rejects.toThrow(NotFoundException);
    });

    it('not ready: rejects BadRequestException when the run is not READY_FOR_REVIEW', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({ id: 'run1', workspaceId: 'ws1', status: 'RUNNING' });

      await expect(svc.apply('ws1', 'run1')).rejects.toThrow(BadRequestException);
    });

    it('happy path: seeds profile/kit/research/workspace/knowledge and marks APPLIED', async () => {
      const { svc, prisma, profiles, brandKit, research, knowledge, brain } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      const result = await svc.apply('ws1', 'run1');

      expect(result).toEqual({ applied: true });

      // 1. BrandProfile — OWNED, through the service, status ACTIVE.
      expect(profiles.upsert).toHaveBeenCalledWith('ws1', expect.objectContaining({
        brandName: 'Acme',
        tagline: 'Do more',
        description: 'Acme makes widgets',
        valueProps: ['fast', 'cheap'],
        toneWords: ['bold'],
        voiceGuide: 'be direct',
        icpDescription: FULL_DRAFT.profile.icpDescription,
        audienceObjections: ['too expensive'],
        offerings: FULL_DRAFT.profile.offerings,
        socialHandles: FULL_DRAFT.profile.socialHandles,
        status: 'ACTIVE',
      }));

      // 2. BrandKit — SEEDED (kit was empty, all hint fields written).
      expect(brandKit.upsert).toHaveBeenCalledWith('ws1', expect.objectContaining({
        tone: 'bold and direct',
        palette: ['#abcdef'],
        defaultHashtags: ['#acme'],
        defaultCta: 'Shop now',
      }));

      // 3. ResearchProfile — no existing "Brand Brain" profile -> create.
      expect(research.create).toHaveBeenCalledWith('ws1', expect.objectContaining({
        name: 'Brand Brain',
        icpDescription: FULL_DRAFT.researchProfile.icpDescription,
        businessTypes: ['retail'],
        geo: FULL_DRAFT.researchProfile.geo,
      }));
      expect(research.update).not.toHaveBeenCalled();

      // 4. Workspace.productDescription — was empty, gets seeded.
      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws1' },
        data: { productDescription: 'Acme makes widgets' },
      });

      // 5. KnowledgeDoc set — replaced (brand-brain source only), then reindexed.
      expect(prisma.knowledgeDoc.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws1', source: 'brand-brain' } });
      expect(knowledge.create).toHaveBeenCalledTimes(2);
      expect(knowledge.create).toHaveBeenNthCalledWith(1, 'ws1', { title: 'About Acme', content: 'Acme was founded to make the best widgets.', source: 'brand-brain' });
      expect(knowledge.create).toHaveBeenNthCalledWith(2, 'ws1', { title: 'FAQ', content: 'Q: Do you ship? A: Yes.', source: 'brand-brain' });
      expect(brain.reindexWorkspace).toHaveBeenCalledWith('ws1');

      // Final: run marked APPLIED.
      expect(prisma.brandAnalysisRun.update).toHaveBeenCalledWith({
        where: { id: 'run1' },
        data: { status: 'APPLIED', completedAt: expect.any(Date) },
      });
    });

    it('diff-safe BrandKit: every field already user-set -> brandKit.upsert NOT called', async () => {
      const { svc, prisma, brandKit } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue({
        tone: 'user tone',
        palette: ['#111'],
        defaultHashtags: ['#x'],
        defaultCta: 'buy',
      });
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      await svc.apply('ws1', 'run1');

      expect(brandKit.upsert).not.toHaveBeenCalled();
    });

    it('diff-safe Workspace: productDescription already set -> workspace.update NOT called', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: 'user desc' });

      await svc.apply('ws1', 'run1');

      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it('research update path: existing "Brand Brain" profile -> research.update called, research.create NOT', async () => {
      const { svc, prisma, research } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue({ id: 'rp1' });
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      await svc.apply('ws1', 'run1');

      expect(research.update).toHaveBeenCalledWith('ws1', 'rp1', expect.objectContaining({
        name: 'Brand Brain',
        icpDescription: FULL_DRAFT.researchProfile.icpDescription,
      }));
      expect(research.create).not.toHaveBeenCalled();
    });

    it('F2: editedDraft omits knowledgeDocs (undefined) -> deleteMany NOT called, no throw, run APPLIED', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      const editedDraft: BrandAnalysisDraft = { ...FULL_DRAFT, knowledgeDocs: undefined };

      const result = await svc.apply('ws1', 'run1', editedDraft);

      expect(result).toEqual({ applied: true });
      expect(prisma.knowledgeDoc.deleteMany).not.toHaveBeenCalled();
      expect(prisma.brandAnalysisRun.update).toHaveBeenCalledWith({
        where: { id: 'run1' },
        data: { status: 'APPLIED', completedAt: expect.any(Date) },
      });
    });

    it('F3: knowledgeDocs is a valid empty array -> deleteMany IS called (legit "clear all"), reindexed, run APPLIED', async () => {
      const { svc, prisma, knowledge, brain } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      const editedDraft: BrandAnalysisDraft = { ...FULL_DRAFT, knowledgeDocs: [] };

      const result = await svc.apply('ws1', 'run1', editedDraft);

      expect(result).toEqual({ applied: true });
      expect(prisma.knowledgeDoc.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws1', source: 'brand-brain' } });
      expect(knowledge.create).not.toHaveBeenCalled();
      expect(brain.reindexWorkspace).toHaveBeenCalledWith('ws1');
      expect(prisma.brandAnalysisRun.update).toHaveBeenCalledWith({
        where: { id: 'run1' },
        data: { status: 'APPLIED', completedAt: expect.any(Date) },
      });
    });

    it('F2: knowledgeDocs is a malformed non-array -> deleteMany NOT called, no throw', async () => {
      const { svc, prisma } = makeSvc();
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft: FULL_DRAFT,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.researchProfile.findFirst.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      const editedDraft = { ...FULL_DRAFT, knowledgeDocs: 'oops-not-an-array' } as unknown as BrandAnalysisDraft;

      await expect(svc.apply('ws1', 'run1', editedDraft)).resolves.toEqual({ applied: true });
      expect(prisma.knowledgeDoc.deleteMany).not.toHaveBeenCalled();
    });

    it('research skipped: empty icpDescription -> neither create nor update called', async () => {
      const { svc, prisma, research } = makeSvc();
      const draft: BrandAnalysisDraft = { ...FULL_DRAFT, researchProfile: { icpDescription: '  ', businessTypes: [], geo: undefined } };
      prisma.brandAnalysisRun.findFirst.mockResolvedValue({
        id: 'run1',
        workspaceId: 'ws1',
        status: 'READY_FOR_REVIEW',
        draft,
      });
      prisma.brandKit.findUnique.mockResolvedValue(null);
      prisma.workspace.findUnique.mockResolvedValue({ productDescription: null });

      await svc.apply('ws1', 'run1');

      expect(prisma.researchProfile.findFirst).not.toHaveBeenCalled();
      expect(research.create).not.toHaveBeenCalled();
      expect(research.update).not.toHaveBeenCalled();
    });
  });
});
