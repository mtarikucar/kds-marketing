import { request } from './client';
import type { AgentConnectionOut } from './types';

/** `GET /api/agents`: first seen first. */
export function listAgents(): Promise<AgentConnectionOut[]> {
  return request('GET', '/api/agents');
}
