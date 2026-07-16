import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BrandProfileService } from './brand-profile.service';
import { BrandKitService } from '../ai/media/brand-kit.service';
import { MarketingResearchService } from '../services/marketing-research.service';
import { KnowledgeService } from '../ai/knowledge.service';
import { BrandBrainService } from './brand-brain.service';
import { BrandAnalysisDraft } from './brand-synthesis.service';

/**
 * The review→apply capstone: takes a READY_FOR_REVIEW run's draft (optionally
 * user-edited in the review UI) and seeds it across the workspace WITHOUT
 * clobbering user edits.
 *
 * "Owns vs seeds": BrandProfile is OWNED — always upserted ACTIVE, through
 * BrandProfileService so the AI-context cache invalidates (never a raw
 * prisma.brandProfile.upsert). BrandKit / ResearchProfile / Workspace.
 * productDescription / KnowledgeDocs are SEEDED — each seed path only fills
 * in what the user hasn't already set, so re-running apply (or applying after
 * the user has customized their brand kit) never overwrites their edits.
 *
 * Atomicity: these seeds cross 5 services each owning its own Prisma client,
 * so a single $transaction across all of them isn't feasible without
 * threading a tx through every service. Instead the run is marked APPLIED
 * only at the very end — a mid-seed failure leaves it READY_FOR_REVIEW, so
 * apply is safely re-runnable (every seed step below is independently
 * idempotent). This is the intended design, not a gap to close.
 */
@Injectable()
export class BrandApplyService {
  private readonly logger = new Logger(BrandApplyService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: BrandProfileService,
    private readonly brandKit: BrandKitService,
    private readonly research: MarketingResearchService,
    private readonly knowledge: KnowledgeService,
    private readonly brain: BrandBrainService,
  ) {}

  async apply(workspaceId: string, runId: string, editedDraft?: BrandAnalysisDraft): Promise<{ applied: true }> {
    const run = await this.prisma.brandAnalysisRun.findFirst({ where: { id: runId, workspaceId } });
    if (!run) throw new NotFoundException('Analysis run not found');
    if (run.status !== 'READY_FOR_REVIEW') throw new BadRequestException('Run is not ready to apply');
    const draft = (editedDraft ?? (run.draft as unknown)) as BrandAnalysisDraft | null;
    if (!draft?.profile) throw new BadRequestException('Run has no draft to apply');

    // 1. BrandProfile — OWNED. Through the service so the AI-context cache invalidates.
    await this.profiles.upsert(workspaceId, {
      brandName: draft.profile.brandName,
      tagline: draft.profile.tagline,
      description: draft.profile.description,
      valueProps: draft.profile.valueProps,
      toneWords: draft.profile.toneWords,
      voiceGuide: draft.profile.voiceGuide,
      icpDescription: draft.profile.icpDescription,
      audienceObjections: draft.profile.audienceObjections,
      offerings: draft.profile.offerings,
      socialHandles: draft.profile.socialHandles,
      status: 'ACTIVE',
    });

    await this.seedBrandKit(workspaceId, draft.brandKitHints);
    await this.seedResearchProfile(workspaceId, draft.researchProfile);
    await this.seedWorkspaceProduct(workspaceId, draft.profile.description);
    await this.seedKnowledgeDocs(workspaceId, draft.knowledgeDocs);

    await this.prisma.brandAnalysisRun.update({ where: { id: runId }, data: { status: 'APPLIED', completedAt: new Date() } });
    return { applied: true };
  }

  /** SEED only fields the user hasn't already set — never clobber their brand kit. */
  private async seedBrandKit(ws: string, hints: BrandAnalysisDraft['brandKitHints'] | undefined): Promise<void> {
    if (!hints) return;
    const kit = await this.prisma.brandKit.findUnique({ where: { workspaceId: ws } });
    const seed: Record<string, unknown> = {};
    if (!kit?.tone && hints.tone) seed.tone = hints.tone;
    const hasPalette = Array.isArray(kit?.palette) && (kit!.palette as unknown[]).length > 0;
    if (!hasPalette && hints.palette?.length) seed.palette = hints.palette;
    if (!(kit?.defaultHashtags?.length) && hints.hashtags?.length) seed.defaultHashtags = hints.hashtags;
    if (!kit?.defaultCta && hints.cta) seed.defaultCta = hints.cta;
    if (Object.keys(seed).length) await this.brandKit.upsert(ws, seed as any);
  }

  /** SEED the single marked "Brand Brain" targeting profile — never the user's others. */
  private async seedResearchProfile(ws: string, rp: BrandAnalysisDraft['researchProfile'] | undefined): Promise<void> {
    const icp = rp?.icpDescription?.trim();
    if (!icp) return; // nothing worth prospecting for
    try {
      const existing = await this.prisma.researchProfile.findFirst({ where: { workspaceId: ws, name: 'Brand Brain' }, select: { id: true } });
      const dto = { name: 'Brand Brain', icpDescription: icp, businessTypes: rp?.businessTypes ?? [], geo: rp?.geo };
      if (existing) await this.research.update(ws, existing.id, dto as any);
      else await this.research.create(ws, dto as any);
    } catch (e) {
      this.logger.warn(`research seed skipped: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** SEED Workspace.productDescription only when empty. */
  private async seedWorkspaceProduct(ws: string, description?: string): Promise<void> {
    if (!description) return;
    const w = await this.prisma.workspace.findUnique({ where: { id: ws }, select: { productDescription: true } });
    if (!w?.productDescription) {
      await this.prisma.workspace.update({ where: { id: ws }, data: { productDescription: description } });
    }
  }

  /** REPLACE the brand-brain-sourced knowledge set (keep the user's MANUAL docs), then reindex. */
  private async seedKnowledgeDocs(ws: string, docs: BrandAnalysisDraft['knowledgeDocs'] | undefined): Promise<void> {
    await this.prisma.knowledgeDoc.deleteMany({ where: { workspaceId: ws, source: 'brand-brain' } });
    for (const d of docs ?? []) {
      try {
        await this.knowledge.create(ws, { title: d.title, content: d.content, source: 'brand-brain' });
      } catch (e) {
        this.logger.warn(`knowledge doc seed stopped at "${d.title}": ${e instanceof Error ? e.message : e}`);
        break; // entitlement cap hit — stop best-effort
      }
    }
    await this.brain.reindexWorkspace(ws);
  }
}
