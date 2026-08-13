import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { localMsisdnVariants, normalizeEmail, normalizePhone } from '../utils/lead-normalize';
import {
  IngestLeadCandidateDto,
  IngestLeadsDto,
} from '../dto/ingest-leads.dto';
import { LeadAutoAssignerService } from './lead-auto-assigner.service';
import { LeadQuotaResolver } from './lead-quota.resolver';

/**
 * Result shape for the ingest routine. `clipped` counts candidates dropped
 * because the workspace's daily quota ran out — the routine reads
 * `quota.remaining` to stop researching early. Dupes (`skipped`) never
 * consume quota. Caller can use `errors` to feed a retry queue without
 * re-submitting the whole batch.
 */
export interface IngestResult {
  created: number;
  skipped: number;
  clipped: number;
  errors: Array<{ externalRef: string; error: string }>;
  quota: { limit: number; used: number; remaining: number };
}

export const LEADS_INGESTED_METRIC = 'leads.ingested';

/** UTC day key — quota resets at midnight UTC for every workspace. */
export function utcPeriodKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

@Injectable()
export class MarketingLeadsIngestService {
  private readonly logger = new Logger(MarketingLeadsIngestService.name);

  // Cached per workspace after first lookup. The SYSTEM sentinel is
  // created once per workspace at provisioning time, so its id is
  // effectively immutable per deploy.
  private readonly sentinelIdByWorkspace = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly quotaResolver: LeadQuotaResolver,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Fire the `lead.created` workflow trigger for a researched lead.
   *
   * Every other inbound path emits this — public forms, order forms, webchat/DM
   * ingress, Meta lead ads, and `MarketingLeadsService.create` (whose own
   * comment records the same bug being fixed for manually-created leads). This
   * path did not, so a lead born from research ran NO automation, no Slack
   * alert, no outbound webhook.
   *
   * The sharp edge: the flagship automation for this product is "new AI_RESEARCH
   * lead → follow up within 24h", filtered on exactly `source = AI_RESEARCH`.
   * Research leads were the one kind that could never trigger it — the
   * automation only ever appeared to work because test leads were created by
   * hand through the service that does emit.
   *
   * Emitted AFTER the transaction commits, so a rolled-back lead never
   * announces itself, and best-effort: the lead is the delivery, and the
   * idempotency key makes a retry safe.
   */
  private async emitLeadCreated(workspaceId: string, leadId: string, source: string): Promise<void> {
    await this.outbox
      .append({
        type: MarketingEventTypes.LeadCreated,
        idempotencyKey: `lead-created:${leadId}`,
        payload: { workspaceId, leadId, source, occurredAt: new Date().toISOString() },
      })
      .catch((e) =>
        this.logger.warn(
          `lead.created outbox append failed for ${leadId}: ${(e as Error).message}`,
        ),
      );
  }

  private async resolveSentinel(workspaceId: string): Promise<string> {
    const cached = this.sentinelIdByWorkspace.get(workspaceId);
    if (cached) return cached;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    if (!row) {
      throw new InternalServerErrorException(
        'AI research sentinel user missing for workspace — run platform seed',
      );
    }
    this.sentinelIdByWorkspace.set(workspaceId, row.id);
    return row.id;
  }

  /**
   * Atomically reserve quota for this batch. A blocking per-workspace
   * advisory xact-lock serializes concurrent batches so two requests can
   * never both read the same counter value and over-admit; the lock is held
   * only for this tiny reserve tx, not for the whole create loop.
   * Returns how many creates this batch is allowed plus the meter state.
   */
  private async reserveQuota(
    workspaceId: string,
    want: number,
    periodKey: string,
  ): Promise<{ grant: number; limit: number; usedBefore: number }> {
    const limit = await this.quotaResolver.getDailyLeadQuota(workspaceId);

    if (limit === -1) {
      // Unlimited: still count usage for the meter, but grant everything.
      if (want > 0) {
        await this.bumpCounter(workspaceId, periodKey, want);
      }
      return { grant: want, limit, usedBefore: 0 };
    }
    if (limit === 0) return { grant: 0, limit, usedBefore: 0 };

    return this.prisma.$transaction(async (tx) => {
      // ::text cast — pg_advisory_xact_lock returns void, which Prisma's
      // raw deserializer refuses; the cast yields an empty string instead.
      await tx.$queryRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey(`ingest:${workspaceId}`)}))::text AS locked`,
      );
      const row = await tx.usageCounter.findUnique({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId,
            metric: LEADS_INGESTED_METRIC,
            periodKey,
          },
        },
        select: { value: true },
      });
      const usedBefore = row?.value ?? 0;
      const remaining = Math.max(0, limit - usedBefore);
      const grant = Math.min(want, remaining);
      if (grant > 0) {
        await tx.usageCounter.upsert({
          where: {
            workspaceId_metric_periodKey: {
              workspaceId,
              metric: LEADS_INGESTED_METRIC,
              periodKey,
            },
          },
          create: {
            workspaceId,
            metric: LEADS_INGESTED_METRIC,
            periodKey,
            value: grant,
          },
          update: { value: { increment: grant } },
        });
      }
      return { grant, limit, usedBefore };
    });
  }

  private async bumpCounter(
    workspaceId: string,
    periodKey: string,
    delta: number,
  ): Promise<void> {
    await this.prisma.usageCounter.upsert({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId,
          metric: LEADS_INGESTED_METRIC,
          periodKey,
        },
      },
      create: {
        workspaceId,
        metric: LEADS_INGESTED_METRIC,
        periodKey,
        value: delta,
      },
      update: { value: { increment: delta } },
    });
  }

  async ingest(workspaceId: string, dto: IngestLeadsDto): Promise<IngestResult> {
    const sentinelId = await this.resolveSentinel(workspaceId);
    // Capture the day key ONCE. reserve and settle MUST agree — if the batch
    // straddles midnight UTC, recomputing the key at settle time would refund the
    // unused grant from the NEXT day's counter (driving it negative) while the
    // reserve day stays permanently overcounted.
    const periodKey = utcPeriodKey();

    let created = 0;
    let skipped = 0;
    let clipped = 0;
    const errors: Array<{ externalRef: string; error: string }> = [];

    // Dedup in one scoped round-trip: externalRef is unique per
    // workspace now ([workspaceId, externalRef]), so the lookup must
    // never collapse refs across workspaces. Dupes are filtered BEFORE
    // quota reservation — a re-submitted batch must not eat quota.
    const existingRows = await this.prisma.lead.findMany({
      where: {
        workspaceId,
        externalRef: { in: dto.leads.map((c) => c.externalRef) },
      },
      select: { externalRef: true },
    });
    const existingRefs = new Set(existingRows.map((r) => r.externalRef));

    // Cross-path dedup. `mapToLeadData` writes phoneNormalized/emailNormalized
    // precisely so an AI-researched lead collides with the same business
    // arriving by form, webchat, import or manual entry — but nothing ever READ
    // them here. Matching on externalRef alone meant a prospect already in the
    // CRM under any other origin was minted a SECOND time (research is the only
    // inbound path that skipped this check; meta-leadgen and voice-ai both do
    // it), leaving two rows, two owners, and two reps calling one company.
    //
    // Tombstoned and merged-away leads are excluded: adopting one would attach
    // a live prospect to a row the workspace has already hidden.
    const adopted = await this.matchExistingByContact(workspaceId, dto.leads, existingRefs);

    const fresh: IngestLeadCandidateDto[] = [];
    const seenInBatch = new Set<string>();
    for (const c of dto.leads) {
      if (existingRefs.has(c.externalRef) || seenInBatch.has(c.externalRef) || adopted.has(c.externalRef)) {
        skipped++;
        continue;
      }
      seenInBatch.add(c.externalRef);
      fresh.push(c);
    }

    const { grant, limit, usedBefore } = await this.reserveQuota(
      workspaceId,
      fresh.length,
      periodKey,
    );
    const admitted = fresh.slice(0, grant);
    clipped = fresh.length - admitted.length;

    // Sequential — daily routine is bounded at 50 rows so latency is fine,
    // and we avoid hammering the connection pool with a parallel burst
    // alongside whatever else the marketing module is doing.
    //
    // try/finally so the quota settle ALWAYS runs: a mid-loop throw (a
    // non-P2002 error escaping the per-row try, or anything unexpected from
    // the connection pool) must still return the reserved-but-uncreated
    // slots — the refund is keyed on the ACTUAL `created` count, so the
    // budget is restored to exactly what was provisioned.
    try {
      for (const c of admitted) {
        try {
          if (existingRefs.has(c.externalRef)) {
            skipped++;
            continue;
          }
          let newLeadId: string | null = null;
          await this.prisma.$transaction(async (tx) => {
            // Pick an owner via the configured distribution strategy
            // before insert so the row is born already assigned — keeps
            // the "atanmamış lead" dashboard count honest.
            const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
            const lead = await tx.lead.create({
              data: {
                ...this.mapToLeadData(c),
                workspaceId,
                ...(autoOwner ? { assignedToId: autoOwner } : {}),
              },
            });
            newLeadId = lead.id;
            await tx.leadActivity.create({
              data: {
                leadId: lead.id,
                type: 'NOTE',
                title: 'Created by AI research routine',
                description: c.evidence,
                createdById: sentinelId,
              },
            });
            if (autoOwner) {
              await tx.leadActivity.create({
                data: {
                  leadId: lead.id,
                  type: 'STATUS_CHANGE',
                  title: `Auto-assigned on ingest`,
                  createdById: sentinelId,
                  metadata: {
                    kind: 'assignment',
                    fromUserId: null,
                    fromUserName: null,
                    toUserId: autoOwner,
                    auto: true,
                  },
                },
              });
            }
          });
          created++;
          // Announce only a COMMITTED lead, and only after the row exists.
          if (newLeadId) await this.emitLeadCreated(workspaceId, newLeadId, 'AI_RESEARCH');
        } catch (e: any) {
          // P2002 on the lead unique = TOCTOU race with a concurrent
          // ingest (or a duplicate inside the same batch). Treat as skip.
          if (e?.code === 'P2002') {
            skipped++;
            continue;
          }
          errors.push({
            externalRef: c.externalRef,
            error: e?.message ?? String(e),
          });
        }
      }
    } finally {
      // Settle: reserved-but-not-created slots (TOCTOU dupes, row errors) are
      // returned to the day's budget so a flaky batch can't starve a customer.
      const unsettled = grant - created;
      if (unsettled > 0 && limit !== -1) {
        await this.bumpCounter(workspaceId, periodKey, -unsettled).catch(
          (e) =>
            this.logger.error(
              `quota settle failed for ${workspaceId}: ${e?.message ?? e}`,
            ),
        );
      }
    }

    const used =
      limit === -1 ? usedBefore + created : usedBefore + created;
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used);

    this.logger.log(
      `AI ingest ws=${workspaceId}: created=${created} skipped=${skipped} clipped=${clipped} errors=${errors.length} quota=${used}/${limit}`,
    );
    return {
      created,
      skipped,
      clipped,
      errors,
      quota: { limit, used, remaining },
    };
  }

  /** Today's meter for UIs ({ limit, used, remaining, periodKey }). */
  async usageToday(workspaceId: string) {
    const limit = await this.quotaResolver.getDailyLeadQuota(workspaceId);
    const periodKey = utcPeriodKey();
    const row = await this.prisma.usageCounter.findUnique({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId,
          metric: LEADS_INGESTED_METRIC,
          periodKey,
        },
      },
      select: { value: true },
    });
    const used = row?.value ?? 0;
    return {
      limit,
      used,
      remaining: limit === -1 ? -1 : Math.max(0, limit - used),
      periodKey,
    };
  }

  /**
   * Find candidates that are already in the CRM under a different origin,
   * matched on the canonical contact keys rather than on research's own
   * externalRef.
   *
   * The matched lead is STAMPED with the candidate's externalRef when it has
   * none. That is not bookkeeping: `ResearchCandidateService.accept` links a
   * candidate to its lead by looking the ref up afterwards, so without the
   * stamp an adopted candidate would find no lead, stay PENDING forever, and be
   * re-offered by every future run — the queue would never drain. The stamp
   * also makes the next run dedup on the cheap ref path directly.
   */
  private async matchExistingByContact(
    workspaceId: string,
    candidates: IngestLeadCandidateDto[],
    alreadyMatchedRefs: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    const adopted = new Map<string, string>();
    for (const c of candidates) {
      if (alreadyMatchedRefs.has(c.externalRef) || adopted.has(c.externalRef)) continue;
      const phoneNormalized = normalizePhone(c.phone);
      const emailNormalized = normalizeEmail(c.email);
      if (!phoneNormalized && !emailNormalized) continue;

      const existing = await this.prisma.lead.findFirst({
        where: {
          workspaceId,
          mergedIntoId: null,
          deletedAt: null,
          OR: [
            ...(emailNormalized ? [{ emailNormalized }] : []),
            // Every stored spelling (0- / bare / 90- / +90 / 00-): research
            // yields E.164 while the same business's web form stored a
            // 0-prefixed number, and an exact match would miss it.
            ...(phoneNormalized ? [{ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } }] : []),
          ],
        },
        select: { id: true, externalRef: true },
      });
      if (!existing) continue;

      adopted.set(c.externalRef, existing.id);
      if (existing.externalRef === null) {
        // Conditional so a concurrent stamp cannot be overwritten, and
        // best-effort so a losing race still dedups — the duplicate not being
        // created matters more than the linkage.
        await this.prisma.lead
          .updateMany({
            where: { id: existing.id, externalRef: null },
            data: { externalRef: c.externalRef },
          })
          .catch((e) =>
            this.logger.warn(`externalRef stamp failed for lead ${existing.id}: ${e?.message ?? e}`),
          );
      }
    }
    return adopted;
  }

  private mapToLeadData(c: IngestLeadCandidateDto) {
    return {
      businessName: c.businessName,
      // Routine doesn't emit a contact name; default to the biz name so the
      // required column is populated. Sales rep can rename on first contact.
      contactPerson: c.businessName,
      phone: c.phone,
      email: c.email,
      // Canonical dedup keys so an AI-ingested lead collides with a later
      // form/manual/booking lead that has the same email/phone (cross-path).
      phoneNormalized: normalizePhone(c.phone),
      emailNormalized: normalizeEmail(c.email),
      city: c.city,
      region: c.region,
      businessType: c.businessType,
      branchCount: c.branchCount,
      currentSystem: c.currentSystem,
      source: 'AI_RESEARCH',
      status: 'NEW',
      priority: c.priority ?? 'MEDIUM',
      externalRef: c.externalRef,
      notes: this.buildNotes(c),
    };
  }

  private buildNotes(c: IngestLeadCandidateDto): string {
    const lines: string[] = [
      `PainPoint: ${c.painPoint}`,
      `Evidence: ${c.evidence}`,
      `Pitch: ${c.pitch}`,
    ];
    if (c.currentSystem) lines.push(`Current system: ${c.currentSystem}`);
    if (c.stage) lines.push(`Stage: ${c.stage}`);
    if (c.instagram) {
      const handle = c.instagram.startsWith('@')
        ? c.instagram
        : `@${c.instagram}`;
      lines.push(`Instagram: ${handle}`);
    }
    if (c.website) lines.push(`Website: ${c.website}`);
    return lines.join('\n');
  }
}

/** Single-quote a lock key for the raw advisory-lock SELECT (no user input
 * reaches this — workspace ids are server-side UUIDs — but escape anyway). */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}
