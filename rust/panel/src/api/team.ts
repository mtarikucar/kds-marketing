import { request, seg } from './client';
import type { AcceptOut, InviteOut, MemberOut } from './types';

/** `GET /api/team`. */
export function listTeam(): Promise<MemberOut[]> {
  return request('GET', '/api/team');
}

/** `POST /api/team/invites`: the answer holds the one-time invite token. */
export function invite(input: { email: string; role_key: string }): Promise<InviteOut> {
  return request('POST', '/api/team/invites', { body: input });
}

/**
 * `POST /api/team/invites/accept`. Signed in: the session's user accepts. Otherwise
 * `password` and `display_name` create the invitee, who is then signed in.
 */
export function acceptInvite(input: {
  token: string;
  password?: string;
  display_name?: string;
}): Promise<AcceptOut> {
  return request('POST', '/api/team/invites/accept', { body: input, redirectOn401: false });
}

/** `PATCH /api/team/{membership_id}/role`. */
export function setRole(membershipId: string, roleKey: string): Promise<MemberOut> {
  return request('PATCH', `/api/team/${seg(membershipId)}/role`, { body: { role_key: roleKey } });
}

/** `DELETE /api/team/{membership_id}`: removes a member or cancels an invite. */
export function removeMember(membershipId: string): Promise<void> {
  return request('DELETE', `/api/team/${seg(membershipId)}`);
}
