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

/**
 * Result shape for the ingest routine. Caller can use `errors` to feed
 * a retry queue without re-submitting the whole batch.
 */
export interface IngestResult {
  created: number;
  skipped: number;
  errors: Array<{ externalRef: string; error: string }>;
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

  async ingest(workspaceId: string, dto: IngestLeadsDto): Promise<IngestResult> {
    const sentinelId = await this.resolveSentinel(workspaceId);

    let created = 0;
    let skipped = 0;
    const errors: Array<{ externalRef: string; error: string }> = [];

    // Dedup in one scoped round-trip: externalRef is unique per
    // workspace now ([workspaceId, externalRef]), so the lookup must
    // never collapse refs across workspaces.
    const existingRows = await this.prisma.lead.findMany({
      where: {
        workspaceId,
        externalRef: { in: dto.leads.map((c) => c.externalRef) },
      },
      select: { externalRef: true },
    });
    const existingRefs = new Set(existingRows.map((r) => r.externalRef));

    // Sequential — daily routine is bounded at 50 rows so latency is fine,
    // and we avoid hammering the connection pool with a parallel burst
    // alongside whatever else the marketing module is doing.
    for (const c of dto.leads) {
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

    this.logger.log(
      `AI ingest: created=${created} skipped=${skipped} errors=${errors.length}`,
    );
    return { created, skipped, errors };
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
