import { StatusUpdate } from './channel-adapter.interface';

/**
 * Pure mappers for Meta delivery/read receipts → StatusUpdate[] (the NetGSM
 * netgsm-dlr.util analog). Dependency-free so they're trivially unit-tested.
 *
 * WhatsApp Cloud delivers per-message statuses (entry[].changes[].value.statuses[])
 * each carrying the message id + sent|delivered|read|failed, so it gets full
 * DELIVERED/READ/FAILED. Messenger/Instagram deliver entry[].messaging[] with
 * `delivery.mids[]` (per-message → DELIVERED) and `read.watermark` (a timestamp,
 * NOT message ids) — a watermark can't be mapped to a specific externalMessageId
 * without tracking send timestamps, so Messenger/IG yield DELIVERED only (read
 * is intentionally out of scope; documented).
 */

/** Monotonic ranks so an out-of-order webhook never regresses status. */
const RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };
export function rankMetaStatus(status: string): number {
  return RANK[status] ?? 0;
}

/** WhatsApp Cloud value.statuses[] → StatusUpdate[]. */
export function parseWaStatuses(body: unknown): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  for (const entry of (body as any)?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) {
        const id = s?.id;
        if (!id) continue;
        const raw = String(s?.status ?? '').toLowerCase();
        if (raw === 'delivered') {
          out.push({ externalMessageId: String(id), status: 'DELIVERED' });
        } else if (raw === 'read') {
          out.push({ externalMessageId: String(id), status: 'READ' });
        } else if (raw === 'failed') {
          const err = (s?.errors ?? [])[0];
          const reason = err?.title ?? err?.message ?? err?.error_data?.details ?? null;
          out.push({ externalMessageId: String(id), status: 'FAILED', reason: reason ? String(reason) : null });
        }
        // 'sent' is ignored — our Message is already SENT when the receipt arrives.
      }
    }
  }
  return out;
}

/** Messenger / Instagram entry[].messaging[].delivery.mids[] → DELIVERED[]. */
export function parseMessengerStatuses(body: unknown): StatusUpdate[] {
  const out: StatusUpdate[] = [];
  for (const entry of (body as any)?.entry ?? []) {
    for (const ev of entry?.messaging ?? []) {
      for (const mid of ev?.delivery?.mids ?? []) {
        if (mid) out.push({ externalMessageId: String(mid), status: 'DELIVERED' });
      }
    }
  }
  return out;
}
