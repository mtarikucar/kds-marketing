import { request } from './client';
import type { AgentConnectionOut, WhoAmI } from './types';

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
