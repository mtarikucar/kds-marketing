import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { AccountCenterResponse, SourceRef } from './types';

export const connectionsKey = ['marketing', 'connections'] as const;

/**
 * The EMAIL-only block `AccountCenterService` attaches to a mailbox source, so
 * the page can offer the RIGHT repair: a dead consent needs the owner to sign
 * in again at the provider, a password mailbox needs the edit dialog, and
 * offering a consent flow this deployment may have no app registration for is
 * a dead end. Mirrors `AccountCenterService.MailboxRef`.
 */
export interface MailboxRef {
  consent: boolean;
  reauthRequired: boolean;
  address: string | null;
}

/**
 * Read it off a source, or null.
 *
 * A function rather than a field on `SourceRef` deliberately: the SPA is
 * deployed separately from the API, so a browser running this build can be
 * talking to a server that predates the field. `null` is the honest answer
 * there, and it renders the page exactly as it rendered before — rather than
 * an Edit button that patches a channel id the response never carried.
 */
export function mailboxOf(source: SourceRef): MailboxRef | null {
  const raw = (source as SourceRef & { mailbox?: unknown }).mailbox;
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Partial<MailboxRef>;
  return {
    consent: m.consent === true,
    reauthRequired: m.reauthRequired === true,
    address: typeof m.address === 'string' ? m.address : null,
  };
}

/**
 * The Account Center read-model — every connected account across the workspace.
 *
 * `GET marketing/connections` is `@MarketingRoles('MANAGER')`, so this must not
 * be fired unconditionally from a surface a REP can open: the request 403s and
 * main.tsx's global QueryCache `onError` turns that into a "Forbidden" toast on
 * every mount. Hence `enabled` — a caller on a mixed-role screen passes its own
 * role check in, exactly the way AccountStatsPanel's sibling `insights` query
 * does. `AccountCenterPage` itself needs no flag: it only ever renders behind
 * `requiredRole={MarketingRole.MANAGER}`.
 *
 * `meta.silent` is unconditional and belongs to the hook rather than to each
 * caller, because BOTH callers own an inline failure state (the page has an
 * isError panel with a retry; the Studio strip simply shows no chips). The
 * global toast would only shout over one of them.
 */
export function useConnections(opts?: { enabled?: boolean }) {
  return useQuery<AccountCenterResponse>({
    queryKey: connectionsKey,
    queryFn: () => marketingApi.get('/connections').then((r) => r.data as AccountCenterResponse),
    enabled: opts?.enabled ?? true,
    meta: { silent: true },
  });
}

export interface DisconnectResult {
  removed: { model: string; capability: string; id: string }[];
  skipped: { model: string; capability: string; id: string; reason: string }[];
}

/** Disconnect a whole identity (or selected capabilities) across every surface. */
export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation<DisconnectResult, unknown, { identityKey: string; capabilities?: string[] }>({
    mutationFn: (vars) =>
      marketingApi
        .delete(`/connections/${encodeURIComponent(vars.identityKey)}`, {
          data: vars.capabilities?.length ? { capabilities: vars.capabilities } : undefined,
        })
        .then((r) => r.data as DisconnectResult),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey });
      qc.invalidateQueries({ queryKey: ['marketing', 'channels'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
    },
  });
}
