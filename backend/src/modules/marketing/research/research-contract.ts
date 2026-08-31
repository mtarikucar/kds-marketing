import { ResearchJob } from './research-job.service';
import { StagedCandidate } from './research-candidate.service';
import { EXTERNAL_REF_PATTERN } from '../dto/ingest-leads.dto';

/**
 * The research CONTRACT — what we ask for, and what we accept back.
 *
 * ## Why this is a module and not two private methods on the worker
 *
 * There are now TWO drainers of the research queue. The in-process
 * `ResearchWorkerService` runs an Anthropic tool-loop on the PLATFORM's key;
 * a workspace in `researchExecution: 'MCP'` instead leaves its jobs queued for
 * the owner's own Claude, which leases them over MCP and pays for the
 * reasoning on its own subscription. That is the entire point — research was
 * 86% of the measured Anthropic bill.
 *
 * The thing that must NOT change with the lane is the RESULT. If each side
 * carried its own copy of the brief, quality would quietly become a function
 * of which lane a workspace happened to be on, and the difference would
 * surface months later as "MCP mode finds worse leads" with nothing to
 * attribute it to. Worse, on the MCP side the instruction would be a sentence
 * the owner typed into a scheduled task at some point and never revisited —
 * so the hard filters, the disqualifiers and the dedup-key convention would
 * depend on their phrasing rather than on the product.
 *
 * So the instruction lives HERE, on the server, and both lanes read it. The
 * MCP lane hands the whole thing to the caller in `claim_research_job`; the
 * owner's Claude is a pair of hands, not the author of the brief.
 *
 * The validator is here for the mirror-image reason: `submit_research_candidates`
 * accepts a list assembled by a model we do not control, and the review queue
 * ranks on `priority`/`score`. One validator means an MCP-lane candidate
 * cannot enter staging in a shape the server lane would have rejected.
 */

const STAGES = new Set(['GROWING', 'STRUGGLING', 'STABLE']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

/** The most candidates any single brief should be asked for in one run. */
const TARGET_VOLUME_CEILING = 20;

/**
 * Headroom over today's remaining lead quota. Accepting is quota-clipped, and
 * a clipped candidate stays PENDING for tomorrow rather than being lost — so
 * staging slightly more than can be accepted today is deliberate, not slack.
 */
const CAP_HEADROOM = 10;

export const RESEARCH_SYSTEM_PROMPT =
  'You are a B2B prospect-research agent inside a multi-tenant lead-generation platform. ' +
  'Research the given ICP with the tools and return ONLY qualified, evidence-backed lead candidates. ' +
  'Qualify on EVIDENCE (concrete pain in recent negative reviews, growth/hiring signals, operational gaps the product solves) — never on vibes. ' +
  'HARD DISQUALIFIERS: business closed/inactive; clearly outside the ICP size; no reachable contact (need phone, instagram, email or website); no verifiable evidence; anything matching the profile exclusions or outside its geo/businessTypes. ' +
  'externalRef is the cross-day dedup key — use the first applicable of phone:+<E164>, instagram:@handle, google:<placeId>, domain:<apex>, hash:<sha1(lowercase(businessName|city))>; never randomize it. ' +
  'Write painPoint/evidence/pitch in the profile language. Padding weak leads is worse than returning few. ' +
  'When done, call submit_candidates exactly once with your final list.';

/** How many strong candidates to ASK for — bounded by what can be accepted. */
export function researchTargetVolume(job: ResearchJob): number {
  return job.remainingToday === -1
    ? job.maxBatchSize
    : Math.min(job.remainingToday, TARGET_VOLUME_CEILING);
}

/**
 * How many submitted candidates are actually KEPT — a cost guard, bounded
 * relative to what can be accepted rather than to what the model felt like
 * returning.
 */
export function researchBatchCap(job: ResearchJob): number {
  return job.remainingToday === -1
    ? job.maxBatchSize
    : Math.min(job.remainingToday + CAP_HEADROOM, job.maxBatchSize);
}

/** The per-run brief: product, brand, ICP and every hard filter. */
export function buildResearchBrief(job: ResearchJob, brand: string | null): string {
  const p = job.profile;
  const geo = p.geo as { country?: string; regions?: string[]; cities?: string[] } | null;
  const bt = Array.isArray(p.businessTypes) ? (p.businessTypes as string[]).join(', ') : '';
  return [
    `PRODUCT: ${job.productName ?? ''}${job.productUrl ? ` (${job.productUrl})` : ''}`,
    brand ? `BRAND CONTEXT: ${brand}` : '',
    job.productDescription ? `WHAT IT DOES: ${job.productDescription}` : '',
    `ICP (who to find + what pain): ${p.icpDescription}`,
    p.productPitch ? `PITCH ANGLE: ${p.productPitch}` : '',
    geo ? `GEO (hard filter): ${JSON.stringify(geo)}` : '',
    bt ? `BUSINESS TYPES (hard filter): ${bt}` : '',
    p.exclusions ? `EXCLUSIONS (hard filter): ${p.exclusions}` : '',
    `LANGUAGE for painPoint/evidence/pitch: ${p.language}`,
    `TARGET VOLUME: up to ${researchTargetVolume(job)} strong candidates. Fewer is fine.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Keep only well-formed candidates (the ingest DTO re-validates on accept). */
export function validateResearchCandidates(raw: unknown[]): StagedCandidate[] {
  const out: StagedCandidate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const c = r as Record<string, unknown>;
    const externalRef = String(c.externalRef ?? '').trim();
    const businessName = String(c.businessName ?? '').trim();
    const businessType =
      String(c.businessType ?? 'OTHER').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'OTHER';
    const painPoint = String(c.painPoint ?? '').trim();
    const evidence = String(c.evidence ?? '').trim();
    const pitch = String(c.pitch ?? '').trim();
    if (!EXTERNAL_REF_PATTERN.test(externalRef) || !businessName || !painPoint || !evidence || !pitch) continue;
    const stage = typeof c.stage === 'string' && STAGES.has(c.stage) ? c.stage : undefined;
    const priority = typeof c.priority === 'string' && PRIORITIES.has(c.priority) ? c.priority : 'MEDIUM';
    out.push({
      externalRef,
      businessName,
      businessType,
      painPoint: painPoint.slice(0, 1000),
      evidence: evidence.slice(0, 500),
      pitch: pitch.slice(0, 500),
      city: str(c.city),
      region: str(c.region),
      // The externalRef IS a contact detail in three of its five forms, and
      // the model routinely fills it while leaving the matching field empty:
      // 33 of 301 leads carrying a `phone:` ref had a null phone, so a number
      // the researcher had already found and paid for was unreachable.
      // Recover it rather than re-researching it.
      phone: str(c.phone) ?? refContact(externalRef, 'phone'),
      instagram: str(c.instagram) ?? refContact(externalRef, 'instagram'),
      website: str(c.website) ?? refContact(externalRef, 'domain'),
      email: str(c.email),
      currentSystem: str(c.currentSystem),
      branchCount: Number.isFinite(Number(c.branchCount)) ? Number(c.branchCount) : undefined,
      stage,
      priority,
      score: clampScore(c.score),
    });
  }
  return out;
}

/**
 * The schema asks for 0-100, but the model is the only thing enforcing it and
 * runs have come back on 0-1 and 0-10 scales. Storing those verbatim made the
 * review queue rank candidates against incomparable numbers. Out-of-range is
 * dropped rather than rescaled: guessing which scale was meant would invent a
 * ranking, and `priority` — which IS constrained — carries the real signal.
 */
function clampScore(raw: unknown): number | undefined {
  // Number(null) is 0 and Number('') is 0 — the old check let a candidate the
  // model declined to score be stored as a hard "does not fit at all".
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 100) return undefined;
  return n;
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

/**
 * Pull a contact detail back out of the externalRef.
 *
 * The ref is a dedup key, but three of its five forms — `phone:`, `instagram:`,
 * `domain:` — are literally the contact itself, already validated by
 * EXTERNAL_REF_PATTERN. The model fills the ref reliably (it is required) and
 * the matching field only sometimes, so a number it had already found could
 * land in the key and nowhere else. Used only as a FALLBACK: an explicit field
 * always wins.
 *
 * `google:` and `hash:` carry no contact and yield nothing.
 */
function refContact(externalRef: string, kind: 'phone' | 'instagram' | 'domain'): string | undefined {
  const prefix = `${kind}:`;
  if (!externalRef.startsWith(prefix)) return undefined;
  const value = externalRef.slice(prefix.length).trim();
  if (!value) return undefined;
  // A domain ref is a bare apex; make it usable as the website it stands for.
  return kind === 'domain' ? `https://${value}` : value;
}
