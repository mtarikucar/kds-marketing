import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { SiteRendererService } from './site-renderer.service';
import { BrandingService } from '../branding/branding.service';

const DRAFT_GUIDE = `You design a landing page as STRICT JSON: { "title": string, "blocks": Block[] }. Output ONLY JSON.
Block types:
 {"type":"hero","heading","sub","ctaText","ctaUrl"}
 {"type":"features","items":[{"title","text"}]}
 {"type":"pricing","plans":[{"name","price","features":[string],"ctaText","ctaUrl"}]}
 {"type":"faq","heading","items":[{"q","a"}]}
 {"type":"cta","heading","buttonText","buttonUrl"}
 {"type":"text","text"}
Keep copy tight and conversion-focused. 3-6 blocks.`;

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly renderer: SiteRendererService,
    private readonly branding: BrandingService,
  ) {}

  // ---- pages ----
  list(workspaceId: string) {
    return this.prisma.sitePage.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, slug: true, title: true, published: true, updatedAt: true },
    });
  }

  async get(workspaceId: string, id: string) {
    const p = await this.prisma.sitePage.findFirst({ where: { id, workspaceId } });
    if (!p) throw new NotFoundException('Page not found');
    return p;
  }

  async create(workspaceId: string, dto: { slug?: string; title: string; blocks?: unknown; seo?: unknown; theme?: unknown }) {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.maxFunnels;
    if (limit !== -1) {
      const count = await this.prisma.sitePage.count({ where: { workspaceId } });
      if (count >= limit) throw new BadRequestException(`Funnel/page limit reached (${limit}) — upgrade your package`);
    }
    const slug = this.slugify(dto.slug || dto.title);
    return this.prisma.sitePage.create({
      data: {
        workspaceId,
        slug,
        title: dto.title,
        blocks: (dto.blocks ?? []) as Prisma.InputJsonValue,
        seo: (dto.seo ?? undefined) as Prisma.InputJsonValue,
        theme: (dto.theme ?? undefined) as Prisma.InputJsonValue,
      },
    }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('A page with that slug already exists');
      }
      throw e;
    });
  }

  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.sitePage.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Page not found');
    const data: any = {};
    for (const k of ['title', 'blocks', 'seo', 'theme', 'published'] as const) if (dto[k] !== undefined) data[k] = dto[k];
    if (dto.slug !== undefined) data.slug = this.slugify(dto.slug);
    return this.prisma.sitePage.update({ where: { id: existing.id }, data });
  }

  async setPublished(workspaceId: string, id: string, published: boolean) {
    const existing = await this.prisma.sitePage.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Page not found');
    return this.prisma.sitePage.update({ where: { id: existing.id }, data: { published } });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.sitePage.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Page not found');
    return { message: 'Page deleted' };
  }

  /** Public render by (workspaceId, slug). Resolves referenced FormDefs. */
  async renderPublic(workspaceId: string, slug: string, publicBase: string): Promise<string | null> {
    const page = await this.prisma.sitePage.findFirst({ where: { workspaceId, slug, published: true } });
    if (!page) return null;
    const formIds = (Array.isArray(page.blocks) ? page.blocks : [])
      .filter((b: any) => b?.type === 'form' && b.formId)
      .map((b: any) => b.formId as string);
    const forms = new Map<string, any>();
    if (formIds.length) {
      const defs = await this.prisma.formDef.findMany({ where: { workspaceId, id: { in: formIds } } });
      for (const d of defs) forms.set(d.id, d as any);
    }
    const branding = await this.branding.get(workspaceId);
    return this.renderer.render(page, forms, publicBase, branding);
  }

  async draft(workspaceId: string, prompt: string): Promise<{ title: string; blocks: unknown[] }> {
    if (!this.anthropic.isEnabled()) throw new ServiceUnavailableException('AI is not configured');
    await this.credits.reserve(workspaceId, creditCost('funnel.draft'));
    try {
      const res = await this.anthropic.complete({
        system: DRAFT_GUIDE,
        messages: [{ role: 'user', content: prompt.slice(0, 2000) }],
        maxTokens: 2000,
        tier: tierFor('funnel.draft'),
      });
      const start = res.text.indexOf('{');
      const end = res.text.lastIndexOf('}');
      if (start === -1 || end === -1) throw new BadRequestException('AI returned no JSON');
      const json = JSON.parse(res.text.slice(start, end + 1));
      if (!Array.isArray(json.blocks)) throw new BadRequestException('AI draft missing blocks');
      return { title: String(json.title ?? 'Landing page'), blocks: json.blocks };
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('funnel.draft'));
      throw e;
    }
  }

  // ---- forms ----
  listForms(workspaceId: string) {
    return this.prisma.formDef.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
  }
  createForm(workspaceId: string, dto: { name: string; fields?: unknown; redirectUrl?: string }) {
    return this.prisma.formDef.create({
      data: { workspaceId, name: dto.name, fields: (dto.fields ?? []) as Prisma.InputJsonValue, redirectUrl: dto.redirectUrl ?? null },
    });
  }
  async updateForm(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.formDef.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Form not found');
    const data: any = {};
    for (const k of ['name', 'fields', 'redirectUrl'] as const) if (dto[k] !== undefined) data[k] = dto[k];
    return this.prisma.formDef.update({ where: { id: existing.id }, data });
  }
  async removeForm(workspaceId: string, id: string) {
    const res = await this.prisma.formDef.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Form not found');
    return { message: 'Form deleted' };
  }

  private slugify(s: string): string {
    return (s || 'page').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 80) || 'page';
  }
}
