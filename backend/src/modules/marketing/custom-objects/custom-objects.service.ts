import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CustomFieldsService } from '../services/custom-fields.service';
import {
  CreateCustomFieldDefDto,
  UpdateCustomFieldDefDto,
} from '../dto/custom-field.dto';
import {
  CreateCustomObjectDto,
  UpdateCustomObjectDto,
  UpsertRecordDto,
  LinkContactDto,
  RecordQueryDto,
} from '../dto/custom-object.dto';

/**
 * Custom Objects (GoHighLevel parity). Each workspace defines its own record
 * types; an object's FIELDS reuse CustomFieldDef rows namespaced by
 * `entity = "OBJ:<key>"`, so the existing type/validation machinery is shared.
 * Records hold validated values in JSONB with a denormalized `displayName`
 * (the primary field's value) for cheap list/search. Links associate a record
 * with a Contact (Lead, soft ref). Everything is workspace-scoped: every
 * multi-row/create call inlines `workspaceId`.
 */
/** Object keys that collide with the controller's literal route prefixes. */
const RESERVED_KEYS = new Set(['records', 'contacts']);

@Injectable()
export class CustomObjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customFields: CustomFieldsService,
  ) {}

  /** The CustomFieldDef `entity` namespace for an object's fields. */
  private entityOf(key: string): string {
    return `OBJ:${key}`;
  }

  // ── Object definitions ──────────────────────────────────────────────────────

  listObjects(workspaceId: string, includeArchived = false) {
    return this.prisma.customObjectDef.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archived: false }) },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createObject(workspaceId: string, dto: CreateCustomObjectDto) {
    // These collide with the controller's literal route prefixes
    // (/custom-objects/records/…, /custom-objects/contacts/…), so an object
    // with such a key could never be addressed by its :key routes. Reject them.
    if (RESERVED_KEYS.has(dto.key)) {
      throw new BadRequestException(`"${dto.key}" is a reserved key`);
    }
    const dupe = await this.prisma.customObjectDef.findUnique({
      where: { workspaceId_key: { workspaceId, key: dto.key } },
    });
    if (dupe) throw new ConflictException(`Custom object "${dto.key}" already exists`);
    return this.prisma.customObjectDef.create({
      data: {
        workspaceId,
        key: dto.key,
        labelSingular: dto.labelSingular,
        labelPlural: dto.labelPlural,
        primaryField: dto.primaryField ?? 'name',
        description: dto.description ?? null,
        icon: dto.icon ?? null,
      },
    });
  }

  /** Resolve an object def by key, scoped to the workspace (or 404). */
  private async getObjectOrThrow(workspaceId: string, key: string) {
    const def = await this.prisma.customObjectDef.findUnique({
      where: { workspaceId_key: { workspaceId, key } },
    });
    if (!def || def.workspaceId !== workspaceId) {
      throw new NotFoundException('Custom object not found');
    }
    return def;
  }

  getObject(workspaceId: string, key: string) {
    return this.getObjectOrThrow(workspaceId, key);
  }

  async updateObject(workspaceId: string, key: string, dto: UpdateCustomObjectDto) {
    const def = await this.getObjectOrThrow(workspaceId, key);
    const updated = await this.prisma.customObjectDef.update({
      where: { id: def.id },
      data: {
        ...(dto.labelSingular !== undefined && { labelSingular: dto.labelSingular }),
        ...(dto.labelPlural !== undefined && { labelPlural: dto.labelPlural }),
        ...(dto.primaryField !== undefined && { primaryField: dto.primaryField }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
      },
    });
    // Repointing the primary field would otherwise leave every existing record's
    // denormalized displayName stale (it's only recomputed on record write).
    if (dto.primaryField !== undefined && dto.primaryField !== def.primaryField) {
      await this.backfillDisplayNames(workspaceId, def.id, updated.primaryField);
    }
    return updated;
  }

  /** Recompute displayName for an object's records (paged) after primaryField change. */
  private async backfillDisplayNames(workspaceId: string, objectDefId: string, primaryField: string) {
    const PAGE = 500;
    for (let skip = 0; ; skip += PAGE) {
      const recs = await this.prisma.customObjectRecord.findMany({
        where: { workspaceId, objectDefId },
        select: { id: true, values: true },
        orderBy: { createdAt: 'asc' },
        take: PAGE,
        skip,
      });
      if (recs.length === 0) break;
      await this.prisma.$transaction(
        recs.map((r) =>
          this.prisma.customObjectRecord.update({
            where: { id: r.id },
            data: {
              displayName: this.displayNameOf(primaryField, (r.values as Record<string, unknown>) ?? {}),
            },
          }),
        ),
      );
      if (recs.length < PAGE) break;
    }
  }

  async archiveObject(workspaceId: string, key: string) {
    const def = await this.getObjectOrThrow(workspaceId, key);
    return this.prisma.customObjectDef.update({
      where: { id: def.id },
      data: { archived: true },
    });
  }

  async restoreObject(workspaceId: string, key: string) {
    const def = await this.getObjectOrThrow(workspaceId, key);
    return this.prisma.customObjectDef.update({
      where: { id: def.id },
      data: { archived: false },
    });
  }

  // ── Fields (delegate to CustomFieldsService, namespaced per object) ──────────

  async listFields(workspaceId: string, key: string) {
    await this.getObjectOrThrow(workspaceId, key);
    return this.customFields.list(workspaceId, true, this.entityOf(key));
  }

  async createField(workspaceId: string, key: string, dto: CreateCustomFieldDefDto) {
    await this.getObjectOrThrow(workspaceId, key);
    return this.customFields.create(workspaceId, dto, this.entityOf(key));
  }

  async updateField(workspaceId: string, key: string, id: string, dto: UpdateCustomFieldDefDto) {
    await this.getObjectOrThrow(workspaceId, key);
    // Pass the OBJ:<key> entity so a LEAD / other-object field id 404s instead
    // of being mutated through this object's field route.
    return this.customFields.update(workspaceId, id, dto, this.entityOf(key));
  }

  async archiveField(workspaceId: string, key: string, id: string) {
    await this.getObjectOrThrow(workspaceId, key);
    return this.customFields.archive(workspaceId, id, this.entityOf(key));
  }

  async reorderFields(workspaceId: string, key: string, ids: string[]) {
    await this.getObjectOrThrow(workspaceId, key);
    return this.customFields.reorder(workspaceId, ids, this.entityOf(key));
  }

  // ── Records ──────────────────────────────────────────────────────────────────

  /** Denormalized display name from the object's primary field (bounded). */
  private displayNameOf(primaryField: string, values: Record<string, unknown>): string {
    const raw = values[primaryField];
    const s = raw === null || raw === undefined ? '' : String(raw);
    return s.trim().slice(0, 200) || '(untitled)';
  }

  async listRecords(workspaceId: string, key: string, q: RecordQueryDto) {
    const def = await this.getObjectOrThrow(workspaceId, key);
    const search = q.search?.trim();
    // workspaceId is inlined in BOTH calls (the fitness test requires a literal
    // workspaceId in the call args, not a hoisted `where` variable); only the
    // optional search predicate is shared.
    const match: Prisma.CustomObjectRecordWhereInput = search
      ? { displayName: { contains: search, mode: 'insensitive' } }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customObjectRecord.findMany({
        where: { workspaceId, objectDefId: def.id, ...match },
        orderBy: { updatedAt: 'desc' },
        take: q.take ?? 50,
        skip: q.skip ?? 0,
      }),
      this.prisma.customObjectRecord.count({ where: { workspaceId, objectDefId: def.id, ...match } }),
    ]);
    return { rows, total };
  }

  async createRecord(workspaceId: string, key: string, dto: UpsertRecordDto) {
    const def = await this.getObjectOrThrow(workspaceId, key);
    const values = await this.customFields.validateAndNormalize(
      workspaceId,
      this.entityOf(key),
      dto.values,
      'create',
    );
    return this.prisma.customObjectRecord.create({
      data: {
        workspaceId,
        objectDefId: def.id,
        values: values as Prisma.InputJsonValue,
        displayName: this.displayNameOf(def.primaryField, values),
      },
    });
  }

  private async getRecordOwned(workspaceId: string, id: string) {
    const rec = await this.prisma.customObjectRecord.findFirst({
      where: { id, workspaceId },
      include: { objectDef: true },
    });
    if (!rec) throw new NotFoundException('Record not found');
    return rec;
  }

  async getRecord(workspaceId: string, id: string) {
    const rec = await this.getRecordOwned(workspaceId, id);
    const contacts = await this.listRecordContacts(workspaceId, id);
    return { ...rec, contacts };
  }

  async updateRecord(workspaceId: string, id: string, dto: UpsertRecordDto) {
    const rec = await this.getRecordOwned(workspaceId, id);
    const partial = await this.customFields.validateAndNormalize(
      workspaceId,
      this.entityOf(rec.objectDef.key),
      dto.values,
      'update',
    );
    // Merge onto the existing values (a partial update patches, not replaces).
    const merged = { ...((rec.values as Record<string, unknown>) ?? {}), ...partial };
    return this.prisma.customObjectRecord.update({
      where: { id: rec.id },
      data: {
        values: merged as Prisma.InputJsonValue,
        displayName: this.displayNameOf(rec.objectDef.primaryField, merged),
      },
    });
  }

  async deleteRecord(workspaceId: string, id: string) {
    const rec = await this.getRecordOwned(workspaceId, id);
    await this.prisma.customObjectRecord.delete({ where: { id: rec.id } }); // cascades links
    return { message: 'Record deleted' };
  }

  // ── Links (record ↔ Contact) ─────────────────────────────────────────────────

  async linkContact(workspaceId: string, recordId: string, dto: LinkContactDto) {
    await this.getRecordOwned(workspaceId, recordId);
    // The Contact must belong to this workspace (no cross-tenant linking).
    const lead = await this.prisma.lead.findFirst({
      where: { id: dto.leadId, workspaceId },
      select: { id: true },
    });
    if (!lead) throw new BadRequestException('Contact not found in this workspace');
    return this.prisma.customObjectLink.upsert({
      where: { recordId_leadId: { recordId, leadId: dto.leadId } },
      create: { workspaceId, recordId, leadId: dto.leadId, label: dto.label ?? null },
      update: { label: dto.label ?? null },
    });
  }

  async unlinkContact(workspaceId: string, recordId: string, linkId: string) {
    const link = await this.prisma.customObjectLink.findFirst({
      where: { id: linkId, workspaceId, recordId },
    });
    if (!link) throw new NotFoundException('Link not found');
    await this.prisma.customObjectLink.delete({ where: { id: link.id } });
    return { message: 'Contact unlinked' };
  }

  /** Contacts linked to a record (resolves the lead's display info, scoped). */
  async listRecordContacts(workspaceId: string, recordId: string) {
    const links = await this.prisma.customObjectLink.findMany({
      where: { workspaceId, recordId },
      orderBy: { createdAt: 'asc' },
    });
    if (links.length === 0) return [];
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, id: { in: links.map((l) => l.leadId) } },
      select: { id: true, businessName: true, contactPerson: true, phone: true, email: true },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return links.map((l) => ({
      linkId: l.id,
      leadId: l.leadId,
      label: l.label,
      contact: byId.get(l.leadId) ?? null, // null = lead since deleted
    }));
  }

  /** Records linked to a Contact (across all of the workspace's objects). */
  async listContactRecords(workspaceId: string, leadId: string) {
    const links = await this.prisma.customObjectLink.findMany({
      where: { workspaceId, leadId },
      orderBy: { createdAt: 'desc' },
    });
    if (links.length === 0) return [];
    const records = await this.prisma.customObjectRecord.findMany({
      where: { workspaceId, id: { in: links.map((l) => l.recordId) } },
      include: { objectDef: { select: { key: true, labelSingular: true } } },
    });
    const byId = new Map(records.map((r) => [r.id, r]));
    return links
      .map((l) => {
        const rec = byId.get(l.recordId);
        if (!rec) return null;
        return {
          linkId: l.id,
          label: l.label,
          recordId: rec.id,
          displayName: rec.displayName,
          objectKey: rec.objectDef.key,
          objectLabel: rec.objectDef.labelSingular,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }
}
