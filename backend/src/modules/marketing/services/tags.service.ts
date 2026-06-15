import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';

interface CreateTagInput {
  name: string;
  color?: string;
}
interface UpdateTagInput {
  name?: string;
  color?: string;
}

/**
 * Epic A2 — workspace-scoped lead tag taxonomy + Tag↔Lead membership.
 *
 * Assignment is by name and idempotent: unknown names are auto-created
 * (GHL behaviour), and only newly-linked tags produce a `tag.added` event so
 * downstream workflow triggers don't fire on no-op re-assignment.
 */
@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  private norm(name: string): string {
    return name.trim().toLowerCase();
  }

  private async emit(
    type: string,
    payload: Record<string, unknown> & { leadId: string },
  ): Promise<void> {
    try {
      await this.outbox.append({
        type,
        idempotencyKey: `${type}:${payload.leadId}:${Date.now()}`,
        payload,
      });
    } catch (e) {
      this.logger.warn(`${type} outbox append failed: ${(e as Error).message}`);
    }
  }

  async list(workspaceId: string) {
    const tags = await this.prisma.tag.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { leadTags: true } } },
    });
    return tags.map((t) => ({
      id: t.id,
      workspaceId: t.workspaceId,
      name: t.name,
      color: t.color,
      createdAt: t.createdAt,
      count: t._count.leadTags,
    }));
  }

  async create(workspaceId: string, dto: CreateTagInput) {
    const nameLower = this.norm(dto.name);
    if (!nameLower) throw new BadRequestException('Tag name is required');
    const dupe = await this.prisma.tag.findUnique({
      where: { workspaceId_nameLower: { workspaceId, nameLower } },
    });
    if (dupe) throw new ConflictException('A tag with this name already exists');
    return this.prisma.tag.create({
      data: { workspaceId, name: dto.name.trim(), nameLower, color: dto.color },
    });
  }

  private async getOwned(workspaceId: string, id: string) {
    const tag = await this.prisma.tag.findFirst({ where: { id, workspaceId } });
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  async update(workspaceId: string, id: string, dto: UpdateTagInput) {
    await this.getOwned(workspaceId, id);
    const data: { name?: string; nameLower?: string; color?: string | null } = {};
    if (dto.name !== undefined) {
      const nameLower = this.norm(dto.name);
      if (!nameLower) throw new BadRequestException('Tag name is required');
      const clash = await this.prisma.tag.findUnique({
        where: { workspaceId_nameLower: { workspaceId, nameLower } },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException('A tag with this name already exists');
      }
      data.name = dto.name.trim();
      data.nameLower = nameLower;
    }
    if (dto.color !== undefined) data.color = dto.color;
    return this.prisma.tag.update({ where: { id }, data });
  }

  async remove(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id);
    await this.prisma.tag.delete({ where: { id } }); // cascades lead_tags
    return { id };
  }

  /** Resolve existing tags by name (case-insensitive) or create them. */
  async resolveOrCreate(
    workspaceId: string,
    names: string[],
  ): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const nameLower = this.norm(raw);
      if (!nameLower || seen.has(nameLower)) continue;
      seen.add(nameLower);
      let tag = await this.prisma.tag.findUnique({
        where: { workspaceId_nameLower: { workspaceId, nameLower } },
      });
      if (!tag) {
        tag = await this.prisma.tag.create({
          data: { workspaceId, name: raw.trim(), nameLower },
        });
      }
      out.push({ id: tag.id, name: tag.name });
    }
    return out;
  }

  private async assertLead(workspaceId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
  }

  private async listLeadTags(leadId: string) {
    const rows = await this.prisma.leadTag.findMany({
      where: { leadId },
      include: { tag: true },
      orderBy: { assignedAt: 'asc' },
    });
    return rows.map((r) => ({ id: r.tag.id, name: r.tag.name, color: r.tag.color }));
  }

  async assignToLead(
    workspaceId: string,
    leadId: string,
    names: string[],
    actorId?: string,
  ) {
    await this.assertLead(workspaceId, leadId);
    const tags = await this.resolveOrCreate(workspaceId, names);
    if (tags.length) {
      const existing = await this.prisma.leadTag.findMany({
        where: { leadId, tagId: { in: tags.map((t) => t.id) } },
        select: { tagId: true },
      });
      const linked = new Set(existing.map((e) => e.tagId));
      const toAdd = tags.filter((t) => !linked.has(t.id));
      if (toAdd.length) {
        await this.prisma.leadTag.createMany({
          data: toAdd.map((t) => ({
            leadId,
            tagId: t.id,
            assignedById: actorId ?? null,
          })),
          skipDuplicates: true,
        });
        await this.emit('marketing.lead.tag.added.v1', {
          leadId,
          workspaceId,
          tagIds: toAdd.map((t) => t.id),
          tagNames: toAdd.map((t) => t.name),
        });
      }
    }
    return this.listLeadTags(leadId);
  }

  async unassignFromLead(workspaceId: string, leadId: string, tagIds: string[]) {
    await this.assertLead(workspaceId, leadId);
    const res = await this.prisma.leadTag.deleteMany({
      where: { leadId, tagId: { in: tagIds } },
    });
    if (res.count > 0) {
      await this.emit('marketing.lead.tag.removed.v1', {
        leadId,
        workspaceId,
        tagIds,
      });
    }
    return { removed: res.count };
  }

  async bulkAssign(workspaceId: string, leadIds: string[], names: string[], actorId?: string) {
    const tags = await this.resolveOrCreate(workspaceId, names);
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: leadIds }, workspaceId },
      select: { id: true },
    });
    const validIds = leads.map((l) => l.id);
    const data: { leadId: string; tagId: string; assignedById: string | null }[] = [];
    for (const leadId of validIds) {
      for (const tag of tags) {
        data.push({ leadId, tagId: tag.id, assignedById: actorId ?? null });
      }
    }
    if (data.length) {
      await this.prisma.leadTag.createMany({ data, skipDuplicates: true });
    }
    return { leads: validIds.length, tags: tags.length };
  }

  async bulkUnassign(workspaceId: string, leadIds: string[], tagIds: string[]) {
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: leadIds }, workspaceId },
      select: { id: true },
    });
    const validIds = leads.map((l) => l.id);
    const res = await this.prisma.leadTag.deleteMany({
      where: { leadId: { in: validIds }, tagId: { in: tagIds } },
    });
    return { removed: res.count };
  }
}
