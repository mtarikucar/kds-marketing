import type { StartOut } from '@/api/types';

// The OAuth flow this browser tab started last: which capability it was bound to, if any, so the
// callback page can say what the first chosen account becomes and start a failed flow again for
// the same capability. Only ids and a time, never the state or the code; per tab
// (sessionStorage), and the page works without it.

const KEY = 'jeeta-oauth-flow';

/** How long after its state expires a remembered flow is still trusted: a flow lives 30 minutes. */
const GRACE_MS = 20 * 60_000;

export interface RememberedFlow {
  pending_id: string;
  /** The capability the flow is bound to (`reconnect`); `null` for a new connection. */
  capability_id: string | null;
  /** When the flow's state stops being accepted (`StartOut.expires_at`). */
  expires_at: string;
}

/** Remembers the flow `out` just started, bound to `capabilityId` when given. */
export function rememberStart(out: StartOut, capabilityId: string | null): void {
  rememberFlow({ pending_id: out.pending_id, capability_id: capabilityId, expires_at: out.expires_at });
}

export function rememberFlow(flow: RememberedFlow): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(flow));
  } catch {
    // Not remembered: the callback page then offers a new connection.
  }
}

/** The flow remembered last, unless it is malformed or too old to matter. */
export function rememberedFlow(now: Date = new Date()): RememberedFlow | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RememberedFlow>;
    if (typeof v.pending_id !== 'string' || typeof v.expires_at !== 'string') return null;
    if (v.capability_id !== null && typeof v.capability_id !== 'string') return null;
    const expires = new Date(v.expires_at).getTime();
    if (Number.isNaN(expires) || now.getTime() > expires + GRACE_MS) return null;
    return { pending_id: v.pending_id, capability_id: v.capability_id, expires_at: v.expires_at };
  } catch {
    return null;
  }
}

export function forgetFlow(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}

/** Where to start a flow again: for the same capability when it was bound to one. */
export function restartPath(flow: RememberedFlow | null): string {
  return flow?.capability_id ? `/connect?capability=${encodeURIComponent(flow.capability_id)}` : '/connect';
}
