import { request, seg } from './client';
import type {
  CapabilityOut,
  DeclareInput,
  Evidence,
  GroupDeletedOut,
  GroupOut,
  KindGroup,
  Policy,
  StoredStatus,
  UpdateCapabilityInput,
  UpdatedCapability,
} from './types';

/** Which capabilities to list; every field that is set must match. */
export interface CapabilityQuery {
  group?: KindGroup;
  kind?: string;
  status?: StoredStatus;
  group_id?: string;
}

/**
 * `GET /api/capabilities`: oldest first. The server refuses any parameter it does not know
 * (`422`), so only the four known ones are ever sent.
 */
export function listCapabilities(query: CapabilityQuery = {}): Promise<CapabilityOut[]> {
  return request('GET', '/api/capabilities', {
    query: {
      group: query.group,
      kind: query.kind,
      status: query.status,
      group_id: query.group_id,
    },
  });
}

/** `GET /api/capabilities/{id}`. */
export function getCapability(id: string): Promise<CapabilityOut> {
  return request('GET', `/api/capabilities/${seg(id)}`);
}

/** `POST /api/capabilities` (`201`). Unknown fields are refused, so only known ones are sent. */
export function declareCapability(input: DeclareInput): Promise<CapabilityOut> {
  const body: Record<string, unknown> = { kind_key: input.kind_key, name: input.name };
  if (input.key_detail !== undefined) body.key_detail = input.key_detail;
  if (input.description !== undefined) body.description = input.description;
  if (input.external_id !== undefined) body.external_id = input.external_id;
  if (input.connector_public !== undefined) body.connector_public = input.connector_public;
  if (input.policy !== undefined) body.policy = input.policy;
  return request('POST', '/api/capabilities', { body });
}

/**
 * `PATCH /api/capabilities/{id}`: only the fields given are sent (the server refuses any other,
 * and an edit naming none). A connector's new account resets its verification
 * (`verification_reset`).
 */
export function updateCapability(id: string, input: UpdateCapabilityInput): Promise<UpdatedCapability> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.description !== undefined) body.description = input.description;
  if (input.external_id !== undefined) body.external_id = input.external_id;
  return request('PATCH', `/api/capabilities/${seg(id)}`, { body });
}

/** `POST /api/capabilities/{id}/verify`: the agent's (or a person's) evidence, recorded as given. */
export function verifyCapability(id: string, evidence: Evidence): Promise<CapabilityOut> {
  return request('POST', `/api/capabilities/${seg(id)}/verify`, {
    body: { evidence: { text: evidence.text, refs: evidence.refs } },
  });
}

/** `POST /api/capabilities/{id}/unreachable`. */
export function markUnreachable(id: string, reason: string): Promise<CapabilityOut> {
  return request('POST', `/api/capabilities/${seg(id)}/unreachable`, { body: { reason } });
}

/** `PUT /api/capabilities/{id}/policy`: the whole policy, read strictly. */
export function setPolicy(id: string, policy: Policy): Promise<CapabilityOut> {
  return request('PUT', `/api/capabilities/${seg(id)}/policy`, {
    body: {
      active_hours: policy.active_hours,
      daily_ops_cap: policy.daily_ops_cap,
      spend_cap_minor: policy.spend_cap_minor,
      requires_human_approval: policy.requires_human_approval,
      verify_max_age_days: policy.verify_max_age_days,
    },
  });
}

/** `POST /api/capabilities/{id}/retire`: final; detaches it from its groups and budget items. */
export function retireCapability(id: string): Promise<CapabilityOut> {
  return request('POST', `/api/capabilities/${seg(id)}/retire`, { body: { confirm: true } });
}

/** `POST /api/capabilities/{id}/budget-links`. */
export function linkBudget(id: string, budgetItemId: string): Promise<CapabilityOut> {
  return request('POST', `/api/capabilities/${seg(id)}/budget-links`, {
    body: { budget_item_id: budgetItemId },
  });
}

/** `DELETE /api/capabilities/{id}/budget-links/{item}`: answers the capability (`200`). */
export function unlinkBudget(id: string, budgetItemId: string): Promise<CapabilityOut> {
  return request('DELETE', `/api/capabilities/${seg(id)}/budget-links/${seg(budgetItemId)}`);
}

/** `GET /api/capability-groups`: every group with its members, oldest first. */
export function listGroups(): Promise<GroupOut[]> {
  return request('GET', '/api/capability-groups');
}

/** `POST /api/capability-groups` (`201`). */
export function createGroup(input: { name: string; purpose?: string }): Promise<GroupOut> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.purpose) body.purpose = input.purpose;
  return request('POST', '/api/capability-groups', { body });
}

/** `PATCH /api/capability-groups/{id}`. */
export function renameGroup(id: string, name: string): Promise<GroupOut> {
  return request('PATCH', `/api/capability-groups/${seg(id)}`, { body: { name } });
}

/** `DELETE /api/capability-groups/{id}`: answers `{group_id, deleted: true}`; members stay. */
export function deleteGroup(id: string): Promise<GroupDeletedOut> {
  return request('DELETE', `/api/capability-groups/${seg(id)}`);
}

/** `POST /api/capability-groups/{id}/members`. */
export function addGroupMember(groupId: string, capabilityId: string): Promise<GroupOut> {
  return request('POST', `/api/capability-groups/${seg(groupId)}/members`, {
    body: { capability_id: capabilityId },
  });
}

/** `DELETE /api/capability-groups/{id}/members/{capability}`: answers the group (`200`). */
export function removeGroupMember(groupId: string, capabilityId: string): Promise<GroupOut> {
  return request('DELETE', `/api/capability-groups/${seg(groupId)}/members/${seg(capabilityId)}`);
}
