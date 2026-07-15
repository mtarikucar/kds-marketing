import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingLeadsIngestService, IngestResult } from '../services/marketing-leads-ingest.service';

/** A qualified candidate the research agent produced (matches IngestLeadCandidateDto). */
export interface StagedCandidate {
  externalRef: string;
  businessName: string;
  city?: string;
  region?: string;
  businessType: string;
  phone?: string;
  instagram?: string;
  website?: string;
  email?: string;
  branchCount?: number;
  currentSystem?: string;
  stage?: string;
  priority?: string;
  painPoint: string;
  evidence: string;
  pitch: string;
  score?: number;
}

@Injectable()
export class ResearchCandidateService {
  private readonly logger = new Logger(ResearchCandidateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: MarketingLeadsIngestService,
  ) {}

  /**
   * Idempotently stage candidates for review (dedup on [workspaceId, profileId,
   * externalRef] so a re-run doesn't duplicate a still-pending suggestion).
   */
  async stage(
    workspaceId: string,
    profileId: string,
    agentRunId: string | null,
    candidates: StagedCandidate[],
  ): Promise<{ staged: number; duplicates: number }> {
    let staged = 0;
    let duplicates = 0;
    for (const c of candidates) {
      const res = await this.prisma.researchCandidate.createMany({
        data: [{
          workspaceId, profileId, agentRunId,
          externalRef: c.externalRef, businessName: c.businessName,
          city: c.city ?? null, region: c.region ?? null, businessType: c.businessType,
          phone: c.phone ?? null, instagram: c.instagram ?? null, website: c.website ?? null, email: c.email ?? null,
          branchCount: c.branchCount ?? null, currentSystem: c.currentSystem ?? null,
          stage: c.stage ?? null, priority: c.priority ?? 'MEDIUM',
          painPoint: c.painPoint, evidence: c.evidence, pitch: c.pitch, score: c.score ?? null,
        }],
        skipDuplicates: true, // the unique index collapses a repeat suggestion
      });
      if (res.count > 0) staged += 1;
      else duplicates += 1;
    }
    return { staged, duplicates };
  }

  list(workspaceId: string, opts: { status?: string; profileId?: string } = {}) {
    return this.prisma.researchCandidate.findMany({
      where: {
        workspaceId,
        status: opts.status ?? 'PENDING',
        ...(opts.profileId ? { profileId: opts.profileId } : {}),
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  /** Accept: ingest the candidates as Leads (dedup + daily quota apply here), mark ACCEPTED. */
  async accept(workspaceId: string, ids: string[]): Promise<{ accepted: number; ingest: IngestResult | null }> {
    const rows = await this.prisma.researchCandidate.findMany({
      where: { id: { in: ids }, workspaceId, status: 'PENDING' },
    });
    if (rows.length === 0) return { accepted: 0, ingest: null };

    const result = await this.ingest.ingest(workspaceId, { leads: rows.map(toIngestCandidate) });

    // Link each candidate to its Lead (created OR pre-existing) by externalRef.
    const refs = rows.map((r) => r.externalRef);
    const leads = await this.prisma.lead.findMany({
      where: { workspaceId, externalRef: { in: refs } },
      select: { id: true, externalRef: true },
    });
    const byRef = new Map(leads.map((l) => [l.externalRef, l.id]));
    const now = new Date();
    let accepted = 0;
    for (const r of rows) {
      const leadId = byRef.get(r.externalRef);
      // Only mark ACCEPTED when ingest actually created/linked a Lead. A candidate
      // CLIPPED by the daily lead quota (or one whose ingest errored) has no lead,
      // so leave it PENDING — otherwise it would flip to ACCEPTED with leadId=null
      // and vanish from the review queue forever, never becoming a lead and never
      // re-acceptable after the quota resets (silent loss of a qualified prospect).
      if (!leadId) continue;
      await this.prisma.researchCandidate.update({
        where: { id: r.id },
        data: { status: 'ACCEPTED', leadId, decidedAt: now },
      });
      accepted += 1;
    }
    return { accepted, ingest: result };
  }

  async reject(workspaceId: string, ids: string[]): Promise<{ rejected: number }> {
    const res = await this.prisma.researchCandidate.updateMany({
      where: { id: { in: ids }, workspaceId, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });
    return { rejected: res.count };
  }
}

function toIngestCandidate(c: {
  externalRef: string; businessName: string; city: string | null; region: string | null; businessType: string;
  phone: string | null; instagram: string | null; website: string | null; email: string | null;
  branchCount: number | null; currentSystem: string | null; stage: string | null; priority: string;
  painPoint: string; evidence: string; pitch: string;
}) {
  return {
    externalRef: c.externalRef,
    businessName: c.businessName,
    city: c.city ?? undefined,
    region: c.region ?? undefined,
    businessType: c.businessType,
    phone: c.phone ?? undefined,
    instagram: c.instagram ?? undefined,
    website: c.website ?? undefined,
    email: c.email ?? undefined,
    branchCount: c.branchCount ?? undefined,
    currentSystem: c.currentSystem ?? undefined,
    stage: (c.stage as 'GROWING' | 'STRUGGLING' | 'STABLE' | undefined) ?? undefined,
    priority: c.priority as never,
    painPoint: c.painPoint,
    evidence: c.evidence,
    pitch: c.pitch,
  };
}
