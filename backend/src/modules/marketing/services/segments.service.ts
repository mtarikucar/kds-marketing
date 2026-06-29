import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SegmentCompilerService,
  SegmentNode,
} from './segment-compiler.service';
import { safePage, safeLimit } from '../common/paging';

interface CreateSegmentInput {
  name: string;
  description?: string;
  definition: unknown;
}
interface UpdateSegmentInput {
  name?: string;
  description?: string;
  definition?: unknown;
}

const SAMPLE_SELECT = {
  id: true,
  businessName: true,
  contactPerson: true,
  city: true,
  status: true,
} as const;

/**
 * Epic A3 — saved segments: CRUD + live evaluation (preview/count/members) via
 * the shared SegmentCompilerService.
 */
@Injectable()
export class SegmentsService {
  constructor(
    private prisma: PrismaService,
    private compiler: SegmentCompilerService,
  ) {}

  list(workspaceId: string) {
    return this.prisma.segment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async getOwned(workspaceId: string, id: string) {
    const seg = await this.prisma.segment.findFirst({ where: { id, workspaceId } });
    if (!seg) throw new NotFoundException('Segment not found');
    return seg;
  }

  async create(workspaceId: string, dto: CreateSegmentInput) {
    await this.compiler.validate(workspaceId, dto.definition as SegmentNode);
    return this.prisma.segment.create({
      data: {
        workspaceId,
        name: dto.name,
        description: dto.description,
        kind: 'DYNAMIC',
        definition: dto.definition as Prisma.InputJsonValue,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateSegmentInput) {
    await this.getOwned(workspaceId, id);
    if (dto.definition !== undefined) {
      await this.compiler.validate(workspaceId, dto.definition as SegmentNode);
    }
    return this.prisma.segment.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.definition !== undefined && {
          definition: dto.definition as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id);
    await this.prisma.segment.delete({ where: { id } });
    return { id };
  }

  async preview(workspaceId: string, definition: unknown) {
    await this.compiler.validate(workspaceId, definition as SegmentNode);
    const filter = this.compiler.compile(workspaceId, definition as SegmentNode);
    const [count, sample] = await Promise.all([
      this.prisma.lead.count({ where: { workspaceId, mergedIntoId: null, deletedAt: null, AND: [filter] } }),
      this.prisma.lead.findMany({
        where: { workspaceId, mergedIntoId: null, deletedAt: null, AND: [filter] },
        take: 10,
        select: SAMPLE_SELECT,
      }),
    ]);
    return { count, sample };
  }

  async count(workspaceId: string, id: string) {
    const seg = await this.getOwned(workspaceId, id);
    const filter = this.compiler.compile(
      workspaceId,
      seg.definition as unknown as SegmentNode,
    );
    const count = await this.prisma.lead.count({
      where: { workspaceId, mergedIntoId: null, deletedAt: null, AND: [filter] },
    });
    await this.prisma.segment.update({
      where: { id },
      data: { lastCount: count, lastEvaluatedAt: new Date() },
    });
    return { count };
  }

  async members(workspaceId: string, id: string, page = 1, pageSize = 50) {
    const seg = await this.getOwned(workspaceId, id);
    const filter = this.compiler.compile(
      workspaceId,
      seg.definition as unknown as SegmentNode,
    );
    // Clamp the page size in the service itself — the controllers cap it at 200,
    // but the public API (public-api-v1.controller) forwards `page` only and
    // relies on the default AND parseInt()s the query, so a non-numeric
    // `?page=abc` arrives as NaN. safePage/safeLimit coerce both to safe bounds
    // (NaN/negative → first page / default size) so a bad param degrades instead
    // of throwing a 500. Defence in depth, not just at the edge.
    const p = safePage(page);
    const size = safeLimit(pageSize, 50, 200);
    const skip = (p - 1) * size;
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where: { workspaceId, mergedIntoId: null, deletedAt: null, AND: [filter] },
        skip,
        take: size,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.lead.count({ where: { workspaceId, mergedIntoId: null, deletedAt: null, AND: [filter] } }),
    ]);
    return { items, total, page: p, pageSize: size };
  }
}
