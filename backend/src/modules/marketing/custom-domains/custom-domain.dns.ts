/**
 * Pure DNS-record construction + verification for custom domains. No I/O — the
 * service does dns.resolveTxt; these functions build the records a tenant must
 * publish and grade what was resolved, so the wire shapes are unit-testable.
 */

export interface DnsInstruction {
  label: string;
  host: string;
  type: 'CNAME' | 'TXT';
  value: string;
}

/** The TXT host where the tenant publishes the ownership token. */
export function verifyTxtHost(hostname: string): string {
  return `_platform-verify.${hostname}`;
}

/** Strip scheme/path/whitespace + lower-case; reject anything that isn't a
 *  plausible hostname (no IPs, no bare TLD). Returns the bare host. */
export function normalizeHostname(raw: string): string | null {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '').replace(/:\d+$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) return null;
  return h;
}

export function buildInstructions(hostname: string, verifyToken: string, cnameTarget: string): DnsInstruction[] {
  return [
    { label: 'CNAME (point your domain at the platform)', host: hostname, type: 'CNAME', value: cnameTarget },
    { label: 'TXT (prove ownership)', host: verifyTxtHost(hostname), type: 'TXT', value: `platform-verify=${verifyToken}` },
  ];
}

/** dns.resolveTxt returns chunked records (string[][]); join each record. */
export function flattenTxt(records: string[][]): string[] {
  return (records ?? []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
}

/** The published TXT must carry our exact ownership token. */
export function txtHasToken(resolved: string[][], verifyToken: string): boolean {
  const want = `platform-verify=${verifyToken}`;
  return flattenTxt(resolved).some((txt) => txt.trim() === want);
}
