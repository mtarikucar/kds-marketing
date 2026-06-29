import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from './agency.service';

/**
 * Epic D1 — agency config SNAPSHOTS (GoHighLevel "snapshot" parity).
 *
 * A snapshot is a portable capture of one workspace's CONFIG — the things an
 * agency wants to clone across the sub-accounts it runs (custom-field defs,
 * tags, segments, workflows, agent personas, funnel pages, forms, booking
 * calendars, knowledge docs, review sources). It captures CONFIG ONLY, never
 * customer data (leads, conversations, offers, invoices, payments, users) — the
 * captured set is an explicit allow-list below, so customer rows can't leak in.
 *
 * Authorization model (mirrors the rest of the agency surface):
 *  - capture reads the SOURCE workspace and stores the snapshot OWNED by the
 *    agency (workspaceId = agency). The controller has already asserted the
 *    caller is an AGENCY owner, and capture is only allowed from the agency
 *    itself or one of its children (assertCapturable → assertAgencyOwns);
 *  - apply re-checks ownership of the TARGET via assertAgencyOwns(agency,
 *    target) FIRST, then writes the cloned config INTO the target workspace
 *    (stamping the target workspaceId) in ONE transaction, IDEMPOTENTLY (each
 *    type is upserted/skipped by its natural key, so re-apply never duplicates).
 *
 * Every captured record is stored in its PORTABLE shape — stripped of
 * id / workspaceId / createdAt / updatedAt — keyed by config type, so a payload
 * is a pure description of config and apply just stamps the target's ids/scoping.
 */

/** The config types a snapshot captures, in apply order (no intra-type FKs). */
export const SNAPSHOT_CONFIG_TYPES = [
  'customFieldDefs',
  'tags',
  'segments',
  'workflows',
  'agentProfiles',
  'sitePages',
  'formDefs',
  'bookingCalendars',
  'knowledgeDocs',
  'reviewSources',
] as const;

export type SnapshotConfigType = (typeof SNAPSHOT_CONFIG_TYPES)[number];

/**
 * reviewSource fields that must NEVER cross a workspace boundary: a sealed
 * OAuth credential plus the source's provider/sync binding to the SOURCE's
 * Google/FB account. Stripped on BOTH capture and apply — apply too, so a
 * snapshot captured before the capture-side guard can't reintroduce the leak.
 */
const REVIEW_SOURCE_SECRET_FIELDS = [
  'accessToken',
  'placeId',
  'externalRef',
  'syncStatus',
  'lastSyncedAt',
  'lastError',
] as const;

export type SnapshotPayload = Record<SnapshotConfigType, Record<string, unknown>[]>;

export interface ApplyTypeSummary {
  created: number;
  skipped: number;
}

export type ApplySummary = Record<SnapshotConfigType, ApplyTypeSummary>;

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agency: AgencyService,
  ) {}

  /**
   * A source is capturable by the agency if it IS the agency workspace itself
   * or one of its LOCATION children. assertAgencyOwns enforces the child case
   * (and 404s a foreign/missing id); the agency-itself case is allowed because
   * an agency may template its own config.
   */
  private async assertCapturable(
    agencyWorkspaceId: string,
    sourceWorkspaceId: string,
  ): Promise<void> {
    if (sourceWorkspaceId === agencyWorkspaceId) return;
    await this.agency.assertAgencyOwns(agencyWorkspaceId, sourceWorkspaceId);
  }

  /** Drop volatile / non-portable fields from a captured config row. */
  private portable<T extends Record<string, unknown>>(
    row: T,
    omit: readonly string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (omit.includes(k)) continue;
      if (v === null || v === undefined) continue;
      out[k] = v;
    }
    return out;
  }

  /**
   * Serialize the SOURCE workspace's CONFIG into a portable payload. Reads are
   * ALL workspaceId-scoped to the source, and the set is the fixed allow-list in
   * SNAPSHOT_CONFIG_TYPES — there is deliberately no path here that reads leads,
   * conversations, offers, invoices, payments or users.
   */
  async buildPayload(sourceWorkspaceId: string): Promise<SnapshotPayload> {
    // Every read is explicitly workspaceId-scoped to the SOURCE (inlined so the
    // multi-tenant arch-fitness check can see the scoping on each call site).
    const [
      customFieldDefs,
      tags,
      segments,
      workflows,
      agentProfiles,
      sitePages,
      formDefs,
      bookingCalendars,
      knowledgeDocs,
      reviewSources,
    ] = await Promise.all([
      this.prisma.customFieldDef.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.tag.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.segment.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.workflow.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.agentProfile.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.sitePage.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.formDef.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.bookingCalendar.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.knowledgeDoc.findMany({ where: { workspaceId: sourceWorkspaceId } }),
      this.prisma.reviewSource.findMany({ where: { workspaceId: sourceWorkspaceId } }),
    ]);

    const idOmit = ['id', 'workspaceId', 'createdAt', 'updatedAt'] as const;

    return {
      customFieldDefs: customFieldDefs.map((r) => this.portable(r, idOmit)),
      tags: tags.map((r) => this.portable(r, idOmit)),
      segments: segments.map((r) =>
        this.portable(r, [...idOmit, 'lastCount', 'lastEvaluatedAt']),
      ),
      workflows: workflows.map((r) => this.portable(r, [...idOmit, 'stats'])),
      // agentProfile.channels / kbDocIds reference source-local ids that have no
      // meaning in the target; drop them so the cloned persona starts unwired.
      agentProfiles: agentProfiles.map((r) =>
        this.portable(r, [...idOmit, 'channels', 'kbDocIds', 'bookingCalendarId']),
      ),
      sitePages: sitePages.map((r) => this.portable(r, idOmit)),
      formDefs: formDefs.map((r) => this.portable(r, idOmit)),
      bookingCalendars: bookingCalendars.map((r) =>
        this.portable(r, [...idOmit, 'ownerUserId']),
      ),
      // knowledgeDoc.searchVector is an Unsupported tsvector — never selected by
      // Prisma's default findMany, so it can't enter the payload.
      knowledgeDocs: knowledgeDocs.map((r) => this.portable(r, idOmit)),
      // reviewSource.accessToken is a SEALED OAuth credential and placeId/
      // externalRef/sync-state bind the row to the SOURCE's Google/FB account —
      // copying them would hand one workspace's credential to another (and make
      // the clone sync the SOURCE's reviews). Carry only the display config; the
      // clone starts DISCONNECTED, reconnected per-workspace like a fresh source.
      reviewSources: reviewSources.map((r) =>
        this.portable(r, [...idOmit, ...REVIEW_SOURCE_SECRET_FIELDS]),
      ),
    };
  }

  /**
   * Capture the source workspace's config into a new Snapshot owned by the
   * agency. `sourceWorkspaceId` defaults to the agency itself.
   */
  async capture(
    agencyWorkspaceId: string,
    input: { name: string; description?: string; sourceWorkspaceId?: string },
  ) {
    const sourceWorkspaceId = input.sourceWorkspaceId ?? agencyWorkspaceId;
    await this.assertCapturable(agencyWorkspaceId, sourceWorkspaceId);

    const payload = await this.buildPayload(sourceWorkspaceId);

    return this.prisma.snapshot.create({
      data: {
        workspaceId: agencyWorkspaceId,
        name: input.name,
        description: input.description ?? null,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** All snapshots owned by this agency. */
  async list(agencyWorkspaceId: string) {
    return this.prisma.snapshot.findMany({
      where: { workspaceId: agencyWorkspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
      },
    });
  }

  /** One snapshot the agency owns (404 if not, including cross-agency). */
  async get(agencyWorkspaceId: string, snapshotId: string) {
    const snapshot = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, workspaceId: agencyWorkspaceId },
    });
    if (!snapshot) throw new NotFoundException('Snapshot not found');
    return snapshot;
  }

  /** Coerce a stored payload back into the typed, fully-populated shape. */
  private normalizePayload(raw: Prisma.JsonValue): SnapshotPayload {
    const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const out = {} as SnapshotPayload;
    for (const type of SNAPSHOT_CONFIG_TYPES) {
      const list = obj[type];
      out[type] = Array.isArray(list)
        ? (list.filter(
            (r) => r && typeof r === 'object' && !Array.isArray(r),
          ) as Record<string, unknown>[])
        : [];
    }
    return out;
  }

  /**
   * Apply a snapshot's config INTO a target LOCATION the agency owns.
   *
   *  1. assertAgencyOwns(agency, target) — the load-bearing authorization gate;
   *     a foreign/missing target is a 404, indistinguishable from non-existent.
   *  2. In ONE transaction, for each config type, upsert/skip by NATURAL KEY so
   *     re-applying the same snapshot never duplicates rows. Existing rows in the
   *     target are left untouched (skip), so a partially-seeded location converges
   *     without clobbering local edits.
   *
   * Returns a per-type { created, skipped } summary.
   */
  async apply(
    snapshotId: string,
    targetWorkspaceId: string,
    agencyWorkspaceId: string,
  ): Promise<{ snapshotId: string; targetWorkspaceId: string; summary: ApplySummary }> {
    // (1) authorize: the target must be THIS agency's child LOCATION.
    await this.agency.assertAgencyOwns(agencyWorkspaceId, targetWorkspaceId);

    // The snapshot must be owned by the same agency (no applying another
    // agency's snapshot).
    const snapshot = await this.prisma.snapshot.findFirst({
      where: { id: snapshotId, workspaceId: agencyWorkspaceId },
    });
    if (!snapshot) throw new NotFoundException('Snapshot not found');

    if (targetWorkspaceId === agencyWorkspaceId) {
      // Defensive: assertAgencyOwns already 404s this (an agency is not its own
      // LOCATION child), but make the invariant explicit.
      throw new BadRequestException('Cannot apply a snapshot onto the agency itself');
    }

    const payload = this.normalizePayload(snapshot.payload);

    const blank = (): ApplyTypeSummary => ({ created: 0, skipped: 0 });
    const summary = {
      customFieldDefs: blank(),
      tags: blank(),
      segments: blank(),
      workflows: blank(),
      agentProfiles: blank(),
      sitePages: blank(),
      formDefs: blank(),
      bookingCalendars: blank(),
      knowledgeDocs: blank(),
      reviewSources: blank(),
    } satisfies ApplySummary;

    await this.prisma.$transaction(async (tx) => {
      // ── custom field defs — natural key (entity, key) ──
      for (const r of payload.customFieldDefs) {
        const entity = String(r.entity ?? 'LEAD');
        const key = String(r.key ?? '');
        if (!key) continue;
        const exists = await tx.customFieldDef.findFirst({
          where: { workspaceId: targetWorkspaceId, entity, key },
          select: { id: true },
        });
        if (exists) {
          summary.customFieldDefs.skipped++;
          continue;
        }
        await tx.customFieldDef.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.CustomFieldDefUncheckedCreateInput,
        });
        summary.customFieldDefs.created++;
      }

      // ── tags — natural key nameLower ──
      for (const r of payload.tags) {
        const nameLower = String(r.nameLower ?? String(r.name ?? '').toLowerCase());
        if (!nameLower) continue;
        const exists = await tx.tag.findFirst({
          where: { workspaceId: targetWorkspaceId, nameLower },
          select: { id: true },
        });
        if (exists) {
          summary.tags.skipped++;
          continue;
        }
        await tx.tag.create({
          data: { ...r, nameLower, workspaceId: targetWorkspaceId } as Prisma.TagUncheckedCreateInput,
        });
        summary.tags.created++;
      }

      // ── segments — natural key name ──
      for (const r of payload.segments) {
        const name = String(r.name ?? '');
        if (!name) continue;
        const exists = await tx.segment.findFirst({
          where: { workspaceId: targetWorkspaceId, name },
          select: { id: true },
        });
        if (exists) {
          summary.segments.skipped++;
          continue;
        }
        await tx.segment.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.SegmentUncheckedCreateInput,
        });
        summary.segments.created++;
      }

      // ── workflows — natural key name ──
      for (const r of payload.workflows) {
        const name = String(r.name ?? '');
        if (!name) continue;
        const exists = await tx.workflow.findFirst({
          where: { workspaceId: targetWorkspaceId, name },
          select: { id: true },
        });
        if (exists) {
          summary.workflows.skipped++;
          continue;
        }
        await tx.workflow.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.WorkflowUncheckedCreateInput,
        });
        summary.workflows.created++;
      }

      // ── agent profiles — natural key name ──
      for (const r of payload.agentProfiles) {
        const name = String(r.name ?? '');
        if (!name) continue;
        const exists = await tx.agentProfile.findFirst({
          where: { workspaceId: targetWorkspaceId, name },
          select: { id: true },
        });
        if (exists) {
          summary.agentProfiles.skipped++;
          continue;
        }
        await tx.agentProfile.create({
          // `channels` holds workspace-LOCAL Channel ids that are NOT part of a
          // snapshot — copying the source's would leave the clone "attached" to
          // channels that don't exist in the target (findActiveForChannel never
          // matches them) and surface dangling ids in the editor. Clear it so the
          // cloned agent starts unattached; the operator wires it to the target's
          // own channels. (kbDocIds / bookingCalendarId reference SNAPSHOTTED
          // entities and still need id-remapping — see snapshot-cross-ref-remap-gap.)
          data: { ...r, channels: [] as Prisma.InputJsonValue, workspaceId: targetWorkspaceId } as Prisma.AgentProfileUncheckedCreateInput,
        });
        summary.agentProfiles.created++;
      }

      // ── site pages — natural key slug ──
      for (const r of payload.sitePages) {
        const slug = String(r.slug ?? '');
        if (!slug) continue;
        const exists = await tx.sitePage.findFirst({
          where: { workspaceId: targetWorkspaceId, slug },
          select: { id: true },
        });
        if (exists) {
          summary.sitePages.skipped++;
          continue;
        }
        await tx.sitePage.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.SitePageUncheckedCreateInput,
        });
        summary.sitePages.created++;
      }

      // ── form defs — natural key name ──
      for (const r of payload.formDefs) {
        const name = String(r.name ?? '');
        if (!name) continue;
        const exists = await tx.formDef.findFirst({
          where: { workspaceId: targetWorkspaceId, name },
          select: { id: true },
        });
        if (exists) {
          summary.formDefs.skipped++;
          continue;
        }
        await tx.formDef.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.FormDefUncheckedCreateInput,
        });
        summary.formDefs.created++;
      }

      // ── booking calendars — natural key slug ──
      for (const r of payload.bookingCalendars) {
        const slug = String(r.slug ?? '');
        if (!slug) continue;
        const exists = await tx.bookingCalendar.findFirst({
          where: { workspaceId: targetWorkspaceId, slug },
          select: { id: true },
        });
        if (exists) {
          summary.bookingCalendars.skipped++;
          continue;
        }
        await tx.bookingCalendar.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.BookingCalendarUncheckedCreateInput,
        });
        summary.bookingCalendars.created++;
      }

      // ── knowledge docs — natural key title ──
      for (const r of payload.knowledgeDocs) {
        const title = String(r.title ?? '');
        if (!title) continue;
        const exists = await tx.knowledgeDoc.findFirst({
          where: { workspaceId: targetWorkspaceId, title },
          select: { id: true },
        });
        if (exists) {
          summary.knowledgeDocs.skipped++;
          continue;
        }
        await tx.knowledgeDoc.create({
          data: { ...r, workspaceId: targetWorkspaceId } as Prisma.KnowledgeDocUncheckedCreateInput,
        });
        summary.knowledgeDocs.created++;
      }

      // ── review sources — natural key name ──
      for (const r of payload.reviewSources) {
        const name = String(r.name ?? '');
        if (!name) continue;
        const exists = await tx.reviewSource.findFirst({
          where: { workspaceId: targetWorkspaceId, name },
          select: { id: true },
        });
        if (exists) {
          summary.reviewSources.skipped++;
          continue;
        }
        // Defence in depth: a snapshot captured before the capture-side guard
        // still has the sealed accessToken + source binding in its stored
        // payload, so strip them again here — applying an OLD snapshot must not
        // reintroduce the cross-tenant credential leak.
        const safe = this.portable(r, REVIEW_SOURCE_SECRET_FIELDS);
        await tx.reviewSource.create({
          data: { ...safe, workspaceId: targetWorkspaceId } as Prisma.ReviewSourceUncheckedCreateInput,
        });
        summary.reviewSources.created++;
      }
    });

    return { snapshotId, targetWorkspaceId, summary };
  }
}
