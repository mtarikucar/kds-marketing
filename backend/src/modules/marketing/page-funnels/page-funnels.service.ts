import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SiteRendererService } from '../sites/site-renderer.service';
import { BrandingService } from '../branding/branding.service';

export interface FunnelStepInput {
  sitePageId: string;
  name?: string;
}
export interface CreateFunnelInput {
  name: string;
  slug?: string;
  steps?: FunnelStepInput[];
}
export interface UpdateFunnelInput {
  name?: string;
  slug?: string;
  steps?: FunnelStepInput[];
  published?: boolean;
}

/**
 * Multi-step funnels (GoHighLevel parity): an ordered sequence of SitePages
 * served as one published flow. CRUD is workspace-scoped; the public render
 * resolves the funnel by its globally-scoped (workspace, slug) and reuses the
 * existing JS-free SiteRendererService per step, appending a "Continue" link to
 * the next step. The funnel — not the individual page — is the publish unit.
 */
@Injectable()
export class PageFunnelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: SiteRendererService,
    private readonly branding: BrandingService,
  ) {}

  private normSteps(steps: FunnelStepInput[] | undefined): Prisma.InputJsonValue {
    return (steps ?? [])
      .filter((s) => s && typeof s.sitePageId === 'string' && s.sitePageId)
      .slice(0, 50)
      .map((s) => ({ sitePageId: s.sitePageId, name: s.name ? String(s.name).slice(0, 120) : undefined }));
  }

  /** Robust slug derivation — mirrors sites.service.slugify: Unicode-normalize
   *  (so Turkish names like "Çağrı Hunisi" produce a usable slug) and fall back
   *  rather than throwing a confusing 400 on a single-char/non-ASCII name. */
  private slug(name: string, slug?: string): string {
    return (
      (slug || name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'funnel'
    );
  }

  async list(workspaceId: string) {
    return this.prisma.funnel.findMany({ where: { workspaceId }, orderBy: { updatedAt: 'desc' } });
  }

  async get(workspaceId: string, id: string) {
    const funnel = await this.prisma.funnel.findFirst({ where: { id, workspaceId } });
    if (!funnel) throw new NotFoundException('Funnel not found');
    return funnel;
  }

  async create(workspaceId: string, dto: CreateFunnelInput) {
    const slug = this.slug(dto.name, dto.slug);
    try {
      return await this.prisma.funnel.create({
        data: { workspaceId, name: dto.name, slug, steps: this.normSteps(dto.steps) },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('A funnel with this slug already exists');
      }
      throw e;
    }
  }

  async update(workspaceId: string, id: string, dto: UpdateFunnelInput) {
    await this.get(workspaceId, id); // scoped existence check
    const data: Prisma.FunnelUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.slug !== undefined) data.slug = this.slug(dto.slug, dto.slug);
    if (dto.steps !== undefined) data.steps = this.normSteps(dto.steps);
    if (dto.published !== undefined) data.published = dto.published;
    try {
      const res = await this.prisma.funnel.updateMany({ where: { id, workspaceId }, data });
      if (res.count === 0) throw new NotFoundException('Funnel not found');
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('A funnel with this slug already exists');
      }
      throw e;
    }
    return this.get(workspaceId, id);
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.funnel.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Funnel not found');
    return { message: 'Funnel deleted' };
  }

  /**
   * Public render of one funnel step. Resolves the funnel by its globally-unique
   * (workspace, slug) — findFirst on the scoped pair, not a cross-tenant read.
   * Returns null (→ 404) for an unknown/unpublished funnel or out-of-range step.
   */
  async render(workspaceId: string, slug: string, stepIndex: number, publicBase: string): Promise<string | null> {
    const funnel = await this.prisma.funnel.findFirst({ where: { workspaceId, slug, published: true } });
    if (!funnel) return null;
    const steps = Array.isArray(funnel.steps) ? (funnel.steps as any[]) : [];
    if (stepIndex < 0 || stepIndex >= steps.length) return null;
    const step = steps[stepIndex];
    const pageId = step?.sitePageId;
    if (!pageId || typeof pageId !== 'string') return null;

    const page = await this.prisma.sitePage.findFirst({ where: { id: pageId, workspaceId } });
    if (!page) return null;

    // forms map (same as SitesService.renderPublic)
    const formIds = (Array.isArray(page.blocks) ? page.blocks : [])
      .filter((b: any) => b?.type === 'form' && b.formId)
      .map((b: any) => b.formId as string);
    const forms = new Map<string, any>();
    if (formIds.length) {
      const defs = await this.prisma.formDef.findMany({ where: { workspaceId, id: { in: formIds } } });
      for (const d of defs) forms.set(d.id, d as any);
    }
    const brand = await this.branding.get(workspaceId);
    const html = this.renderer.render(page, forms, publicBase, { ...brand, workspaceId });

    // Append a "Continue" link to the next step (linear advance), JS-free.
    const hasNext = stepIndex + 1 < steps.length;
    if (!hasNext) return html;
    const base = publicBase.replace(/\/$/, '');
    const next = `<div class="s" style="text-align:center;padding-top:0"><a class="btn" href="${base}/api/public/funnel/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}/${stepIndex + 1}">Continue →</a></div>`;
    return html.replace('</body>', `${next}</body>`);
  }
}
