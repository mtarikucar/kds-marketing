import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import {
  CreateCustomFieldDefDto,
  UpdateCustomFieldDefDto,
} from '../dto/custom-field.dto';

const URL_RE = /^https?:\/\/.+/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type DefRow = {
  key: string;
  type: string;
  options: unknown;
  required: boolean;
};

/**
 * Epic A1 — workspace-scoped custom-field definitions + value validation.
 *
 * Definitions live in `custom_field_defs`; values live in `Lead.customFields`
 * (JSONB). `validateAndNormalize` is the seam the leads service calls before
 * persisting a lead — it coerces each value to its declared type, enforces
 * SELECT options + `required` (on create), and drops unknown keys.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private prisma: PrismaService,
    private outbox: OutboxService,
  ) {}

  list(workspaceId: string, includeArchived = false, entity = 'LEAD') {
    return this.prisma.customFieldDef.findMany({
      where: {
        workspaceId,
        entity,
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private slugify(label: string): string {
    return (
      label
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'field'
    );
  }

  async create(workspaceId: string, dto: CreateCustomFieldDefDto, entity = 'LEAD') {
    const key = dto.key ?? this.slugify(dto.label);
    const dupe = await this.prisma.customFieldDef.findUnique({
      where: { workspaceId_entity_key: { workspaceId, entity, key } },
    });
    if (dupe) {
      throw new ConflictException(`Custom field key "${key}" already exists`);
    }
    if (
      (dto.type === 'SELECT' || dto.type === 'MULTISELECT') &&
      !dto.options?.length
    ) {
      throw new BadRequestException('SELECT/MULTISELECT requires options');
    }
    try {
      return await this.prisma.customFieldDef.create({
        data: {
          workspaceId,
          entity,
          key,
          label: dto.label,
          type: dto.type,
          options: (dto.options ?? undefined) as any,
          required: dto.required ?? false,
          position: dto.position ?? 0,
        },
      });
    } catch (e) {
      // The dup pre-check above is racy; the (workspaceId, entity, key) unique is
      // the real guard. Map a concurrent same-key insert to a clean 409 (like
      // tags.create / snippets.create) instead of a raw P2002 → 500.
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException(`Custom field key "${key}" already exists`);
      }
      throw e;
    }
  }

  // `entity`, when supplied, is enforced in the lookup so a field id from a
  // DIFFERENT entity namespace (e.g. a LEAD field, or another custom object's
  // field) cannot be mutated through this call — closes the cross-entity /
  // privilege-boundary gap on the object-field routes. LEAD callers omit it
  // (their ids are always LEAD fields), preserving existing behavior.
  private async getOwned(workspaceId: string, id: string, entity?: string) {
    const def = await this.prisma.customFieldDef.findFirst({
      where: { id, workspaceId, ...(entity ? { entity } : {}) },
    });
    if (!def) throw new NotFoundException('Custom field not found');
    return def;
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateCustomFieldDefDto,
    entity?: string,
  ) {
    const def = await this.getOwned(workspaceId, id, entity);
    // A SELECT/MULTISELECT must keep at least one option — create() guards this,
    // and update must too: coerce() rejects every value against an empty option
    // list, so stripping the options would silently brick the field (no record
    // could set it again, with a confusing "value not in options" 400).
    if (
      dto.options !== undefined &&
      (def.type === 'SELECT' || def.type === 'MULTISELECT') &&
      !dto.options?.length
    ) {
      throw new BadRequestException('SELECT/MULTISELECT requires options');
    }
    return this.prisma.customFieldDef.update({
      where: { id },
      data: {
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.options !== undefined && { options: dto.options as any }),
        ...(dto.required !== undefined && { required: dto.required }),
        ...(dto.position !== undefined && { position: dto.position }),
      },
    });
  }

  async archive(workspaceId: string, id: string, entity?: string) {
    await this.getOwned(workspaceId, id, entity);
    return this.prisma.customFieldDef.update({
      where: { id },
      data: { archived: true },
    });
  }

  async restore(workspaceId: string, id: string, entity?: string) {
    await this.getOwned(workspaceId, id, entity);
    return this.prisma.customFieldDef.update({
      where: { id },
      data: { archived: false },
    });
  }

  async reorder(workspaceId: string, ids: string[], entity = 'LEAD') {
    // `entity` is part of the where so an id from another namespace is a no-op
    // (can't reposition LEAD / other-object fields via an object's reorder).
    await this.prisma.$transaction(
      ids.map((id, i) =>
        this.prisma.customFieldDef.updateMany({
          where: { id, workspaceId, entity },
          data: { position: i },
        }),
      ),
    );
    return this.list(workspaceId, true, entity);
  }

  /** Parse an ISO-ish date OR the Turkish day-first "DD.MM.YYYY" (optionally
   *  " HH:mm[:ss]"), which `new Date()` alone returns Invalid Date for — so
   *  a normally-formatted Turkish CSV date column no longer fails every row.
   *  Dot-separated is unambiguous vs ISO (dash) and US (slash). */
  private parseDate(raw: unknown): Date | null {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
    const s = String(raw).trim();
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const dt = new Date(Date.UTC(Number(m[3]), month - 1, day, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)));
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  private coerce(def: DefRow, raw: unknown, mode: 'create' | 'update'): unknown {
    const bad = (msg: string): never => {
      throw new BadRequestException(`"${def.key}": ${msg}`);
    };
    switch (def.type) {
      case 'NUMBER': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (raw === '' || raw === null || Number.isNaN(n)) bad('must be a number');
        return n;
      }
      case 'BOOL': {
        if (typeof raw === 'boolean') return raw;
        // Tolerant textual booleans — CSV import feeds the raw cell text, so
        // ordinary spellings (Yes/No, 1/0, on/off, the Turkish Evet/Hayır) must
        // parse; strict true/false alone rejected perfectly valid import rows.
        const s = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', 'evet'].includes(s)) return true;
        if (['false', '0', 'no', 'n', 'off', 'hayır', 'hayir'].includes(s)) return false;
        return bad('must be a boolean');
      }
      case 'DATE':
      case 'DATETIME': {
        const d = this.parseDate(raw);
        if (!d) bad('must be a valid date');
        return d!.toISOString();
      }
      case 'SELECT': {
        const opts = (def.options as { value: string }[] | null) ?? [];
        // Strict on CREATE. On UPDATE, GRANDFATHER an out-of-options value: the
        // edit form resubmits the FULL field map, so a value that was valid when
        // saved but whose option was later removed must not fail coercion and
        // brick the whole record save. The UI only offers current options, so in
        // practice an out-of-options update value is a pre-existing stored one.
        if (mode === 'create' && !opts.some((o) => o.value === raw)) bad('value not in options');
        return raw;
      }
      case 'MULTISELECT': {
        const opts = (def.options as { value: string }[] | null) ?? [];
        if (!Array.isArray(raw)) return bad('must be an array');
        // Same grandfathering as SELECT (a non-array is still malformed either way).
        if (mode === 'create') {
          for (const v of raw as unknown[]) {
            if (!opts.some((o) => o.value === v)) bad(`value "${String(v)}" not in options`);
          }
        }
        return raw;
      }
      case 'URL':
        if (!URL_RE.test(String(raw))) bad('must be a URL');
        return String(raw);
      case 'EMAIL':
        if (!EMAIL_RE.test(String(raw))) bad('must be an email');
        return String(raw);
      default:
        return String(raw); // TEXT, TEXTAREA, PHONE
    }
  }

  /**
   * Validate + coerce a `customFields` map against the workspace's definitions.
   * Unknown keys are dropped; empty values are skipped; required fields are
   * enforced only on create (a partial update can't see the whole record).
   */
  async validateAndNormalize(
    workspaceId: string,
    entity: string,
    input: Record<string, unknown> | undefined | null,
    mode: 'create' | 'update',
    opts: { clearEmpty?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const defs = await this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity, archived: false },
    });
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input ?? {})) {
      const def = byKey.get(k);
      if (!def) continue; // drop unknown
      if (v === null || v === undefined || v === '') {
        // SKIP empties by default so a blank import cell / omitted field can't
        // clobber the stored value (import calls this with mode='update'). Edit
        // forms send the FULL field map and pass clearEmpty: an explicitly
        // emptied field becomes null, so the caller's {...existing, ...partial}
        // merge actually CLEARS it instead of keeping the old value.
        if (opts.clearEmpty) out[k] = null;
        continue;
      }
      out[k] = this.coerce(def as DefRow, v, mode);
    }
    if (mode === 'create') {
      for (const d of defs) {
        // An empty MULTISELECT array is a PRESENT-but-empty value that passed
        // coercion untouched — it must not satisfy `required` (a required
        // multi-select with no choices is effectively unfilled).
        const val = out[d.key];
        const emptyArray = Array.isArray(val) && val.length === 0;
        if (d.required && (val === undefined || val === null || emptyArray)) {
          throw new BadRequestException(`Custom field "${d.key}" is required`);
        }
      }
    }
    return out;
  }
}
