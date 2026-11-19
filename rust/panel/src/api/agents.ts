import { request, seg } from './client';
import type { AgentConnectionOut, SetWakeIn, WakesOut, WhoAmI } from './types';

/** `GET /api/agents`: first seen first. */
export function listAgents(): Promise<AgentConnectionOut[]> {
  return request('GET', '/api/agents');
}

/**
 * `GET /api/whoami` (`agents.whoami`): the signed-in user in the current workspace, the same
 * answer an agent gets from `jeeta.agent.whoami` with the human as the actor.
 */
export function whoami(): Promise<WhoAmI> {
  return request('GET', '/api/whoami');
}

/** `GET /api/agents/wakes` (`agents.wakes`): every agent's wake state and, per kind of work, what it can expect. */
export function getWakes(): Promise<WakesOut> {
  return request('GET', '/api/agents/wakes');
}

/**
 * `PUT /api/agents/{api_key_id}/wake` (`agents.wake_set`, `team.manage`): the agent's wake address.
 * The token and the secret go here once and no read ever answers them back.
 */
export function setWake(apiKeyId: string, body: SetWakeIn): Promise<WakesOut> {
  return request('PUT', `/api/agents/${seg(apiKeyId)}/wake`, { body });
}

/** `DELETE /api/agents/{api_key_id}/wake` (`agents.wake_remove`, `team.manage`). */
export function removeWake(apiKeyId: string): Promise<WakesOut> {
  return request('DELETE', `/api/agents/${seg(apiKeyId)}/wake`);
}

/**
 * `POST /api/agents/{api_key_id}/wake/run` (`agents.wake_now`): "run now". The wake then waits
 * to go out, due now; the server sends it within seconds. `CONFLICT` with `details.reason`
 * `rate_limited` (and `details.retry_at`), `no_wake_address` or `wake_refused`.
 */
export function wakeNow(apiKeyId: string): Promise<WakesOut> {
  return request('POST', `/api/agents/${seg(apiKeyId)}/wake/run`);
}
