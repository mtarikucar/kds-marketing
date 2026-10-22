import { request } from './client';
import type { AgentState, PendingOut } from './types';

/** `GET /api/work/pending`: the strategy's state, the items to act on and the agent check-in. */
export function getPending(): Promise<PendingOut> {
  return request('GET', '/api/work/pending');
}

/** `PUT /api/work/checkin-interval`: minutes, 15 to 10 080; answers the check-in state. */
export function setCheckinInterval(minutes: number): Promise<AgentState> {
  return request('PUT', '/api/work/checkin-interval', { body: { minutes } });
}
