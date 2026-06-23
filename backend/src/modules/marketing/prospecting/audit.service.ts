import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import {
  ScheduledJobRunnerService,
  ClaimedJob,
} from '../scheduling/scheduled-job-runner.service';
import { MarketingLeadsService } from '../services/marketing-leads.service';
import { LeadSource } from '../dto/create-lead.dto';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';
import {
  PAGESPEED_ENDPOINT,
  PROSPECT_AUDIT_SCAN_KIND,
  isProspectingConfigured,
} from './prospecting.config';
import {
  AuditSection,
  MAX_HTML_BYTES,
  analyzeOnPage,
  analyzePageSpeed,
  skippedPageSpeed,
  overallScore,
} from './audit-checks';

/** A real, committed lead id — not null and not the transient claim sentinel. */
function settled(convertedLeadId: string | null | undefined): convertedLeadId is string {
  return !!convertedLeadId && !convertedLeadId.startsWith('pending:');
}

/** A convert that's been "in flight" this long is treated as crashed, so its
 *  claim can be reclaimed (a real convert takes well under a second). */
const SENTINEL_STALE_MS = 5 * 60 * 1000;

/** A `pending:<epochMs>:<rand>` claim sentinel older than the stale window. */
function staleSentinel(convertedLeadId: string | null | undefined): boolean {
  if (!convertedLeadId || !convertedLeadId.startsWith('pending:')) return false;
  const ts = Number(convertedLeadId.split(':')[1]);
  return Number.isFinite(ts) && Date.now() - ts > SENTINEL_STALE_MS;
}

/**
 * Prospecting audit (GHL parity, Epic 13 — inert until PAGESPEED_API_KEY).
 *
 * A workspace user points the tool at a prospect's website; an async
 * ScheduledJob fetches the page (SSRF-guarded) + Google PageSpeed Insights,
 * grades it into sections, and exposes a token-gated branded report that can be
 * converted into a Lead. No live path is touched: nothing fetches until an
 * operator enables PSI, and every outbound call goes through safeFetch.
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduledJob: ScheduledJobService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly leads: MarketingLeadsService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(PROSPECT_AUDIT_SCAN_KIND, (job) => this.runScan(job));
  }

  // ---- request / read ----

  /** Normalise + validate a user-supplied target into an http(s) origin URL. */
  private normalizeUrl(raw: string): string {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) throw new BadRequestException('A target website URL is required');
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let u: URL;
    try {
      u = new URL(withScheme);
    } catch {
      throw new BadRequestException('That does not look like a valid website URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException('Only http(s) websites can be audited');
    }
    return u.toString();
  }

  async request(workspaceId: string, dto: { targetUrl: string; businessName?: string }) {
    // Inert until an operator enables PageSpeed — production makes no outbound
    // audit fetch and creates no rows before ops opts in.
    if (!isProspectingConfigured()) {
      throw new ServiceUnavailableException('Prospecting audit is not enabled');
    }
    const targetUrl = this.normalizeUrl(dto.targetUrl);
    const audit = await this.prisma.prospectAudit.create({
      data: {
        workspaceId,
        targetUrl,
        businessName: dto.businessName?.trim() || null,
        status: 'PENDING',
        publicToken: `pa_${randomBytes(18).toString('hex')}`,
      },
    });
    await this.scheduledJob.schedule({
      workspaceId,
      kind: PROSPECT_AUDIT_SCAN_KIND,
      runAt: new Date(),
      payload: { auditId: audit.id },
      dedupKey: `prospect-audit:${audit.id}`,
      maxAttempts: 2,
    });
    return this.withReportPath(audit);
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.prospectAudit.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, targetUrl: true, businessName: true, status: true, score: true,
        publicToken: true, convertedLeadId: true, createdAt: true, completedAt: true,
      },
    });
    // Never surface the transient `pending:` claim sentinel to clients.
    return rows.map((r) => ({ ...r, convertedLeadId: settled(r.convertedLeadId) ? r.convertedLeadId : null }));
  }

  async get(workspaceId: string, id: string) {
    const audit = await this.prisma.prospectAudit.findFirst({ where: { id, workspaceId } });
    if (!audit) throw new NotFoundException('Audit not found');
    return this.withReportPath(audit);
  }

  /** Token-gated read for the public report page (no workspace context). */
  async publicView(token: string) {
    const audit = await this.prisma.prospectAudit.findUnique({ where: { publicToken: token } });
    if (!audit) throw new NotFoundException('Audit not found');
    return audit;
  }

  private withReportPath<T extends { publicToken: string; convertedLeadId?: string | null }>(
    audit: T,
  ): T & { reportPath: string } {
    return {
      ...audit,
      convertedLeadId: settled(audit.convertedLeadId) ? audit.convertedLeadId : null,
      reportPath: `/api/public/audits/${audit.publicToken}`,
    };
  }

  // ---- convert to lead ----

  async convertToLead(workspaceId: string, id: string, userId: string, userRole: string) {
    const audit = await this.prisma.prospectAudit.findFirst({ where: { id, workspaceId } });
    if (!audit) throw new NotFoundException('Audit not found');
    if (settled(audit.convertedLeadId)) {
      return { leadId: audit.convertedLeadId, alreadyConverted: true };
    }
    // Self-heal a claim wedged by a crash mid-convert: release a STALE `pending:`
    // sentinel so the audit is convertible again. A FRESH in-flight sentinel is
    // left alone — the claim below then returns count 0 and we adopt the winner.
    if (staleSentinel(audit.convertedLeadId)) {
      await this.prisma.prospectAudit.updateMany({
        where: { id, workspaceId, convertedLeadId: audit.convertedLeadId },
        data: { convertedLeadId: null },
      });
    }
    // Claim the audit BEFORE creating any lead. leads.create emits an immediately
    // committed lead.created event that cannot be retracted — so a create-then-
    // delete-the-loser approach would orphan that event and fire phantom
    // automations/webhooks. A short-lived `pending:` sentinel makes the claim
    // atomic so only the winner ever calls leads.create.
    const sentinel = `pending:${Date.now()}:${randomBytes(8).toString('hex')}`;
    const claim = await this.prisma.prospectAudit.updateMany({
      where: { id, workspaceId, convertedLeadId: null },
      data: { convertedLeadId: sentinel },
    });
    if (claim.count === 0) {
      const fresh = await this.prisma.prospectAudit.findFirst({
        where: { id, workspaceId },
        select: { convertedLeadId: true },
      });
      return {
        leadId: settled(fresh?.convertedLeadId) ? fresh!.convertedLeadId : null,
        alreadyConverted: true,
      };
    }
    const businessName = (audit.businessName || this.hostOf(audit.targetUrl)).slice(0, 255);
    let lead: { id: string };
    try {
      lead = await this.leads.create(
        workspaceId,
        {
          businessName,
          contactPerson: businessName,
          businessType: 'OTHER',
          source: LeadSource.WEBSITE,
          notes: `Imported from website audit of ${audit.targetUrl}${
            audit.score != null ? ` (overall score ${audit.score}/100)` : ''
          }.`,
        } as any,
        userId,
        userRole,
      );
    } catch (e) {
      // Release the claim so a retry can convert (we own the sentinel).
      await this.prisma.prospectAudit
        .updateMany({ where: { id, workspaceId, convertedLeadId: sentinel }, data: { convertedLeadId: null } })
        .catch(() => undefined);
      throw e;
    }
    await this.prisma.prospectAudit.updateMany({
      where: { id, workspaceId, convertedLeadId: sentinel },
      data: { convertedLeadId: lead.id },
    });
    return { leadId: lead.id, alreadyConverted: false };
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // ---- scan (ScheduledJob handler) ----

  private async runScan(job: ClaimedJob): Promise<void> {
    const auditId = String(job.payload?.auditId ?? '');
    if (!auditId) return;
    const audit = await this.prisma.prospectAudit.findFirst({
      where: { id: auditId, workspaceId: job.workspaceId },
    });
    // Idempotent: a re-dispatched job for an already-finished audit is a no-op.
    if (!audit || audit.status === 'DONE' || audit.status === 'FAILED') return;

    await this.prisma.prospectAudit.updateMany({
      where: { id: auditId, workspaceId: job.workspaceId },
      data: { status: 'RUNNING' },
    });

    const sections: AuditSection[] = [];
    let html: string;
    let finalUrl = audit.targetUrl;
    try {
      const res = await safeFetch(audit.targetUrl, { timeoutMs: 15_000 });
      finalUrl = res.url || audit.targetUrl;
      // Cap DURING streaming — res.text() would buffer the whole body first, so a
      // hostile/huge target could OOM this single-replica worker (and starve every
      // tenant's ScheduledJob dispatch) before the slice() ever ran.
      html = await this.readCapped(res, MAX_HTML_BYTES);
    } catch (e) {
      // The prospect's own site is unreachable/blocked — the audit can't proceed.
      const reason =
        e instanceof SsrfBlockedError
          ? 'The URL resolves to a disallowed or internal address'
          : 'The website could not be reached';
      await this.finish(auditId, job.workspaceId, 'FAILED', null, [], reason);
      return;
    }

    sections.push(analyzeOnPage(html, finalUrl));

    // PageSpeed Insights — best-effort: a PSI failure degrades the report (a
    // skipped performance section) but never fails an otherwise-good audit.
    const key = process.env.PAGESPEED_API_KEY;
    if (key) {
      try {
        const psiUrl =
          `${PAGESPEED_ENDPOINT}?url=${encodeURIComponent(finalUrl)}&key=${encodeURIComponent(key)}` +
          `&strategy=mobile&category=performance&category=seo&category=accessibility&category=best-practices`;
        const psiRes = await safeFetch(psiUrl, { timeoutMs: 30_000 });
        if (!psiRes.ok) throw new Error(`PSI HTTP ${psiRes.status}`);
        // Same bounded read — a Lighthouse report is well under 8 MB; anything
        // larger is truncated (→ JSON.parse throws → skipped section) rather than
        // buffered unbounded.
        const psiJson = JSON.parse(await this.readCapped(psiRes, 8 * 1024 * 1024));
        sections.push(...analyzePageSpeed(psiJson));
      } catch (e) {
        this.logger.warn(`PageSpeed failed for audit ${auditId}: ${(e as Error)?.message}`);
        sections.push(skippedPageSpeed());
      }
    } else {
      sections.push(skippedPageSpeed());
    }

    await this.finish(auditId, job.workspaceId, 'DONE', overallScore(sections), sections, null);
  }

  /**
   * Read a response body but stop at `maxBytes`, cancelling the rest of the
   * stream — so a hostile peer can never make us buffer an unbounded body. Falls
   * back to text().slice for a bodyless/mock response.
   */
  private async readCapped(res: Response, maxBytes: number): Promise<string> {
    const body = (res as unknown as { body?: ReadableStream<Uint8Array> | null }).body;
    if (!body || typeof body.getReader !== 'function') {
      return (await res.text()).slice(0, maxBytes);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = maxBytes - total;
        if (value.byteLength >= remaining) {
          chunks.push(value.subarray(0, remaining));
          total = maxBytes;
          break; // hit the cap — stop reading; never buffer the rest
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  private async finish(
    id: string,
    workspaceId: string,
    status: 'DONE' | 'FAILED',
    score: number | null,
    sections: AuditSection[],
    error: string | null,
  ): Promise<void> {
    await this.prisma.prospectAudit.updateMany({
      where: { id, workspaceId },
      data: {
        status,
        score,
        sections: sections as unknown as object,
        error,
        completedAt: new Date(),
      },
    });
  }
}
