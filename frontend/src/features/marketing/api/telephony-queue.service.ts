/**
 * telephony-queue.service.ts — typed API calls for the queue wallboard +
 * agent presence toggle (NetGSM Phase 4 Task 4). Both routes 503 server-side
 * until the workspace has an ACTIVE Netsantral config (TelephonyConfigService
 * resolves it); the wallboard widget treats that the same as any load error.
 */

import marketingApi from './marketingApi';

export type QueueAgentState = 'available' | 'paused' | 'oncall' | 'offline' | 'unknown';

export interface QueueAgentStat {
  /** The agent's Netsantral extension (MarketingUser.dahili). */
  dahili: string;
  state: QueueAgentState;
}

export interface QueueStat {
  /** `{santral}-queue-{name}` per NetGSM's naming convention. */
  queue: string;
  waiting: number;
  /** Seconds, or null when NetGSM didn't report a hold time for this queue. */
  holdtimeSec: number | null;
  agents: QueueAgentStat[];
}

export interface QueueStatsResponse {
  queues: QueueStat[];
}

/** GET /marketing/telephony/queues/stats */
export const getQueueStats = (): Promise<QueueStatsResponse> =>
  marketingApi.get('/telephony/queues/stats').then((r) => r.data as QueueStatsResponse);

export type AgentPresenceState = 'available' | 'break';

export interface AgentPresencePayload {
  state: AgentPresenceState;
  /** Only meaningful for state:'break'. */
  reason?: string;
}

export interface AgentPresenceResult {
  ok: true;
  state: AgentPresenceState;
}

/**
 * POST /marketing/telephony/agent/presence — acts on the CURRENT rep's own
 * dahili (server-resolved from the auth token, never a param this call sends).
 * 400s when the rep has no extension set yet.
 */
export const setAgentPresence = (payload: AgentPresencePayload): Promise<AgentPresenceResult> =>
  marketingApi.post('/telephony/agent/presence', payload).then((r) => r.data as AgentPresenceResult);
