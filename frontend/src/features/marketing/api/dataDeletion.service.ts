/**
 * Public data-deletion status lookup (no auth — the person following the link
 * Meta gave them has no session with us).
 *
 * `null` means "we have no record of that code" and is a legitimate ANSWER, not
 * an error: the status page renders it as "no record", which is the honest
 * thing to show. Anything else that goes wrong throws, so the page can say the
 * status could not be checked rather than implying nothing was found.
 */

export interface DeletionStatus {
  confirmationCode: string;
  /** RECEIVED | COMPLETED | UNMATCHED | FAILED */
  status: string;
  receivedAt: string;
  completedAt: string | null;
}

const publicBase = (): string => {
  // API_URL points at the API origin; strip a trailing /marketing if present so
  // the public /api/public path resolves against the same origin.
  const base = (import.meta as any).env?.VITE_API_URL || window.location.origin;
  return String(base).replace(/\/marketing\/?$/, '');
};

export async function fetchDeletionStatus(code: string): Promise<DeletionStatus | null> {
  const url = `${publicBase()}/api/public/compliance/data-deletion/status?code=${encodeURIComponent(code)}`;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status lookup failed (${res.status})`);
  return (await res.json()) as DeletionStatus;
}
