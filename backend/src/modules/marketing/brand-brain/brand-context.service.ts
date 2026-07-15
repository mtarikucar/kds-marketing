import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

const TTL_MS = 60_000;

/**
 * Brand Brain — the cached, always-on compact brand block every workspace AI
 * injects into its system prompt. Reads BrandProfile directly via Prisma
 * (NOT through BrandProfileService) so the dependency graph stays a clean
 * one-directional DAG: BrandProfileService -> BrandContextService -> Prisma.
 * If this injected BrandProfileService instead, BrandProfileService.upsert
 * calling back into BrandContextService.invalidate would form a circular
 * Nest dependency and force forwardRef on both sides.
 */
@Injectable()
export class BrandContextService {
  private readonly cache = new Map<string, { block: string | null; exp: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async summaryFor(workspaceId: string): Promise<string | null> {
    const hit = this.cache.get(workspaceId);
    if (hit && hit.exp > Date.now()) return hit.block;
    const p = await this.prisma.brandProfile.findUnique({ where: { workspaceId } });
    const block = p && p.status === 'ACTIVE' ? this.render(p) : null;
    this.cache.set(workspaceId, { block, exp: Date.now() + TTL_MS });
    return block;
  }

  private render(p: any): string {
    const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    const lines = [
      `Brand: ${p.brandName}`,
      p.description || '',
      arr(p.valueProps).length ? `Selling points: ${arr(p.valueProps).join('; ')}` : '',
      arr(p.toneWords).length ? `Voice: ${arr(p.toneWords).join(', ')}${p.voiceGuide ? ` — ${p.voiceGuide}` : ''}` : '',
      p.icpDescription ? `Ideal customer: ${p.icpDescription}` : '',
      arr(p.audienceObjections).length ? `Common objections to preempt: ${arr(p.audienceObjections).join('; ')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  invalidate(workspaceId: string) {
    this.cache.delete(workspaceId);
  }
}
