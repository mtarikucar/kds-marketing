/**
 * Pure DNS-record construction + verification for sending domains. No I/O — the
 * service does the dns.resolveTxt; these functions build the records a tenant
 * must publish and grade what was actually resolved, so the wire shapes are
 * unit-testable against hand-built fixtures.
 *
 * Two rules govern everything here, because the records live at hosts the
 * tenant's OWN mail already depends on:
 *
 *  1. Never hand out a record that, pasted blind, breaks mail we do not send.
 *     A second `v=spf1` TXT at a host is a permerror for every sender of that
 *     domain; a second `_dmarc` TXT voids the policy outright (RFC 7489 §6.6.3);
 *     a `p=quarantine` we invent applies to the tenant's invoices too, not only
 *     to ours. So SPF ships with a merge instruction, DMARC ships as `p=none`
 *     and only for a host that has nothing yet, and both say so in the record.
 *  2. Never grade a domain "verified" on anything but an answer. A resolver
 *     failure is not the absence of a record, and the two must stay
 *     distinguishable all the way up to the caller (`UNAVAILABLE` vs `MISSING`).
 */

/** Why a record did not pass. Codes, not sentences: the UI localises them. */
export type RecordReason =
  /** Nothing well-formed of this kind is published at the host. */
  | 'MISSING'
  /** More than one record of a kind that must be unique (SPF, DMARC). */
  | 'DUPLICATE'
  /** An SPF record exists but does not include the platform. */
  | 'NO_INCLUDE'
  /** A DKIM record exists at the selector but carries someone else's key. */
  | 'KEY_MISMATCH'
  /** The platform itself has no SPF include to ask for yet (operator gap). */
  | 'NOT_CONFIGURED'
  /** The lookup did not answer (SERVFAIL/timeout) — says nothing either way. */
  | 'UNAVAILABLE';

export interface RecordCheck {
  ok: boolean;
  reason?: RecordReason;
}

/** Why a record needs care before it is pasted. A code the UI localises. */
export type RecordNoteCode = 'SPF_MERGE' | 'DMARC_ONLY_IF_ABSENT';

export interface DnsRecord {
  /** Human label for the settings UI. */
  label: 'DKIM' | 'SPF' | 'DMARC';
  /** The fully-qualified host the tenant creates the record at. */
  host: string;
  type: 'TXT';
  value: string;
  /** English fallback for `noteCode`; the UI prefers its own translation. */
  note?: string;
  noteCode?: RecordNoteCode;
  /** Add ONLY when the host has no record of this kind — a second one is worse
   *  than none. Rendered as a condition, never as a step. */
  onlyIfAbsent?: boolean;
}

/** Strip scheme/path/whitespace and lower-case; reject anything that isn't a
 *  plausible registrable hostname. Returns the bare domain. */
export function normalizeDomain(raw: string): string | null {
  let d = String(raw ?? '').trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  // letters/digits/hyphen labels, at least two labels, valid TLD-ish last label
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) return null;
  return d;
}

export function dkimHost(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`;
}
export function dmarcHost(domain: string): string {
  return `_dmarc.${domain}`;
}

/** The DKIM TXT value publishing our RSA public key (base64 DER, the `p=` tag). */
export function dkimTxtValue(publicKeyB64Der: string): string {
  return `v=DKIM1; k=rsa; p=${publicKeyB64Der}`;
}

/** The SPF value for a host that has NO SPF record yet. A host that already has
 *  one must be edited instead — see `spfMergeNote`. */
export function spfTxtValue(include: string): string {
  return `v=spf1 include:${include} ~all`;
}

export function spfMergeNote(domain: string, include: string): string {
  return (
    `If ${domain} already has a v=spf1 record, do not add a second one — a domain may publish ` +
    `only one. Edit the existing record and insert include:${include} before its final "all" term.`
  );
}

/**
 * Policy-only, `p=none`. We monitor; we do not quarantine somebody else's mail.
 * No `rua`: dmarc@<domain> is a mailbox nobody reads, and pointing it at a
 * platform address would additionally need the RFC 7489 §7.1 authorisation
 * record at `<domain>._report._dmarc.<platform>` — halfway is worse than not at
 * all. The tenant raises the policy themselves once reports look clean.
 */
export function dmarcTxtValue(): string {
  return 'v=DMARC1; p=none';
}

export function dmarcOnlyIfAbsentNote(domain: string): string {
  return (
    `Only add this if _dmarc.${domain} has no TXT record yet. If a DMARC policy already exists, ` +
    `leave it exactly as it is — a second _dmarc record voids the policy for all of your mail. ` +
    `Once your reports look clean you can raise your own policy to p=quarantine and then p=reject.`
  );
}

export function buildRecords(opts: {
  domain: string;
  selector: string;
  publicKeyB64Der: string;
  /** null while the platform has no real SPF include configured — we then ask
   *  for no SPF record at all rather than invent one. */
  spfInclude: string | null;
}): DnsRecord[] {
  const records: DnsRecord[] = [
    {
      label: 'DKIM',
      host: dkimHost(opts.selector, opts.domain),
      type: 'TXT',
      value: dkimTxtValue(opts.publicKeyB64Der),
    },
  ];
  if (opts.spfInclude) {
    records.push({
      label: 'SPF',
      host: opts.domain,
      type: 'TXT',
      value: spfTxtValue(opts.spfInclude),
      noteCode: 'SPF_MERGE',
      note: spfMergeNote(opts.domain, opts.spfInclude),
    });
  }
  records.push({
    label: 'DMARC',
    host: dmarcHost(opts.domain),
    type: 'TXT',
    value: dmarcTxtValue(),
    onlyIfAbsent: true,
    noteCode: 'DMARC_ONLY_IF_ABSENT',
    note: dmarcOnlyIfAbsentNote(opts.domain),
  });
  return records;
}

/** dns.resolveTxt returns chunked records (string[][]); join each record's
 *  chunks (long TXT values are split at 255 chars on the wire). */
export function flattenTxt(records: string[][]): string[] {
  return (records ?? []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
}

/**
 * The published DKIM record must carry our exact public key in its `p=` tag.
 *
 * NO cardinality rule: several TXT at a selector host is legal and normal during
 * key rotation, and only the value matters. The `v=DKIM1` tag is RECOMMENDED
 * rather than required (RFC 6376 §3.6.1), so a record is recognised as a key
 * record by its tags — anchoring on `v=` would report MISSING for a key that is
 * published and working.
 */
export function checkDkim(resolved: string[][], expectedB64Der: string): RecordCheck {
  const want = expectedB64Der.replace(/\s+/g, '');
  const dkim = flattenTxt(resolved)
    .map((txt) => txt.replace(/\s+/g, ''))
    .filter((txt) => /^v=DKIM1\b/i.test(txt) || /(^|;)[kp]=/i.test(txt));
  if (!dkim.length) return { ok: false, reason: 'MISSING' };
  const match = dkim.some((txt) => /p=([A-Za-z0-9+/=]+)/.exec(txt)?.[1] === want);
  return match ? { ok: true } : { ok: false, reason: 'KEY_MISMATCH' };
}

/**
 * Exactly one `v=spf1` record, and it must carry our include. Two records is
 * not "ours is there too" — it is a permerror that breaks the tenant's own
 * mail, so it fails the check loudly rather than passing on a technicality.
 */
export function checkSpf(resolved: string[][], include: string | null): RecordCheck {
  if (!include) return { ok: false, reason: 'NOT_CONFIGURED' };
  const spf = flattenTxt(resolved).map((t) => t.trim()).filter((t) => /^v=spf1\b/i.test(t));
  if (!spf.length) return { ok: false, reason: 'MISSING' };
  if (spf.length > 1) return { ok: false, reason: 'DUPLICATE' };
  return spf[0].toLowerCase().includes(`include:${include.toLowerCase()}`)
    ? { ok: true }
    : { ok: false, reason: 'NO_INCLUDE' };
}

/**
 * Any well-formed policy at `_dmarc` satisfies us — a stricter one the tenant
 * already publishes is not a problem to fix. Anchored on `v=DMARC1` (RFC 7489
 * requires the record to start with it), so an unrelated TXT that merely
 * mentions the string is not mistaken for a policy.
 */
export function checkDmarc(resolved: string[][]): RecordCheck {
  const dmarc = flattenTxt(resolved).map((t) => t.trim()).filter((t) => /^v=DMARC1\b/i.test(t));
  if (!dmarc.length) return { ok: false, reason: 'MISSING' };
  if (dmarc.length > 1) return { ok: false, reason: 'DUPLICATE' };
  return { ok: true };
}

export interface DnsCheck {
  dkim: RecordCheck;
  spf: RecordCheck;
  dmarc: RecordCheck;
}

/** Verified only when all three records are correctly published. */
export function allVerified(c: DnsCheck): boolean {
  return c.dkim.ok && c.spf.ok && c.dmarc.ok;
}

/**
 * Did the resolver actually answer for every host? A check containing an
 * `UNAVAILABLE` says nothing about what is published, so no status may move on
 * it — neither up to VERIFIED nor back down again.
 */
export function isDecisive(c: DnsCheck): boolean {
  return [c.dkim, c.spf, c.dmarc].every((r) => r.reason !== 'UNAVAILABLE');
}

const RECORD_DETAIL: Partial<Record<RecordReason, (label: string) => string>> = {
  DUPLICATE: (label) =>
    label === 'SPF'
      ? 'Two v=spf1 records are published — merge them into one record; a domain may publish only one.'
      : 'Two DMARC records are published — keep one; a second _dmarc record voids the policy.',
  NO_INCLUDE: () => 'An SPF record exists but does not carry our include — add it before the final "all" term.',
  KEY_MISMATCH: () => 'The DKIM record at that selector publishes a different key.',
  NOT_CONFIGURED: () => 'SPF is not configured on this deployment yet — ask your operator.',
  UNAVAILABLE: (label) => `${label} could not be checked right now (DNS did not answer).`,
};

/**
 * A human summary for the FAILED/pending UI and the stored `lastError`.
 * "Not yet found: SPF" is kept only for records that are plainly absent —
 * everything else gets named, because "add the record" is the wrong advice when
 * the record is already there twice.
 */
export function missingSummary(c: DnsCheck): string {
  const entries: Array<[string, RecordCheck]> = [
    ['DKIM', c.dkim],
    ['SPF', c.spf],
    ['DMARC', c.dmarc],
  ];
  const absent = entries.filter(([, r]) => !r.ok && (r.reason ?? 'MISSING') === 'MISSING').map(([l]) => l);
  const detailed = entries
    .filter(([, r]) => !r.ok && r.reason && r.reason !== 'MISSING')
    .map(([label, r]) => RECORD_DETAIL[r.reason as RecordReason]?.(label) ?? `${label}: ${r.reason}`);
  const parts = [absent.length ? `Not yet found: ${absent.join(', ')}` : null, ...detailed].filter(Boolean);
  return parts.length ? (parts as string[]).join(' ') : 'All records verified';
}
