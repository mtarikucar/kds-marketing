// The server's JSON shapes, mirroring the Rust output structs of `jt_app` / `jt_panel_http`.
// Ids are UUID strings; times are RFC 3339 strings.

export type Uuid = string;
export type Rfc3339 = string;

/** `jt_tenancy::WorkspaceStatus`. */
export type WorkspaceStatus = 'pending_payment' | 'active' | 'suspended';
export const WORKSPACE_STATUSES: readonly WorkspaceStatus[] = ['pending_payment', 'active', 'suspended'];

/** `jt_tenancy::MembershipStatus`. */
export type MembershipStatus = 'invited' | 'active' | 'removed';

/** `jt_tenancy::Permission`: the fixed permission list. */
export type Permission = 'workspace.read' | 'team.manage' | 'api_keys.manage' | 'ledger.read';
export const PERMISSIONS: readonly Permission[] = [
  'workspace.read',
  'team.manage',
  'api_keys.manage',
  'ledger.read',
];

/** Keys of the seeded system roles (`jt_tenancy::SystemRole`). */
export type SystemRoleKey = 'owner' | 'manager' | 'rep';
export const SYSTEM_ROLE_KEYS: readonly SystemRoleKey[] = ['owner', 'manager', 'rep'];

/** `jt_app::ports::MembershipView`. */
export interface MembershipView {
  membership_id: Uuid;
  workspace_id: Uuid;
  workspace_name: string;
  workspace_slug: string;
  workspace_status: WorkspaceStatus;
  role_key: string;
  permissions: Permission[];
}

/** `jt_app::usecases::auth::MeOut`. */
export interface MeOut {
  user_id: Uuid;
  email: string;
  display_name: string;
  current_workspace: Uuid | null;
  memberships: MembershipView[];
}

/** `jt_app::usecases::workspace::WorkspaceOut`. */
export interface WorkspaceOut {
  id: Uuid;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  my_role: string;
  my_permissions: Permission[];
}

/** `jt_app::ports::MemberOut`: a member, or a pending invitee (`user_id` null). */
export interface MemberOut {
  membership_id: Uuid;
  user_id: Uuid | null;
  email: string;
  display_name: string | null;
  role_key: string;
  role_name: string;
  status: MembershipStatus;
  created_at: Rfc3339;
}

/** `jt_app::usecases::team::InviteOut`: the plaintext token is shown here once. */
export interface InviteOut {
  membership_id: Uuid;
  invite_token: string;
  expires_at: Rfc3339;
}

/** `jt_panel_http::routes::team::AcceptedBody`; `me` only when accepting created the user. */
export interface AcceptOut {
  workspace_id: Uuid;
  membership_id: Uuid;
  me?: MeOut;
}

/** `jt_tenancy::RoleDef`. */
export interface RoleDef {
  id: Uuid;
  key: string;
  name: string;
  permissions: Permission[];
  is_system: boolean;
}

/** `jt_app::usecases::api_keys::KeyOut`: the plaintext is shown here once. */
export interface KeyOut {
  id: Uuid;
  name: string;
  prefix: string;
  plaintext: string;
  scopes: Permission[];
  created_at: Rfc3339;
}

/** `jt_app::ports::ApiKeyStatus`. */
export type ApiKeyStatus = 'active' | 'revoked';

/** `jt_app::usecases::api_keys::KeySummary`: never carries the plaintext. */
export interface KeySummary {
  id: Uuid;
  name: string;
  prefix: string;
  scopes: Permission[];
  status: ApiKeyStatus;
  issued_by: Uuid;
  created_at: Rfc3339;
  last_used_at: Rfc3339 | null;
  revoked_at: Rfc3339 | null;
}

/** `jt_app::usecases::agents::AgentConnectionOut`. */
export interface AgentConnectionOut {
  id: Uuid;
  api_key_id: Uuid;
  api_key_name: string;
  client_name: string;
  client_version: string;
  protocol_version: string;
  first_seen_at: Rfc3339;
  last_seen_at: Rfc3339;
  tool_calls: number;
}

/** `jt_ledger::Actor`, tagged by `kind`. */
export type Actor =
  | { kind: 'human'; user_id: Uuid }
  | { kind: 'agent'; connection_id: Uuid; user_id: Uuid }
  | { kind: 'system'; component: string };
export type ActorKind = Actor['kind'];
export const ACTOR_KINDS: readonly ActorKind[] = ['human', 'agent', 'system'];

/** `jt_ledger::Subject`. */
export interface Subject {
  kind: string;
  id: string;
}

/** `jt_ledger::LedgerEntry`; `payload` is already redacted by the server. */
export interface LedgerEntry {
  workspace_id: Uuid;
  at: Rfc3339;
  actor: Actor;
  action: string;
  subject: Subject | null;
  payload: unknown;
  strategy_version_id: Uuid | null;
}

/** `jt_app::usecases::ledger::LedgerEntryOut`. */
export interface LedgerEntryOut {
  id: number;
  entry: LedgerEntry;
}

/** `jt_app::usecases::platform::WorkspaceAdminOut`. */
export interface WorkspaceAdminOut {
  id: Uuid;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  created_at: Rfc3339;
  owner_email: string | null;
  member_count: number;
}

/** `jt_panel_http::routes::platform::PlatformSignedIn` (the token itself is in the cookie). */
export interface PlatformSessionOut {
  expires_at: Rfc3339;
}

/** The structured error body every failure carries. */
export interface ErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown>;
}
