/**
 * Prospecting-audit feature gate (GHL parity, Epic 13 — inert).
 *
 * A prospect audit fetches a target website + (optionally) Google PageSpeed
 * Insights to produce a branded lead-gen report. PSI needs a free Google API
 * key; the whole feature stays INERT until an operator sets PAGESPEED_API_KEY,
 * so production never makes outbound audit fetches before ops opts in.
 */
export const PAGESPEED_ENDPOINT =
  'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** The audit runner / request path is dormant until the PSI key is configured. */
export function isProspectingConfigured(): boolean {
  return !!process.env.PAGESPEED_API_KEY;
}

export const PROSPECT_AUDIT_SCAN_KIND = 'prospect.audit.scan';
