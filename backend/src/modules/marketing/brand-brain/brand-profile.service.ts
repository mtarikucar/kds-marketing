import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BrandProfilePayload } from '../dto/brand-profile.dto';

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
  constructor(private readonly prisma: PrismaService) {}

  get(workspaceId: string) {
    return this.prisma.brandProfile.findUnique({ where: { workspaceId } });
  }

  upsert(workspaceId: string, dto: BrandProfilePayload) {
    // Only touch fields the caller actually sent — a partial save must not
    // null out previously-saved brand material (mirrors BrandKitService).
    const data: any = {};
    for (const k of UPSERTABLE_FIELDS) {
      if ((dto as any)[k] !== undefined) data[k] = (dto as any)[k];
    }
    return this.prisma.brandProfile.upsert({
      where: { workspaceId },
      create: { workspaceId, brandName: dto.brandName ?? 'My brand', status: 'DRAFT', ...data },
      update: data,
    });
  }
}
