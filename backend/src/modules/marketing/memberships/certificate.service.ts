import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';

interface CertTemplate {
  title?: string;
  signature?: string;
  logoUrl?: string;
}

/** HTML-escape every interpolated value — the certificate is rendered to a public page. */
function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Allow only http(s) image URLs for the logo (no javascript:/data: injection). */
function safeUrl(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/**
 * Epic 10b — course-completion certificates. Issued once per enrollment when it
 * reaches 100% (idempotent via the unique enrollmentId). The certificate is
 * rendered to printable HTML on demand at the public verify page (no file
 * storage / no headless-browser PDF dependency — consistent with the rest of the
 * public-HTML surfaces here; the browser's print-to-PDF produces the PDF).
 */
@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private template(course: { certificateTemplate: Prisma.JsonValue | null }): CertTemplate {
    const t = course.certificateTemplate;
    return t && typeof t === 'object' && !Array.isArray(t) ? (t as CertTemplate) : {};
  }

  /**
   * Issue a certificate for a completed enrollment if the course has them
   * enabled. Idempotent: a second call (or a re-completion) returns the existing
   * row rather than minting a duplicate. Best-effort emit of the
   * `certificate.issued` workflow trigger.
   */
  async issueForEnrollment(enrollment: {
    id: string;
    workspaceId: string;
    courseId: string;
    leadId: string;
  }): Promise<{ id: string; serial: string } | null> {
    const course = await this.prisma.course.findFirst({
      where: { id: enrollment.courseId, workspaceId: enrollment.workspaceId },
      select: { id: true, certificateEnabled: true },
    });
    if (!course?.certificateEnabled) return null;

    // Idempotent on the STABLE identity (course, lead) — not the enrollment row,
    // which an unenroll + re-enroll would change, otherwise minting a duplicate
    // credential for the same completion. workspaceId is inlined at each call (the
    // scoping fitness test requires an inline literal, not a hoisted `where`).
    const existing = await this.prisma.certificate.findFirst({
      where: { workspaceId: enrollment.workspaceId, courseId: enrollment.courseId, leadId: enrollment.leadId },
      select: { id: true, serial: true },
    });
    if (existing) return existing;

    const serial = `CERT-${randomBytes(8).toString('hex').toUpperCase()}`;
    let cert: { id: string; serial: string };
    try {
      cert = await this.prisma.certificate.create({
        data: {
          workspaceId: enrollment.workspaceId,
          courseId: enrollment.courseId,
          leadId: enrollment.leadId,
          enrollmentId: enrollment.id,
          serial,
        },
        select: { id: true, serial: true },
      });
    } catch (e) {
      // Lost a race on the (workspace, course, lead) unique — return the winner.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.certificate.findFirst({
          where: { workspaceId: enrollment.workspaceId, courseId: enrollment.courseId, leadId: enrollment.leadId },
          select: { id: true, serial: true },
        });
        if (winner) return winner;
      }
      throw e;
    }

    // Best-effort workflow trigger — losing the emit must not undo issuance.
    try {
      await this.outbox.append({
        type: MarketingEventTypes.CertificateIssued,
        idempotencyKey: `certificate-issued:${cert.id}`,
        payload: {
          workspaceId: enrollment.workspaceId,
          courseId: enrollment.courseId,
          leadId: enrollment.leadId,
          enrollmentId: enrollment.id,
          certificateId: cert.id,
          serial: cert.serial,
          occurredAt: new Date().toISOString(),
        },
      });
    } catch (e: any) {
      this.logger.warn(`certificate.issued emit failed for ${cert.id}: ${e?.message ?? e}`);
    }
    return cert;
  }

  /**
   * Manager view: the certificate for an enrollment (workspace-scoped), or null.
   * Resolved by the enrollment's (course, lead) so it survives an unenroll +
   * re-enroll (the cert is keyed on that stable identity, not the enrollment id).
   * Lazy self-heal: a COMPLETED enrollment with no cert (a transient issuance
   * miss at the 100% crossing, or a course enabled after completion) issues on
   * read — issueForEnrollment is idempotent and re-checks certificateEnabled.
   */
  async getForEnrollment(workspaceId: string, enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: { id: enrollmentId, workspaceId },
      select: { id: true, workspaceId: true, courseId: true, leadId: true, status: true },
    });
    if (!enrollment) return null;
    const existing = await this.prisma.certificate.findFirst({
      where: { workspaceId, courseId: enrollment.courseId, leadId: enrollment.leadId },
    });
    if (existing) return existing;
    if (enrollment.status === 'COMPLETED') {
      const issued = await this.issueForEnrollment(enrollment).catch(() => null);
      if (issued) {
        return this.prisma.certificate.findFirst({
          where: { workspaceId, courseId: enrollment.courseId, leadId: enrollment.leadId },
        });
      }
    }
    return null;
  }

  /**
   * Issue certificates for every already-COMPLETED enrollment of a course —
   * called when an operator turns certificates on for a course that already has
   * graduates (issuance is otherwise only triggered on a live 100% crossing).
   * Idempotent per (course, lead); bounded to guard a huge cohort.
   */
  async backfillForCourse(workspaceId: string, courseId: string): Promise<number> {
    const completed = await this.prisma.enrollment.findMany({
      where: { workspaceId, courseId, status: 'COMPLETED' },
      select: { id: true, workspaceId: true, courseId: true, leadId: true },
      take: 5000,
    });
    let issued = 0;
    for (const e of completed) {
      try {
        if (await this.issueForEnrollment(e)) issued++;
      } catch (err: any) {
        this.logger.warn(`certificate backfill failed for enrollment ${e.id}: ${err?.message ?? err}`);
      }
    }
    return issued;
  }

  /** Public verify by serial → the printable certificate HTML (or null if unknown). */
  async renderBySerial(serial: string): Promise<string | null> {
    const cert = await this.prisma.certificate.findUnique({
      where: { serial },
      include: { course: { select: { title: true, certificateTemplate: true } } },
    });
    if (!cert) return null;
    const lead = await this.prisma.lead.findFirst({
      where: { id: cert.leadId, workspaceId: cert.workspaceId },
      select: { contactPerson: true, businessName: true },
    });
    const recipient = lead?.contactPerson || lead?.businessName || 'Member';
    return this.renderHtml({
      recipient,
      courseTitle: cert.course.title,
      serial: cert.serial,
      issuedAt: cert.issuedAt,
      template: this.template(cert.course),
    });
  }

  private renderHtml(d: {
    recipient: string;
    courseTitle: string;
    serial: string;
    issuedAt: Date;
    template: CertTemplate;
  }): string {
    const title = d.template.title || 'Certificate of Completion';
    const signature = d.template.signature || '';
    const logo = safeUrl(d.template.logoUrl);
    const issued = d.issuedAt.toISOString().slice(0, 10);
    return (
      `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
      `<style>` +
      `*{box-sizing:border-box}body{font-family:Georgia,'Times New Roman',serif;color:#1e293b;margin:0;background:#f1f5f9}` +
      `.cert{max-width:820px;margin:32px auto;background:#fff;border:10px double #c7a44a;border-radius:6px;padding:56px 48px;text-align:center}` +
      `.logo{max-height:72px;margin-bottom:18px}` +
      `h1{font-size:2.1rem;letter-spacing:.06em;margin:.2em 0;color:#0f172a;text-transform:uppercase}` +
      `.sub{color:#64748b;font-size:1rem;margin-bottom:28px}` +
      `.name{font-size:1.9rem;margin:18px 0;border-bottom:2px solid #c7a44a;display:inline-block;padding:0 24px 6px}` +
      `.course{font-size:1.25rem;margin:14px 0 28px;font-style:italic}` +
      `.foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:48px;font-size:.85rem;color:#475569;gap:24px}` +
      `.sig{border-top:1px solid #94a3b8;padding-top:6px;min-width:180px}` +
      `.serial{font-family:ui-monospace,monospace;font-size:.75rem;color:#94a3b8;margin-top:24px}` +
      `@media print{body{background:#fff}.cert{border-color:#c7a44a;margin:0}.noprint{display:none}}` +
      `button{margin:16px 8px 0;padding:10px 20px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-family:system-ui}` +
      `</style></head><body>` +
      `<div class="cert">` +
      (logo ? `<img class="logo" src="${esc(logo)}" alt="">` : '') +
      `<h1>${esc(title)}</h1>` +
      `<div class="sub">This is to certify that</div>` +
      `<div class="name">${esc(d.recipient)}</div>` +
      `<div class="sub">has successfully completed</div>` +
      `<div class="course">${esc(d.courseTitle)}</div>` +
      `<div class="foot"><div class="sig">Issued ${esc(issued)}</div>` +
      `<div class="sig">${esc(signature) || '&nbsp;'}</div></div>` +
      `<div class="serial">Verify: ${esc(d.serial)}</div>` +
      `</div>` +
      `<div class="noprint" style="text-align:center"><button onclick="window.print()">Print / Save as PDF</button></div>` +
      `</body></html>`
    );
  }
}
