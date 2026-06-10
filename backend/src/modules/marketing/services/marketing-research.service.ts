import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreateResearchProfileDto,
  UpdateResearchProfileDto,
} from '../dto/research-profile.dto';
import { MarketingLeadsIngestService } from './marketing-leads-ingest.service';

/** Research profiles per workspace until per-package limits land (Phase F). */
const MAX_PROFILES_PER_WORKSPACE = 3;

/**
 * CRUD for research profiles — the customer-authored "who to find and how
 * to pitch" briefs the nightly routine researches against.
 */
@Injectable()
export class MarketingResearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: MarketingLeadsIngestService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.researchProfile.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(workspaceId: string, dto: CreateResearchProfileDto) {
    const count = await this.prisma.researchProfile.count({
      where: { workspaceId },
    });
    if (count >= MAX_PROFILES_PER_WORKSPACE) {
      throw new BadRequestException(
        `Profile limit reached (${MAX_PROFILES_PER_WORKSPACE})`,
      );
    }
    return this.prisma.researchProfile.create({
      data: {
        workspaceId,
        name: dto.name,
        icpDescription: dto.icpDescription,
        productPitch: dto.productPitch ?? null,
        geo: (dto.geo as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        language: dto.language ?? 'en',
        businessTypes:
          (dto.businessTypes as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        exclusions: dto.exclusions ?? null,
        status: dto.status ?? 'ACTIVE',
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateResearchProfileDto) {
    const existing = await this.prisma.researchProfile.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Profile not found');

    const { geo, businessTypes, ...scalar } = dto;
    return this.prisma.researchProfile.update({
      where: { id: existing.id },
      data: {
        ...scalar,
        ...(geo !== undefined
          ? { geo: (geo as Prisma.InputJsonValue) ?? Prisma.JsonNull }
          : {}),
        ...(businessTypes !== undefined
          ? {
              businessTypes:
                (businessTypes as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            }
          : {}),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    const result = await this.prisma.researchProfile.deleteMany({
      where: { id, workspaceId },
    });
    if (result.count === 0) throw new NotFoundException('Profile not found');
    return { message: 'Profile deleted' };
  }

  /** Quota meter for the settings page. */
  usage(workspaceId: string) {
    return this.ingest.usageToday(workspaceId);
  }
}
