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
    try {
      return await this.prisma.tag.create({
        data: { workspaceId, name: dto.name.trim(), nameLower, color: dto.color },
      });
    } catch (e) {
      // Lost the race on the (workspaceId, nameLower) unique to a concurrent
      // create — surface a clean 409, not an unhandled 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A tag with this name already exists');
      }
      throw e;
    }
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
    try {
      return await this.prisma.tag.update({ where: { id }, data });
    } catch (e) {
      // The clash pre-check above is racy; a concurrent rename to the same name
      // trips the (workspaceId, nameLower) unique after the check passes. Map it
      // to a clean 409 like create() does, not a raw P2002 → 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A tag with this name already exists');
      }
      throw e;
    }
  }

  /**
   * Names of segments whose saved definition references this tagId. A DYNAMIC
   * segment stores tag predicates as { field: 'tag', cmp: 'has'|'hasNot',
   * value: <tagId> } inside a nested and/or tree. Deleting the tag would
   * SILENTLY rewrite those segments' meaning: compile() turns a `hasNot` leaf
   * into { tags: { none: { tagId } } }, which — once no lead carries the deleted
   * tag — matches EVERY lead, so a "leads WITHOUT tag X" audience explodes to the
   * whole workspace (and a `has` leaf empties). That compiled filter feeds
   * segment previews AND Meta/TikTok/LinkedIn Custom Audience sync, so the
   * blast radius is exporting every lead's PII. Block the delete instead.
   */
  private async segmentsReferencingTag(
    workspaceId: string,
    tagId: string,
  ): Promise<string[]> {
    const segments = await this.prisma.segment.findMany({
      where: { workspaceId },
      select: { name: true, definition: true },
    });
    const refs = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      const n = node as { children?: unknown; field?: unknown; value?: unknown };
      if (Array.isArray(n.children)) return n.children.some(refs);
      return n.field === 'tag' && n.value === tagId;
    };
    return segments.filter((s) => refs(s.definition)).map((s) => s.name);
  }

  async remove(workspaceId: string, id: string) {
    await this.getOwned(workspaceId, id);
    const dependents = await this.segmentsReferencingTag(workspaceId, id);
    if (dependents.length) {
      const shown = dependents.slice(0, 5).join(', ');
      throw new ConflictException(
        `This tag is used by ${dependents.length} segment(s): ${shown}${dependents.length > 5 ? ', …' : ''}. Remove it from those segments first.`,
      );
    }
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
        try {
          tag = await this.prisma.tag.create({
            data: { workspaceId, name: raw.trim(), nameLower },
          });
        } catch (e) {
          // Concurrent first-use of the same tag name (workflows / bulkAssign add
          // the same new tag in parallel) loses the unique race — re-resolve the
          // winner instead of failing the whole tag/lead operation with a 500.
          if ((e as { code?: string })?.code === 'P2002') {
            tag = await this.prisma.tag.findUnique({
              where: { workspaceId_nameLower: { workspaceId, nameLower } },
            });
          }
          if (!tag) throw e;
        }
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

  async getLeadTags(workspaceId: string, leadId: string) {
    await this.assertLead(workspaceId, leadId);
    return this.listLeadTags(leadId);
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
    if (!tags.length || !validIds.length) {
      return { leads: validIds.length, tags: tags.length };
    }
    // Compute the ACTUALLY-new (leadId, tagId) links so we emit tag.added only for
    // real additions — mirroring assignToLead. Without this the bulk path minted
    // links but fired NO domain event, so tag.added workflow triggers + outbound
    // webhooks silently skipped exactly the high-volume cohort-tagging operation.
    const existing = await this.prisma.leadTag.findMany({
      where: { leadId: { in: validIds }, tagId: { in: tags.map((t) => t.id) } },
      select: { leadId: true, tagId: true },
    });
    const linked = new Set(existing.map((e) => `${e.leadId}:${e.tagId}`));
    const data: { leadId: string; tagId: string; assignedById: string | null }[] = [];
    const addedByLead = new Map<string, { ids: string[]; names: string[] }>();
    for (const leadId of validIds) {
      for (const tag of tags) {
        if (linked.has(`${leadId}:${tag.id}`)) continue;
        data.push({ leadId, tagId: tag.id, assignedById: actorId ?? null });
        const acc = addedByLead.get(leadId) ?? { ids: [], names: [] };
        acc.ids.push(tag.id);
        acc.names.push(tag.name);
        addedByLead.set(leadId, acc);
      }
    }
    if (data.length) {
      await this.prisma.leadTag.createMany({ data, skipDuplicates: true });
      for (const [leadId, added] of addedByLead) {
        await this.emit('marketing.lead.tag.added.v1', {
          leadId,
          workspaceId,
          tagIds: added.ids,
          tagNames: added.names,
        });
      }
    }
    return { leads: validIds.length, tags: tags.length };
  }

  async bulkUnassign(workspaceId: string, leadIds: string[], tagIds: string[]) {
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: leadIds }, workspaceId },
      select: { id: true },
    });
    const validIds = leads.map((l) => l.id);
    // Capture which leads actually carry a matching link BEFORE deleting, so we
    // emit tag.removed only for real removals (mirrors unassignFromLead's
    // res.count>0 guard). Bulk-unassign previously fired no event at all.
    const toRemove = validIds.length
      ? await this.prisma.leadTag.findMany({
          where: { leadId: { in: validIds }, tagId: { in: tagIds } },
          select: { leadId: true, tagId: true },
        })
      : [];
    const res = await this.prisma.leadTag.deleteMany({
      where: { leadId: { in: validIds }, tagId: { in: tagIds } },
    });
    if (toRemove.length) {
      const byLead = new Map<string, string[]>();
      for (const r of toRemove) {
        const acc = byLead.get(r.leadId) ?? [];
        acc.push(r.tagId);
        byLead.set(r.leadId, acc);
      }
      for (const [leadId, ids] of byLead) {
        await this.emit('marketing.lead.tag.removed.v1', { leadId, workspaceId, tagIds: ids });
      }
    }
    return { removed: res.count };
  }
}
