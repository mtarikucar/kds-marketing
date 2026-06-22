/**
 * Pure DNS-record construction + verification for sending domains. No I/O — the
 * service does the dns.resolveTxt; these functions build the records a tenant
 * must publish and grade what was actually resolved, so the wire shapes are
 * unit-testable against hand-built fixtures.
 */

export interface DnsRecord {
  /** Human label for the settings UI. */
  label: string;
  /** The fully-qualified host the tenant creates the record at. */
  host: string;
  type: 'TXT';
  value: string;
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
export function spfTxtValue(include: string): string {
  return `v=spf1 include:${include} ~all`;
}
export function dmarcTxtValue(domain: string): string {
  return `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; fo=1`;
}

export function buildRecords(opts: {
  domain: string;
  selector: string;
  publicKeyB64Der: string;
  spfInclude: string;
}): DnsRecord[] {
  return [
    { label: 'DKIM', host: dkimHost(opts.selector, opts.domain), type: 'TXT', value: dkimTxtValue(opts.publicKeyB64Der) },
    { label: 'SPF', host: opts.domain, type: 'TXT', value: spfTxtValue(opts.spfInclude) },
    { label: 'DMARC', host: dmarcHost(opts.domain), type: 'TXT', value: dmarcTxtValue(opts.domain) },
  ];
}

/** dns.resolveTxt returns chunked records (string[][]); join each record's
 *  chunks (long TXT values are split at 255 chars on the wire). */
export function flattenTxt(records: string[][]): string[] {
  return (records ?? []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
}

/** The published DKIM record must carry our exact public key in its `p=` tag. */
export function dkimMatches(resolved: string[][], expectedB64Der: string): boolean {
  const want = expectedB64Der.replace(/\s+/g, '');
  return flattenTxt(resolved).some((txt) => {
    if (!/v=DKIM1/i.test(txt)) return false;
    const p = /p=([A-Za-z0-9+/=]+)/.exec(txt.replace(/\s+/g, ''))?.[1];
    return !!p && p === want;
  });
}

export function spfMatches(resolved: string[][], include: string): boolean {
  return flattenTxt(resolved).some((txt) => /^v=spf1/i.test(txt.trim()) && txt.includes(`include:${include}`));
}

export function dmarcMatches(resolved: string[][]): boolean {
  return flattenTxt(resolved).some((txt) => /v=DMARC1/i.test(txt));
}

export interface DnsCheck {
  dkim: boolean;
  spf: boolean;
  dmarc: boolean;
}

/** Verified only when all three records are correctly published. */
export function allVerified(c: DnsCheck): boolean {
  return c.dkim && c.spf && c.dmarc;
}

/** A human summary of which records are still missing, for the FAILED/pending UI. */
export function missingSummary(c: DnsCheck): string {
  const missing = [!c.dkim && 'DKIM', !c.spf && 'SPF', !c.dmarc && 'DMARC'].filter(Boolean);
  return missing.length ? `Not yet found: ${missing.join(', ')}` : 'All records verified';
}
