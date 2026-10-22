import type {
  AgentConnectionOut,
  KeySummary,
  LedgerEntryOut,
  MeOut,
  MemberOut,
  RoleDef,
  WorkspaceAdminOut,
  WorkspaceOut,
} from '@/api/types';

// Minimal, invented data shaped like the server's responses. No real people or customers.

export const WS_ID = '0190a000-0000-7000-8000-000000000001';
export const USER_ID = '0190a000-0000-7000-8000-000000000002';

export const me: MeOut = {
  user_id: USER_ID,
  email: 'owner@alpha.example',
  display_name: 'Ada Sahip',
  current_workspace: WS_ID,
  memberships: [
    {
      membership_id: '0190a000-0000-7000-8000-000000000003',
      workspace_id: WS_ID,
      workspace_name: 'Alfa Atölye',
      workspace_slug: 'alfa-atolye',
      workspace_status: 'pending_payment',
      role_key: 'owner',
      permissions: ['api_keys.manage', 'ledger.read', 'team.manage', 'workspace.read'],
    },
  ],
};

export const workspace: WorkspaceOut = {
  id: WS_ID,
  name: 'Alfa Atölye',
  slug: 'alfa-atolye',
  status: 'pending_payment',
  my_role: 'owner',
  my_permissions: ['api_keys.manage', 'ledger.read', 'team.manage', 'workspace.read'],
};

export const members: MemberOut[] = [
  {
    membership_id: '0190a000-0000-7000-8000-000000000003',
    user_id: USER_ID,
    email: 'owner@alpha.example',
    display_name: 'Ada Sahip',
    role_key: 'owner',
    role_name: 'Owner',
    status: 'active',
    created_at: '2026-10-22T09:00:00Z',
  },
  {
    membership_id: '0190a000-0000-7000-8000-000000000004',
    user_id: null,
    email: 'invitee@alpha.example',
    display_name: null,
    role_key: 'rep',
    role_name: 'Rep',
    status: 'invited',
    created_at: '2026-10-22T10:00:00Z',
  },
];

export const roles: RoleDef[] = [
  {
    id: '0190a000-0000-7000-8000-000000000010',
    key: 'owner',
    name: 'Owner',
    permissions: ['api_keys.manage', 'ledger.read', 'team.manage', 'workspace.read'],
    is_system: true,
  },
  {
    id: '0190a000-0000-7000-8000-000000000011',
    key: 'auditor',
    name: 'Denetçi',
    permissions: ['ledger.read', 'workspace.read'],
    is_system: false,
  },
];

export const keys: KeySummary[] = [
  {
    id: '0190a000-0000-7000-8000-000000000020',
    name: 'Gece işleri',
    prefix: 'jt_ab12',
    scopes: ['ledger.read', 'workspace.read'],
    status: 'active',
    issued_by: USER_ID,
    created_at: '2026-10-22T11:00:00Z',
    last_used_at: null,
    revoked_at: null,
  },
];

export const agents: AgentConnectionOut[] = [
  {
    id: '0190a000-0000-7000-8000-000000000030',
    api_key_id: '0190a000-0000-7000-8000-000000000020',
    api_key_name: 'Gece işleri',
    client_name: 'ornek-istemci',
    client_version: '1.4.0',
    protocol_version: '2025-06-18',
    first_seen_at: '2026-10-22T11:05:00Z',
    last_seen_at: '2026-10-22T12:00:00Z',
    tool_calls: 42,
  },
];

export const ledger: LedgerEntryOut[] = [
  {
    id: 7,
    entry: {
      workspace_id: WS_ID,
      at: '2026-10-22T12:00:00Z',
      actor: { kind: 'human', user_id: USER_ID },
      action: 'team.invite',
      subject: { kind: 'membership', id: '0190a000-0000-7000-8000-000000000004' },
      payload: { email: 'invitee@alpha.example', role_key: 'rep', invite_token: '***' },
      strategy_version_id: null,
    },
  },
];

export const adminWorkspaces: WorkspaceAdminOut[] = [
  {
    id: WS_ID,
    name: 'Alfa Atölye',
    slug: 'alfa-atolye',
    status: 'pending_payment',
    created_at: '2026-10-22T09:00:00Z',
    owner_email: 'owner@alpha.example',
    member_count: 2,
  },
];
