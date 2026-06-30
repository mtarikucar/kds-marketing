import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { R2StorageService, UploadInput } from '../../social-planner/r2-storage.service';

const MAX_REFERENCE_IMAGES = 5;

export interface ReferenceImage { url: string; r2Key?: string; mime?: string; }
export interface BrandKitPayload {
  logoUrl?: string | null;
  logoR2Key?: string | null;
  palette?: string[] | null;
  tone?: string | null;
  referenceImages?: ReferenceImage[];
  defaultHashtags?: string[];
  defaultCta?: string | null;
}

@Injectable()
export class BrandKitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly r2: R2StorageService,
  ) {}

  get(workspaceId: string) {
    return this.prisma.brandKit.findUnique({ where: { workspaceId } });
  }

  upsert(workspaceId: string, dto: BrandKitPayload) {
    const data = {
      logoUrl: dto.logoUrl ?? null,
      logoR2Key: dto.logoR2Key ?? null,
      palette: (dto.palette ?? null) as Prisma.InputJsonValue,
      tone: dto.tone ?? null,
      ...(dto.referenceImages ? { referenceImages: dto.referenceImages as unknown as Prisma.InputJsonValue } : {}),
      ...(dto.defaultHashtags ? { defaultHashtags: dto.defaultHashtags } : {}),
      defaultCta: dto.defaultCta ?? null,
    };
    return this.prisma.brandKit.upsert({
      where: { workspaceId },
      create: { workspaceId, referenceImages: [], defaultHashtags: [], ...data },
      update: data,
    });
  }

  async addReferenceImage(workspaceId: string, file: UploadInput): Promise<ReferenceImage> {
    if (!this.r2.isConfigured()) {
      throw new BadRequestException('Media upload is not configured (set R2_* env).');
    }
    const kit = await this.prisma.brandKit.findUnique({ where: { workspaceId } });
    const existing = ((kit?.referenceImages as unknown as ReferenceImage[]) ?? []);
    if (existing.length >= MAX_REFERENCE_IMAGES) {
      throw new BadRequestException(`At most ${MAX_REFERENCE_IMAGES} reference images allowed`);
    }
    const uploaded = await this.r2.upload(workspaceId, file);
    const ref: ReferenceImage = { url: uploaded.url, r2Key: uploaded.key, mime: uploaded.mime };
    const next = [...existing, ref];
    if (kit) {
      await this.prisma.brandKit.update({ where: { workspaceId }, data: { referenceImages: next as unknown as Prisma.InputJsonValue } });
    } else {
      await this.prisma.brandKit.create({ data: { workspaceId, referenceImages: next as unknown as Prisma.InputJsonValue, defaultHashtags: [] } });
    }
    return ref;
  }
}
