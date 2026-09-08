import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ContentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DEFAULT_CONTENT_TYPES, type ContentTypeBeat } from './content-types.seed';

/** Slug shape for a type key: it ends up in URLs, stat rows and prompt text, so keep it ASCII. */
const KEY_RE = /^[a-z0-9-]{2,40}$/;

/**
 * Networks a type may declare. The design doc's set plus the planner's own
 * (PINTEREST, GMB) so an owner cannot type a network no adapter exists for —
 * a slot would otherwise be planned for an account that can never publish it.
 */
export const CONTENT_TYPE_NETWORKS = ['INSTAGRAM', 'TIKTOK', 'FACEBOOK', 'LINKEDIN', 'TWITTER', 'YOUTUBE', 'PINTEREST', 'GMB'] as const;

export interface CreateContentTypeInput {
  key: string;
  name: string;
  description?: string;
  structure?: ContentTypeBeat[];
  defaultDurationSec?: number;
  networks?: string[];
  minShare?: number;
  maxShare?: number;
}

export type UpdateContentTypeInput = Partial<Omit<CreateContentTypeInput, 'key'>> & { active?: boolean };

/**
 * The formats a programme rotates through (design K1).
 *
 * The seed is copied into the workspace once and edited there; nothing here
 * ever reads `DEFAULT_CONTENT_TYPES` after that copy, so an owner's rename or
 * retirement is never undone by a later `ensureDefaults`. Every read and write
 * is workspace-scoped: a type id from another workspace is simply NotFound.
 */
@Injectable()
export class ContentTypesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Copies the seed into the workspace, skipping keys that already exist, and
   * returns the whole ordered list. Safe to call on every programme create.
   */
  async ensureDefaults(workspaceId: string): Promise<ContentType[]> {
    await this.prisma.contentType.createMany({
      data: DEFAULT_CONTENT_TYPES.map((t) => ({
        workspaceId,
        key: t.key,
        name: t.name,
        description: t.description,
        structure: t.structure as unknown as Prisma.InputJsonValue,
        defaultDurationSec: t.defaultDurationSec,
        networks: [...t.networks],
        minShare: t.minShare,
        maxShare: t.maxShare,
        isSeed: true,
        ordinal: t.ordinal,
      })),
      skipDuplicates: true, // (workspaceId, key) is unique; a repeat call adds nothing
    });
    return this.list(workspaceId);
  }

  list(workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<ContentType[]> {
    return this.prisma.contentType.findMany({
      where: opts.activeOnly ? { workspaceId, active: true } : { workspaceId },
      orderBy: { ordinal: 'asc' },
    });
  }

  async create(workspaceId: string, input: CreateContentTypeInput): Promise<ContentType> {
    if (typeof input.key !== 'string' || !KEY_RE.test(input.key)) {
      throw new BadRequestException('key must be a slug: 2-40 chars of a-z, 0-9 and "-"');
    }
    const name = requireName(input.name);
    const structure = input.structure === undefined ? [] : requireStructure(input.structure);
    const minShare = input.minShare ?? 0.05;
    const maxShare = input.maxShare ?? 0.4;
    requireShares(minShare, maxShare);
    const networks = requireNetworks(input.networks ?? []);
    // Default the duration to the beats' sum so the two never disagree on create.
    const summed = structure.reduce((s, b) => s + b.durationSec, 0);
    const defaultDurationSec = requireDuration(input.defaultDurationSec ?? (summed > 0 ? summed : 15));

    const clash = await this.prisma.contentType.findFirst({ where: { workspaceId, key: input.key } });
    if (clash) throw new BadRequestException(`content type "${input.key}" already exists`);

    // Owner-defined types queue after everything present, so the seed order holds.
    const existing = await this.list(workspaceId);
    const ordinal = existing.reduce((m, t) => Math.max(m, t.ordinal), -1) + 1;

    return this.prisma.contentType.create({
      data: {
        workspaceId,
        key: input.key,
        name,
        description: (input.description ?? '').trim(),
        structure: structure as unknown as Prisma.InputJsonValue,
        defaultDurationSec,
        networks,
        minShare,
        maxShare,
        isSeed: false,
        ordinal,
      },
    });
  }

  /**
   * Settings-only patch. The key is immutable because concepts, slots and stat
   * rows reference it by value; renaming it would orphan the learning history.
   */
  async update(workspaceId: string, id: string, patch: UpdateContentTypeInput): Promise<ContentType> {
    if ('key' in patch) throw new BadRequestException('key is immutable');
    const current = await this.prisma.contentType.findFirst({ where: { id, workspaceId } });
    if (!current) throw new NotFoundException('Content type not found');

    const data: Prisma.ContentTypeUpdateInput = {};
    if (patch.name !== undefined) data.name = requireName(patch.name);
    if (patch.description !== undefined) data.description = String(patch.description).trim();
    if (patch.structure !== undefined) data.structure = requireStructure(patch.structure) as unknown as Prisma.InputJsonValue;
    if (patch.defaultDurationSec !== undefined) data.defaultDurationSec = requireDuration(patch.defaultDurationSec);
    if (patch.networks !== undefined) data.networks = requireNetworks(patch.networks);
    if (patch.minShare !== undefined || patch.maxShare !== undefined) {
      // Validate the PAIR the row will end up with, not just the field sent.
      const minShare = patch.minShare ?? current.minShare;
      const maxShare = patch.maxShare ?? current.maxShare;
      requireShares(minShare, maxShare);
      if (patch.minShare !== undefined) data.minShare = minShare;
      if (patch.maxShare !== undefined) data.maxShare = maxShare;
    }
    if (patch.active !== undefined) data.active = Boolean(patch.active);

    return this.prisma.contentType.update({ where: { id: current.id }, data });
  }
}

function requireName(name: unknown): string {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) throw new BadRequestException('name must not be empty');
  return s;
}

function requireShares(minShare: number, maxShare: number): void {
  const fin = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (!fin(minShare) || !fin(maxShare) || minShare < 0 || maxShare > 1 || minShare > maxShare) {
    throw new BadRequestException('shares must satisfy 0 <= minShare <= maxShare <= 1');
  }
}

function requireDuration(sec: unknown): number {
  if (typeof sec !== 'number' || !Number.isInteger(sec) || sec < 1 || sec > 600) {
    throw new BadRequestException('defaultDurationSec must be an integer between 1 and 600');
  }
  return sec;
}

function requireNetworks(networks: unknown): string[] {
  if (!Array.isArray(networks)) throw new BadRequestException('networks must be an array');
  const out = networks.map((n) => String(n).toUpperCase());
  const bad = out.find((n) => !(CONTENT_TYPE_NETWORKS as readonly string[]).includes(n));
  if (bad) throw new BadRequestException(`unknown network "${bad}"`);
  return Array.from(new Set(out));
}

/** A structure is a non-empty list of beats, each with a role, a positive duration and a guidance string. */
function requireStructure(structure: unknown): ContentTypeBeat[] {
  if (!Array.isArray(structure) || structure.length === 0) {
    throw new BadRequestException('structure must be a non-empty array of beats');
  }
  return structure.map((b, i) => {
    const beat = b as Partial<ContentTypeBeat> | null;
    const role = typeof beat?.role === 'string' ? beat.role.trim() : '';
    const durationSec = beat?.durationSec;
    if (!role || typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
      throw new BadRequestException(`beat ${i + 1} needs a role and a positive durationSec`);
    }
    return { role, durationSec, guidance: typeof beat?.guidance === 'string' ? beat.guidance.trim() : '' };
  });
}

/**
 * The lines the planner prompt gets for a type: what it is, how long, and each
 * beat with the window it occupies. Windows are cumulative so the model sees
 * "beat 2 (3-7s)" rather than a bare duration it would have to add up itself.
 * Tolerates a malformed `structure` column (it is JSON) by omitting the beats.
 */
export function typeGuidanceLines(t: Pick<ContentType, 'name' | 'description' | 'structure' | 'defaultDurationSec'>): string[] {
  const beats = readBeats(t.structure);
  const desc = (t.description ?? '').trim();
  const lines = [desc ? `İçerik tipi: ${t.name} — ${desc}` : `İçerik tipi: ${t.name}`];
  lines.push(beats.length ? `Toplam süre: ${t.defaultDurationSec} s, ${beats.length} beat.` : `Toplam süre: ${t.defaultDurationSec} s.`);
  let at = 0;
  beats.forEach((b, i) => {
    const end = at + b.durationSec;
    lines.push(`beat ${i + 1} (${fmt(at)}-${fmt(end)}s): ${b.role}${b.guidance ? ` — ${b.guidance}` : ''}`);
    at = end;
  });
  return lines;
}

/** Reads the beats out of the JSON column, dropping anything that is not a beat. */
export function readBeats(structure: unknown): ContentTypeBeat[] {
  if (!Array.isArray(structure)) return [];
  return structure.flatMap((b) => {
    const beat = b as Partial<ContentTypeBeat> | null;
    if (!beat || typeof beat.role !== 'string' || typeof beat.durationSec !== 'number' || !(beat.durationSec > 0)) return [];
    return [{ role: beat.role, durationSec: beat.durationSec, guidance: typeof beat.guidance === 'string' ? beat.guidance : '' }];
  });
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
