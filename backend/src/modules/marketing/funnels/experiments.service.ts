import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

interface Variant {
  key: string;
  label?: string;
  weight?: number;
  blocks?: unknown;
}
interface ExperimentInput {
  name: string;
  pageId?: string;
  variants?: Variant[];
}

/**
 * Epic E — A/B (split) experiments. Variant selection is weighted-random and
 * each impression/conversion is recorded as an ExperimentEvent; results
 * aggregate per variant. Selection/tracking are public (looked up by the
 * unguessable experiment id, like form submits).
 */
@Injectable()
export class ExperimentsService {
  constructor(private prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.experiment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(workspaceId: string, dto: ExperimentInput) {
    return this.prisma.experiment.create({
      data: {
        workspaceId,
        name: dto.name,
        pageId: dto.pageId,
        variants: (dto.variants ?? []) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async owned(workspaceId: string, id: string) {
    const e = await this.prisma.experiment.findFirst({ where: { id, workspaceId } });
    if (!e) throw new NotFoundException('Experiment not found');
    return e;
  }

  get(workspaceId: string, id: string) {
    return this.owned(workspaceId, id);
  }

  async update(workspaceId: string, id: string, dto: Partial<ExperimentInput>) {
    await this.owned(workspaceId, id);
    return this.prisma.experiment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.pageId !== undefined && { pageId: dto.pageId }),
        ...(dto.variants !== undefined && {
          variants: dto.variants as unknown as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async setStatus(workspaceId: string, id: string, status: 'RUNNING' | 'STOPPED') {
    const e = await this.owned(workspaceId, id);
    if (status === 'RUNNING' && ((e.variants as unknown as Variant[]) ?? []).length < 2) {
      throw new BadRequestException('An experiment needs at least 2 variants to run');
    }
    return this.prisma.experiment.update({ where: { id }, data: { status } });
  }

  async remove(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.experiment.delete({ where: { id } });
    return { id };
  }

  /** Public — weighted-random pick + impression. Returns the chosen variant. */
  async selectVariant(experimentId: string) {
    const exp = await this.prisma.experiment.findUnique({ where: { id: experimentId } });
    if (!exp || exp.status !== 'RUNNING') return null;
    const variants = (exp.variants as unknown as Variant[]) ?? [];
    if (!variants.length) return null;
    const total = variants.reduce((s, v) => s + (v.weight ?? 1), 0);
    let r = Math.random() * total;
    let chosen = variants[variants.length - 1];
    for (const v of variants) {
      r -= v.weight ?? 1;
      if (r <= 0) {
        chosen = v;
        break;
      }
    }
    await this.prisma.experimentEvent.create({
      data: { experimentId, workspaceId: exp.workspaceId, variantKey: chosen.key, kind: 'IMPRESSION' },
    });
    return { experimentId, variantKey: chosen.key, blocks: chosen.blocks ?? null };
  }

  /** Public — record a conversion for a variant. */
  async trackConversion(experimentId: string, variantKey: string) {
    const exp = await this.prisma.experiment.findUnique({ where: { id: experimentId } });
    if (!exp) return { ok: false };
    await this.prisma.experimentEvent.create({
      data: { experimentId, workspaceId: exp.workspaceId, variantKey, kind: 'CONVERSION' },
    });
    return { ok: true };
  }

  async results(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    const grouped = await this.prisma.experimentEvent.groupBy({
      by: ['variantKey', 'kind'],
      where: { experimentId: id, workspaceId },
      _count: true,
    });
    const byVariant: Record<string, { impressions: number; conversions: number }> = {};
    for (const g of grouped) {
      byVariant[g.variantKey] ??= { impressions: 0, conversions: 0 };
      if (g.kind === 'IMPRESSION') byVariant[g.variantKey].impressions = g._count;
      if (g.kind === 'CONVERSION') byVariant[g.variantKey].conversions = g._count;
    }
    return Object.entries(byVariant).map(([variantKey, v]) => ({
      variantKey,
      ...v,
      conversionRate: v.impressions ? Math.round((v.conversions / v.impressions) * 1000) / 10 : 0,
    }));
  }
}
