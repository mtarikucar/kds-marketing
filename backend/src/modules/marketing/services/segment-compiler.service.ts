import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export type SegmentLeaf = { field: string; cmp: string; value?: unknown };
export type SegmentGroup = { op: 'and' | 'or'; children: SegmentNode[] };
export type SegmentNode = SegmentGroup | SegmentLeaf;

type FieldType = 'string' | 'number' | 'date' | 'bool';

/** Whitelisted native Lead columns a segment may filter on, with their types. */
const NATIVE_FIELDS: Record<string, FieldType> = {
  status: 'string',
  city: 'string',
  region: 'string',
  source: 'string',
  businessType: 'string',
  priority: 'string',
  businessName: 'string',
  currentSystem: 'string',
  email: 'string',
  phone: 'string',
  aiScore: 'number',
  tableCount: 'number',
  branchCount: 'number',
  createdAt: 'date',
  updatedAt: 'date',
  nextFollowUp: 'date',
  convertedAt: 'date',
  emailOptOut: 'bool',
  smsOptOut: 'bool',
  waOptOut: 'bool',
};

const CMP_BY_TYPE: Record<FieldType, string[]> = {
  string: ['eq', 'ne', 'in', 'nin', 'contains', 'startsWith', 'isSet', 'isNotSet'],
  number: ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'isSet', 'isNotSet'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isSet', 'isNotSet'],
  bool: ['eq', 'ne'],
};
const TAG_CMP = ['has', 'hasNot'];
// isSet/isNotSet on JSON paths are deliberately excluded in v1 (Prisma JSON
// null semantics are ambiguous when the key is absent vs. explicitly null).
const CF_CMP = ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith'];

const MAX_DEPTH = 6;
const MAX_NODES = 100;
// Per-leaf value-array cap. MAX_NODES bounds the TREE, but a single `in`/`nin`
// leaf expands into one OR clause per array element — so without this cap one
// node ({cf:x in [100k items]}) compiles to a 100k-clause OR that stalls the DB.
const MAX_VALUE_ARRAY = 500;

function isGroup(node: SegmentNode): node is SegmentGroup {
  return !!node && typeof node === 'object' && 'op' in node;
}

/**
 * Epic A3 — compiles a segment predicate tree into a Prisma `LeadWhereInput`.
 * `compile` is pure (no DB); `validate` is async (it checks `cf:` keys against
 * the workspace's custom-field definitions). The same compiler resolves both
 * saved segments and campaign audiences.
 */
@Injectable()
export class SegmentCompilerService {
  constructor(private prisma: PrismaService) {}

  compile(
    workspaceId: string,
    definition: SegmentNode | null | undefined,
  ): Prisma.LeadWhereInput {
    const base: Prisma.LeadWhereInput = { workspaceId };
    if (
      !definition ||
      (isGroup(definition) && (!definition.children || definition.children.length === 0))
    ) {
      return base;
    }
    return { AND: [base, this.buildNode(definition)] };
  }

  private buildNode(node: SegmentNode): Prisma.LeadWhereInput {
    if (isGroup(node)) {
      const key = node.op === 'or' ? 'OR' : 'AND';
      return { [key]: node.children.map((c) => this.buildNode(c)) };
    }
    return this.buildLeaf(node);
  }

  private buildLeaf(leaf: SegmentLeaf): Prisma.LeadWhereInput {
    const { field, cmp, value } = leaf;
    if (field === 'tag') {
      const tagId = value as string;
      return cmp === 'hasNot'
        ? { tags: { none: { tagId } } }
        : { tags: { some: { tagId } } };
    }
    if (field.startsWith('cf:')) {
      return this.buildCustomField(field.slice(3), cmp, value);
    }
    const type = NATIVE_FIELDS[field];
    if (!type) throw new BadRequestException(`Unknown segment field: ${field}`);
    return this.buildNative(field, type, cmp, value);
  }

  private coerce(type: FieldType, v: unknown): unknown {
    if (type === 'date') return new Date(v as string);
    if (type === 'number') return typeof v === 'number' ? v : Number(v);
    if (type === 'bool') return v === true || v === 'true';
    return v;
  }

  private buildNative(
    field: string,
    type: FieldType,
    cmp: string,
    value: unknown,
  ): Prisma.LeadWhereInput {
    const c = (v: unknown) => this.coerce(type, v);
    const arr = Array.isArray(value) ? value : [];
    let pred: unknown;
    switch (cmp) {
      case 'eq': pred = c(value); break;
      case 'ne': pred = { not: c(value) }; break;
      case 'in': pred = { in: arr.map(c) }; break;
      case 'nin': pred = { notIn: arr.map(c) }; break;
      case 'gt': case 'gte': case 'lt': case 'lte': pred = { [cmp]: c(value) }; break;
      case 'between': pred = { gte: c(arr[0]), lte: c(arr[1]) }; break;
      case 'contains': pred = { contains: value, mode: 'insensitive' }; break;
      case 'startsWith': pred = { startsWith: value, mode: 'insensitive' }; break;
      case 'isSet': pred = { not: null }; break;
      case 'isNotSet': pred = null; break;
      default: throw new BadRequestException(`Unsupported comparator: ${cmp}`);
    }
    return { [field]: pred } as Prisma.LeadWhereInput;
  }

  private buildCustomField(
    key: string,
    cmp: string,
    value: unknown,
  ): Prisma.LeadWhereInput {
    const path = [key];
    const arr = Array.isArray(value) ? value : [];
    const eq = (v: unknown): Prisma.LeadWhereInput => ({
      customFields: { path, equals: v as Prisma.InputJsonValue },
    });
    switch (cmp) {
      case 'eq': return eq(value);
      case 'ne': return { customFields: { path, not: value as Prisma.InputJsonValue } };
      case 'gt': case 'gte': case 'lt': case 'lte':
        return { customFields: { path, [cmp]: value } } as Prisma.LeadWhereInput;
      case 'contains':
        return { customFields: { path, string_contains: value as string } };
      case 'startsWith':
        return { customFields: { path, string_starts_with: value as string } };
      case 'in': return { OR: arr.map(eq) };
      case 'nin': return { NOT: { OR: arr.map(eq) } };
      default: throw new BadRequestException(`Unsupported comparator for custom field: ${cmp}`);
    }
  }

  // ---- validation -------------------------------------------------------

  async validate(
    workspaceId: string,
    definition: SegmentNode | null | undefined,
  ): Promise<void> {
    if (!definition) return;
    const defs = await this.prisma.customFieldDef.findMany({
      where: { workspaceId, entity: 'LEAD', archived: false },
      select: { key: true },
    });
    const cfKeys = new Set(defs.map((d) => d.key));
    let nodeCount = 0;

    const walk = (node: SegmentNode, depth: number, path: string): void => {
      if (depth > MAX_DEPTH) {
        throw new BadRequestException(`Segment nesting too deep (>${MAX_DEPTH}) at ${path}`);
      }
      if (++nodeCount > MAX_NODES) {
        throw new BadRequestException(`Segment has too many rules (>${MAX_NODES})`);
      }
      if (!node || typeof node !== 'object') {
        throw new BadRequestException(`Malformed segment node at ${path}`);
      }
      if (isGroup(node)) {
        if (node.op !== 'and' && node.op !== 'or') {
          throw new BadRequestException(`Group op must be and/or at ${path}`);
        }
        if (!Array.isArray(node.children) || node.children.length === 0) {
          throw new BadRequestException(`Group needs children at ${path}`);
        }
        node.children.forEach((c, i) => walk(c, depth + 1, `${path}.children[${i}]`));
        return;
      }
      this.validateLeaf(node, cfKeys, path);
    };

    walk(definition, 1, 'root');
  }

  private validateLeaf(leaf: SegmentLeaf, cfKeys: Set<string>, path: string): void {
    const { field, cmp } = leaf;
    if (typeof field !== 'string' || !field) {
      throw new BadRequestException(`Leaf needs a field at ${path}`);
    }
    const needsValue = cmp !== 'isSet' && cmp !== 'isNotSet';
    if (needsValue && leaf.value === undefined) {
      throw new BadRequestException(`Leaf "${field}" needs a value at ${path}`);
    }
    // Bound the value-array size (in/nin/between) so one leaf can't expand into a
    // pathological OR. (MAX_NODES counts nodes, not array elements.)
    if (Array.isArray(leaf.value) && leaf.value.length > MAX_VALUE_ARRAY) {
      throw new BadRequestException(`Too many values (${leaf.value.length} > ${MAX_VALUE_ARRAY}) at ${path}`);
    }
    if (field === 'tag') {
      if (!TAG_CMP.includes(cmp)) {
        throw new BadRequestException(`tag supports ${TAG_CMP.join('/')} at ${path}`);
      }
      // The tag value is cast to a string into `{ tags: { some: { tagId } } }` —
      // require an actual non-empty string so a non-string can't reach Prisma.
      if (typeof leaf.value !== 'string' || !leaf.value) {
        throw new BadRequestException(`tag "${field}" needs a tagId string at ${path}`);
      }
      return;
    }
    if (field.startsWith('cf:')) {
      const key = field.slice(3);
      if (!cfKeys.has(key)) {
        throw new BadRequestException(`Unknown custom field "${key}" at ${path}`);
      }
      if (!CF_CMP.includes(cmp)) {
        throw new BadRequestException(`Comparator "${cmp}" not allowed for custom field at ${path}`);
      }
      // The value SHAPE must match the comparator (custom fields carry no declared
      // type, but the comparator alone dictates the shape). Without this the cf:
      // branch returned unchecked and buildCustomField's `arr = Array.isArray(v)
      // ? v : []` fallback made a `cf:x nin <scalar>` compile to `{ NOT: { OR: [] }}`
      // — which matches EVERY lead, so a saved segment or CAMPAIGN AUDIENCE silently
      // targets the whole workspace; `in <scalar>` matches nothing; and a non-string
      // contains/startsWith compiles to a Prisma string filter that 500s on every
      // later evaluation. Mirrors the native-field shape guard below.
      if (needsValue) {
        if (cmp === 'in' || cmp === 'nin') {
          // Reject an EMPTY list too — `nin []` → `NOT: { OR: [] }` matches every
          // lead (silent workspace-wide audience); `in []` matches nothing.
          if (!Array.isArray(leaf.value) || leaf.value.length === 0) {
            throw new BadRequestException(`custom field "${key}" ${cmp} needs a non-empty list at ${path}`);
          }
        } else if (cmp === 'contains' || cmp === 'startsWith') {
          if (typeof leaf.value !== 'string') {
            throw new BadRequestException(`custom field "${key}" ${cmp} needs a string at ${path}`);
          }
        } else if (Array.isArray(leaf.value)) {
          throw new BadRequestException(`custom field "${key}" ${cmp} needs a single value at ${path}`);
        }
      }
      return;
    }
    const type = NATIVE_FIELDS[field];
    if (!type) throw new BadRequestException(`Unknown segment field "${field}" at ${path}`);
    if (!CMP_BY_TYPE[type].includes(cmp)) {
      throw new BadRequestException(`Comparator "${cmp}" not allowed for ${type} field "${field}" at ${path}`);
    }
    // Validate the value AGAINST the field type at save time, so a saved segment
    // can't compile to an Invalid Date / NaN Prisma filter that 500s on every
    // later evaluation (count/preview/audience). Mirrors custom-fields.coerce.
    if (needsValue) {
      const bad = (v: unknown) =>
        (type === 'number' && Number.isNaN(Number(v))) ||
        (type === 'date' && Number.isNaN(new Date(v as string).getTime())) ||
        // String columns aren't coerced (coerce() returns them as-is), so a
        // non-string value here compiles straight into a Prisma filter (e.g.
        // `{ businessName: { contains: {…} } }`) that throws on EVERY later
        // evaluation. Reject it at save time, like the number/date checks.
        (type === 'string' && typeof v !== 'string');
      // The value SHAPE must match the comparator, or compile() builds an invalid
      // Prisma filter that 500s on EVERY later evaluation:
      //   between → a [min, max] pair
      //   in/nin  → a list (array)
      //   else (eq/ne/gt/gte/lt/lte/contains/startsWith) → a single scalar; an
      //     ARRAY here compiles to `{ field: [..] }`, which Prisma rejects (the
      //     builder can leave a stale array when the operator is switched from
      //     in/nin → eq, and the raw-JSON editor can send one).
      if (cmp === 'between') {
        if (!Array.isArray(leaf.value) || leaf.value.length !== 2 || leaf.value.some(bad)) {
          throw new BadRequestException(`"${field}" between needs two valid ${type} values at ${path}`);
        }
      } else if (cmp === 'in' || cmp === 'nin') {
        // An EMPTY list must be rejected: `nin []` compiles to `notIn: []`, which
        // Prisma treats as match-EVERY-lead (a saved segment / campaign audience
        // silently targets the whole workspace), and `in []` matches nothing.
        if (!Array.isArray(leaf.value) || leaf.value.length === 0 || leaf.value.some(bad)) {
          throw new BadRequestException(`"${field}" ${cmp} needs a non-empty list of valid ${type} values at ${path}`);
        }
      } else if (Array.isArray(leaf.value) || bad(leaf.value)) {
        throw new BadRequestException(`"${field}" needs a single valid ${type} value at ${path}`);
      }
    }
  }
}
