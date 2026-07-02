/**
 * Pure audit scoring — no I/O, no Nest, no Prisma. Each check turns a raw input
 * (fetched HTML, a PageSpeed Insights JSON body) into a scored AuditSection so
 * the shapes can be unit-tested against hand-built fixtures. Kept side-effect
 * free on purpose: the service does the (SSRF-guarded) fetching, this file only
 * grades.
 */

export type SectionStatus = 'good' | 'warn' | 'poor' | 'skipped';

export interface AuditSection {
  key: string;
  label: string;
  /** 0–100, or null when the section could not be evaluated (e.g. PSI off). */
  score: number | null;
  status: SectionStatus;
  findings: string[];
}

/** Cap parsed HTML so a hostile/huge page can't blow the regex/heap. */
export const MAX_HTML_BYTES = 512 * 1024;

function band(score: number): Exclude<SectionStatus, 'skipped'> {
  if (score >= 80) return 'good';
  if (score >= 50) return 'warn';
  return 'poor';
}

function firstMatch(html: string, re: RegExp): string {
  const m = re.exec(html);
  return (m?.[1] ?? '').trim();
}

/**
 * Extract a `<meta>` tag's `content` by its `name`, tolerant of attribute ORDER.
 * HTML lets attributes appear in any order, so `<meta content="…" name="…">` is
 * just as valid as the name-first form. A fixed name-then-content regex
 * false-negatives the content-first variant — reporting a PRESENT tag as
 * "missing" in the audit a prospect sees. Scans each meta tag and reads its
 * `name`/`content` independently. Returns '' when no such tag exists.
 */
function metaContentByName(html: string, name: string): string {
  const wanted = name.toLowerCase();
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const nameAttr = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim().toLowerCase();
    if (nameAttr !== wanted) continue;
    return (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').trim();
  }
  return '';
}

/**
 * On-page checks from the raw HTML: title, meta description, viewport (mobile),
 * a single H1, and whether the resolved URL is HTTPS. All free (no API key).
 */
export function analyzeOnPage(html: string, finalUrl: string): AuditSection {
  const findings: string[] = [];
  let points = 0;
  let max = 0;

  // Title (ideal 10–65 chars).
  max += 30;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title.length >= 10 && title.length <= 65) {
    points += 30;
    findings.push(`Title tag present and well-sized (${title.length} chars).`);
  } else if (title.length > 0) {
    points += 15;
    findings.push(`Title tag is ${title.length} chars — outside the ideal 10–65.`);
  } else {
    findings.push('Missing a <title> tag — hurts search ranking and click-through.');
  }

  // Meta description.
  max += 20;
  const desc = metaContentByName(html, 'description');
  if (desc.length >= 50 && desc.length <= 160) {
    points += 20;
    findings.push(`Meta description present (${desc.length} chars).`);
  } else if (desc.length > 0) {
    points += 10;
    findings.push(`Meta description is ${desc.length} chars — aim for 50–160.`);
  } else {
    findings.push('Missing a meta description — search engines guess the snippet.');
  }

  // Mobile viewport.
  max += 25;
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) {
    points += 25;
    findings.push('Mobile viewport meta tag present.');
  } else {
    findings.push('No viewport meta tag — the site likely is not mobile-friendly.');
  }

  // Exactly one H1.
  max += 10;
  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  if (h1Count === 1) {
    points += 10;
    findings.push('Exactly one H1 heading.');
  } else if (h1Count === 0) {
    findings.push('No H1 heading found.');
  } else {
    points += 5;
    findings.push(`${h1Count} H1 headings — a single primary H1 is best.`);
  }

  // HTTPS.
  max += 15;
  if (/^https:/i.test(finalUrl)) {
    points += 15;
    findings.push('Served over HTTPS.');
  } else {
    findings.push('Not served over HTTPS — visitors see an insecure-site warning.');
  }

  const score = Math.round((points / max) * 100);
  return { key: 'onpage', label: 'On-page SEO', score, status: band(score), findings };
}

/**
 * Grade the Google PageSpeed Insights v5 response. Lighthouse category scores
 * are 0–1 floats (or null when Lighthouse couldn't compute one).
 */
export function analyzePageSpeed(psi: unknown): AuditSection[] {
  const cats =
    (psi as { lighthouseResult?: { categories?: Record<string, { score?: number | null }> } })
      ?.lighthouseResult?.categories ?? {};
  const pct = (v: number | null | undefined): number | null =>
    typeof v === 'number' ? Math.round(v * 100) : null;

  const make = (key: string, label: string, raw: number | null | undefined): AuditSection => {
    const score = pct(raw);
    return {
      key,
      label,
      score,
      status: score === null ? 'skipped' : band(score),
      findings:
        score === null
          ? [`PageSpeed did not return a ${label.toLowerCase()} score.`]
          : [`PageSpeed ${label.toLowerCase()} score: ${score}/100.`],
    };
  };

  return [
    make('performance', 'Performance', cats.performance?.score),
    make('seo', 'Technical SEO', cats.seo?.score),
    make('accessibility', 'Accessibility', cats.accessibility?.score),
    make('best-practices', 'Best practices', cats['best-practices']?.score),
  ];
}

/** A section returned when PSI is disabled, so the report still lists the gap. */
export function skippedPageSpeed(): AuditSection {
  return {
    key: 'performance',
    label: 'Performance',
    score: null,
    status: 'skipped',
    findings: ['PageSpeed Insights is not enabled — performance grade unavailable.'],
  };
}

/** Overall 0–100 = mean of the sections that actually produced a number. */
export function overallScore(sections: AuditSection[]): number {
  const scored = sections.filter((s): s is AuditSection & { score: number } => typeof s.score === 'number');
  if (scored.length === 0) return 0;
  return Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length);
}
