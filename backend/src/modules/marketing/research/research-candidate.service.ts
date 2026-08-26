import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingLeadsIngestService, IngestResult } from '../services/marketing-leads-ingest.service';
import { normalizePhone, normalizeEmail, localMsisdnVariants, toE164 } from '../utils/lead-normalize';

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

    // The unique index is (workspaceId, profileId, externalRef), so the SAME
    // business staged under a different ref kind is a different row. That is
    // not hypothetical: this workspace has "Louise Cafe Brasserie & Loft"
    // twice for one profile — google:ChIJZQVk… on 22 Aug and
    // domain:louise.com.tr on 26 Aug — same phone, same website.
    //
    // The reviewer sees it twice, and the researcher spent credits finding a
    // business it had already staged. Same insight as the accept-path fix:
    // externalRef is one identity among several, and the CONTACT keys are the
    // ones that actually identify a business.
    //
    // Loaded once rather than per candidate: a run stages a batch, and this is
    // a suggestion queue, not a hot path.
    const pending = await this.prisma.researchCandidate.findMany({
      where: { workspaceId, profileId, status: 'PENDING' },
      select: { phone: true, website: true },
    });
    const seenPhones = new Set(
      pending.map((p) => toE164(p.phone)).filter((v): v is string => !!v),
    );
    const seenSites = new Set(
      pending.map((p) => normalizeSite(p.website)).filter((v): v is string => !!v),
    );

    for (const c of candidates) {
      // toE164, NOT normalizePhone: the latter is a raw digit-strip, so
      // "0545 447 51 00" and "+905454475100" reduce to different strings and
      // the duplicate sails through. That is the same spelling trap the
      // outbound path and the lead match keys both had.
      const phone = toE164(c.phone ?? null);
      const site = normalizeSite(c.website ?? null);
      if ((phone && seenPhones.has(phone)) || (site && seenSites.has(site))) {
        duplicates += 1;
        continue;
      }
      if (phone) seenPhones.add(phone);
      if (site) seenSites.add(site);

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

  /** URGENT first. `priority` is a String column, so SQL would sort it
   *  alphabetically (MEDIUM > LOW > HIGH > URGENT) — hence the explicit rank. */
  private static readonly PRIORITY_RANK: Record<string, number> = {
    URGENT: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
  };

  /**
   * The queue used to be ordered by `score` alone. Score comes straight from the
   * research model, and different runs used different scales (0-100, 0-10, 0-1),
   * so a 1-branch business that the model itself flagged as failing the ICP could
   * outrank a HIGH-priority match purely because its run happened to score out of
   * 100. Ordering now leads with `priority`, which has always been a constrained
   * enum and is therefore comparable across runs; score only breaks ties within a
   * band.
   *
   * The 200-row cut is taken by recency in SQL — a score-ordered cut would decide
   * what a reviewer never sees using the same untrustworthy number.
   */
  async list(workspaceId: string, opts: { status?: string; profileId?: string } = {}) {
    const rows = await this.prisma.researchCandidate.findMany({
      where: {
        workspaceId,
        status: opts.status ?? 'PENDING',
        ...(opts.profileId ? { profileId: opts.profileId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const rank = (p: string | null | undefined) =>
      ResearchCandidateService.PRIORITY_RANK[p ?? ''] ?? 0;

    return rows.sort(
      (a, b) => rank(b.priority) - rank(a.priority) || (b.score ?? -1) - (a.score ?? -1),
    );
  }

  /**
   * Resolve candidates to leads that already exist under a different
   * externalRef, using the same normalized contact keys ingest dedups on.
   *
   * `localMsisdnVariants` is used rather than an exact match for the reason its
   * own docstring gives: the same number is stored under different spellings
   * depending on which path created the lead, so an exact lookup silently
   * misses.
   */
  private async resolveByContact(
    workspaceId: string,
    rows: { id: string; phone: string | null; email: string | null }[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (rows.length === 0) return out;

    const phones = rows.flatMap((r) => {
      const p = normalizePhone(r.phone);
      return p ? localMsisdnVariants(p) : [];
    });
    const emails = rows
      .map((r) => normalizeEmail(r.email))
      .filter((e): e is string => !!e);
    if (phones.length === 0 && emails.length === 0) return out;

    const leads = await this.prisma.lead.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        mergedIntoId: null,
        OR: [
          ...(phones.length ? [{ phoneNormalized: { in: phones } }] : []),
          ...(emails.length ? [{ emailNormalized: { in: emails } }] : []),
        ],
      },
      select: { id: true, phoneNormalized: true, emailNormalized: true },
    });
    if (leads.length === 0) return out;

    const byPhone = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const l of leads) {
      if (l.phoneNormalized && !byPhone.has(l.phoneNormalized)) byPhone.set(l.phoneNormalized, l.id);
      if (l.emailNormalized && !byEmail.has(l.emailNormalized)) byEmail.set(l.emailNormalized, l.id);
    }

    for (const r of rows) {
      const p = normalizePhone(r.phone);
      const hit =
        (p ? localMsisdnVariants(p).map((v) => byPhone.get(v)).find(Boolean) : undefined) ??
        byEmail.get(normalizeEmail(r.email) ?? '');
      if (hit) out.set(r.id, hit);
    }
    return out;
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

    // Ingest dedups on the CONTACT match keys as well as externalRef (see
    // marketing-leads-ingest's cross-path dedup), so a candidate can be
    // recognised as a duplicate of a lead that is already in the CRM under a
    // DIFFERENT externalRef — a phone-keyed candidate matching a lead that came
    // in from a form, say. Linking back by externalRef alone missed exactly
    // those: ingest reported them `skipped`, no lead was found here, and they
    // sat PENDING forever — re-offered at every review, impossible to accept
    // because there is nothing left to create, and clogging the queue the
    // review flow depends on. Four were stuck this way in production.
    const byContact = await this.resolveByContact(
      workspaceId,
      rows.filter((r) => !byRef.has(r.externalRef)),
    );

    const now = new Date();
    let accepted = 0;
    for (const r of rows) {
      const leadId = byRef.get(r.externalRef) ?? byContact.get(r.id);
      // Only mark ACCEPTED when a Lead actually exists for this candidate. One
      // CLIPPED by the daily lead quota (or whose ingest errored) has no lead,
      // so leave it PENDING — otherwise it would flip to ACCEPTED with
      // leadId=null and vanish from the review queue forever, never becoming a
      // lead and never re-acceptable after the quota resets (silent loss of a
      // qualified prospect). That distinction is why the contact-key lookup
      // above matters: it separates "already in the CRM" from "not ingested
      // yet", which the externalRef-only check conflated.
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

/**
 * A website reduced to the thing that identifies the business: scheme, `www.`,
 * path and trailing slash all dropped. `http://www.louise.com.tr/` and
 * `https://louise.com.tr` are the same company and must collapse.
 */
function normalizeSite(raw: string | null | undefined): string | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  const host = v
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
  return host || undefined;
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
