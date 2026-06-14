import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
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
  ) {}

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
  ): Promise<{ grant: number; limit: number; usedBefore: number }> {
    const limit = await this.quotaResolver.getDailyLeadQuota(workspaceId);
    const periodKey = utcPeriodKey();

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

    const fresh: IngestLeadCandidateDto[] = [];
    const seenInBatch = new Set<string>();
    for (const c of dto.leads) {
      if (existingRefs.has(c.externalRef) || seenInBatch.has(c.externalRef)) {
        skipped++;
        continue;
      }
      seenInBatch.add(c.externalRef);
      fresh.push(c);
    }

    const { grant, limit, usedBefore } = await this.reserveQuota(
      workspaceId,
      fresh.length,
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
        await this.bumpCounter(workspaceId, utcPeriodKey(), -unsettled).catch(
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

  private mapToLeadData(c: IngestLeadCandidateDto) {
    return {
      businessName: c.businessName,
      // Routine doesn't emit a contact name; default to the biz name so the
      // required column is populated. Sales rep can rename on first contact.
      contactPerson: c.businessName,
      phone: c.phone,
      email: c.email,
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
