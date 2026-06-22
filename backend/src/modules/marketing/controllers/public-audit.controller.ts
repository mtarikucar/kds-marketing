import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuditService } from '../prospecting/audit.service';
import { BrandingService } from '../branding/branding.service';

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

interface Section {
  key?: string;
  label?: string;
  score?: number | null;
  status?: string;
  findings?: string[];
}

const STATUS_COLOR: Record<string, string> = {
  good: '#16a34a',
  warn: '#d97706',
  poor: '#dc2626',
  skipped: '#94a3b8',
};

/**
 * Public prospecting-audit report (no auth — gated by the unguessable token).
 * Trusted first-party HTML; every interpolated value is escaped. Branding
 * (name/accent) comes from the auditing workspace so the report is white-label.
 */
@Controller('public')
export class PublicAuditController {
  constructor(
    private readonly audits: AuditService,
    private readonly branding: BrandingService,
  ) {}

  @Get('audits/:token')
  async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
    let audit: any;
    try {
      audit = await this.audits.publicView(token);
    } catch {
      res.status(404).type('html').send('<h1>Audit not found</h1>');
      return;
    }
    const brand = await this.branding.get(audit.workspaceId).catch(() => null);
    const accent = (brand?.accentColor && /^#[0-9a-fA-F]{6}$/.test(brand.accentColor)) ? brand.accentColor : '#1e40af';
    const brandName = brand?.brandName || 'Website Audit';

    const heading = esc(audit.businessName || audit.targetUrl);
    const done = audit.status === 'DONE';
    const pending = audit.status === 'PENDING' || audit.status === 'RUNNING';
    const sections: Section[] = Array.isArray(audit.sections) ? audit.sections : [];

    const scoreBlock = done
      ? `<div class="score" style="border-color:${esc(accent)}"><span>${esc(audit.score ?? 0)}</span><small>/ 100</small></div>`
      : pending
        ? `<div class="muted">⏳ The audit is still running — refresh in a moment.</div>`
        : `<div class="muted">⚠ ${esc(audit.error || 'This audit could not be completed.')}</div>`;

    const sectionsHtml = sections
      .map((s) => {
        const color = STATUS_COLOR[String(s.status)] ?? '#64748b';
        const scoreTxt = typeof s.score === 'number' ? `${esc(s.score)}/100` : '—';
        const findings = (Array.isArray(s.findings) ? s.findings : [])
          .map((f) => `<li>${esc(f)}</li>`)
          .join('');
        return (
          `<div class="card"><div class="card-h"><strong>${esc(s.label || s.key)}</strong>` +
          `<span class="pill" style="background:${color}">${scoreTxt}</span></div>` +
          (findings ? `<ul>${findings}</ul>` : '') +
          `</div>`
        );
      })
      .join('');

    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${esc(brandName)} — ${heading}</title><style>` +
        `body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#0f172a;background:#f8fafc}` +
        `h1{font-size:1.5rem;margin:0 0 4px}.target{color:#64748b;word-break:break-all;margin-bottom:24px}` +
        `.score{display:inline-flex;align-items:baseline;gap:6px;border:4px solid;border-radius:16px;padding:16px 28px;font-weight:800;margin-bottom:24px}` +
        `.score span{font-size:2.6rem}.score small{font-size:1rem;color:#64748b}` +
        `.muted{color:#64748b;padding:16px 0}` +
        `.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:12px}` +
        `.card-h{display:flex;justify-content:space-between;align-items:center}` +
        `.pill{color:#fff;font-size:.8rem;font-weight:700;padding:3px 10px;border-radius:999px}` +
        `ul{margin:10px 0 0;padding-left:18px;color:#334155}li{margin:4px 0}` +
        `.foot{margin-top:28px;color:#94a3b8;font-size:.85rem;text-align:center}` +
        `</style></head><body>` +
        `<div style="font-weight:800;color:${esc(accent)};margin-bottom:20px">${esc(brandName)}</div>` +
        `<h1>${heading}</h1><div class="target">${esc(audit.targetUrl)}</div>` +
        scoreBlock +
        sectionsHtml +
        `<div class="foot">Website audit prepared by ${esc(brandName)}.</div>` +
        `</body></html>`,
    );
  }
}
