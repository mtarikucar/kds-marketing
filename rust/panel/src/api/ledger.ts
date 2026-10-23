import { request } from './client';
import type { ActorKind, LedgerEntryOut } from './types';

/** The server's default page size, asked for explicitly so "is there more?" is decidable. */
export const LEDGER_PAGE_SIZE = 50;

export interface LedgerQuery {
  action_prefix?: string;
  actor_kind?: ActorKind;
  limit?: number;
  /** The last id of the previous page. */
  before_id?: number;
}

/** `GET /api/ledger`: newest first, payloads redacted. */
export function listLedger(query: LedgerQuery = {}): Promise<LedgerEntryOut[]> {
  return request('GET', '/api/ledger', {
    query: {
      action_prefix: query.action_prefix,
      actor_kind: query.actor_kind,
      limit: query.limit ?? LEDGER_PAGE_SIZE,
      before_id: query.before_id,
    },
  });
}
