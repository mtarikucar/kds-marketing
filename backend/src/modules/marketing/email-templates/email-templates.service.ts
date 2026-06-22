import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { renderEmailHtml, type EmailTheme } from './emailtemplate.render';

export interface EmailTemplateInput {
  name: string;
  blocks?: unknown[];
  theme?: EmailTheme;
}

/**
 * Reusable HTML email templates (GoHighLevel parity). CRUD is workspace-scoped;
 * `compiledHtml` is (re)rendered from the blocks on every write so the cached
 * HTML never drifts from the block list, and a campaign can snapshot it at
 * launch without re-compiling.
 */
@Injectable()
export class EmailTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  private compile(blocks: unknown, theme: unknown): string {
    return renderEmailHtml(blocks, (theme ?? {}) as EmailTheme);
  }

  async list(workspaceId: string) {
    return this.prisma.emailTemplate.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, updatedAt: true },
    });
  }

  async get(workspaceId: string, id: string) {
    const tpl = await this.prisma.emailTemplate.findFirst({ where: { id, workspaceId } });
    if (!tpl) throw new NotFoundException('Email template not found');
    return tpl;
  }

  async create(workspaceId: string, dto: EmailTemplateInput) {
    const blocks = Array.isArray(dto.blocks) ? dto.blocks : [];
    return this.prisma.emailTemplate.create({
      data: {
        workspaceId,
        name: dto.name,
        blocks: blocks as Prisma.InputJsonValue,
        theme: (dto.theme ?? undefined) as Prisma.InputJsonValue | undefined,
        compiledHtml: this.compile(blocks, dto.theme),
      },
    });
  }

  async update(workspaceId: string, id: string, dto: Partial<EmailTemplateInput>) {
    const existing = await this.get(workspaceId, id);
    const blocks = dto.blocks !== undefined ? (Array.isArray(dto.blocks) ? dto.blocks : []) : (existing.blocks as unknown);
    const theme = dto.theme !== undefined ? dto.theme : (existing.theme as unknown);
    const data: Prisma.EmailTemplateUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.blocks !== undefined || dto.theme !== undefined) {
      data.blocks = blocks as Prisma.InputJsonValue;
      data.theme = (theme ?? undefined) as Prisma.InputJsonValue | undefined;
      data.compiledHtml = this.compile(blocks, theme);
    }
    const res = await this.prisma.emailTemplate.updateMany({ where: { id, workspaceId }, data });
    if (res.count === 0) throw new NotFoundException('Email template not found');
    return this.get(workspaceId, id);
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.emailTemplate.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Email template not found');
    return { message: 'Email template deleted' };
  }
}
