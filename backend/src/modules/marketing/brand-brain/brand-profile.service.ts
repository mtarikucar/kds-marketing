import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BrandProfilePayload } from '../dto/brand-profile.dto';
import { BrandContextService } from './brand-context.service';

const UPSERTABLE_FIELDS = [
  'brandName',
  'tagline',
  'description',
  'valueProps',
  'toneWords',
  'voiceGuide',
  'icpDescription',
  'audienceObjections',
  'offerings',
  'socialHandles',
  'status',
] as const;

/**
 * Brand Brain — the workspace's consolidated brand/product profile
 * (one row per workspace). See BrandProfile in schema.prisma. Consumed by
 * BrandContextService (Task 3) to ground the AI in the brand's identity.
 */
@Injectable()
export class BrandProfileService {
  // One-directional dependency: BrandProfileService -> BrandContextService.
  // BrandContextService reads BrandProfile directly via Prisma (it does NOT
  // depend on BrandProfileService), so injecting it here to invalidate the
  // cache after every write stays a clean DAG — no forwardRef needed. This
  // centralizes invalidation so every write path (including future apply
  // flows) automatically refreshes the cached brand block.
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: BrandContextService,
  ) {}

  get(workspaceId: string) {
    return this.prisma.brandProfile.findUnique({ where: { workspaceId } });
  }

  async upsert(workspaceId: string, dto: BrandProfilePayload) {
    // Only touch fields the caller actually sent — a partial save must not
    // null out previously-saved brand material (mirrors BrandKitService).
    const data: any = {};
    for (const k of UPSERTABLE_FIELDS) {
      if ((dto as any)[k] !== undefined) data[k] = (dto as any)[k];
    }
    const result = await this.prisma.brandProfile.upsert({
      where: { workspaceId },
      create: { workspaceId, brandName: dto.brandName ?? 'My brand', status: 'DRAFT', ...data },
      update: data,
    });
    this.context.invalidate(workspaceId);
    return result;
  }
}
