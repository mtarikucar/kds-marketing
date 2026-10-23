import type {
  AgentConnectionOut,
  BudgetItemOut,
  BudgetSpend,
  CapabilityOut,
  ConnectorHealth,
  ConsultationEntry,
  GroupOut,
  KeySummary,
  LedgerEntryOut,
  MeOut,
  MemberOut,
  PendingAssetsOut,
  PendingOut,
  Policy,
  RoleDef,
  Sections,
  StrategyOut,
  VersionOut,
  VersionSummary,
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
      permissions: [
        'api_keys.manage',
        'budget.manage',
        'capabilities.manage',
        'ledger.read',
        'team.manage',
        'workspace.read',
      ],
    },
  ],
};

/** The same user as a rep: reads everything, changes nothing. */
export const repMe: MeOut = {
  ...me,
  memberships: [{ ...me.memberships[0], role_key: 'rep', permissions: ['workspace.read'] }],
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
    overdue: false,
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

// ---------------------------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------------------------

export const APPROVED_ID = '0190a000-0000-7000-8000-000000000040';
export const DRAFT_ID = '0190a000-0000-7000-8000-000000000041';
export const HYPOTHESIS_ID = '0190a000-0000-7000-8000-000000000042';
export const GROUP_ID = '0190a000-0000-7000-8000-000000000050';

export const sections: Sections = {
  identity: {
    product: 'El yapımı seramik',
    voice: 'sıcak ve sade',
    positioning: 'mahallenin atölyesi',
    usp: 'her parça tek',
  },
  audience: [{ key: 'students', name: 'Öğrenciler', description: 'kampüs çevresi' }],
  channels: [{ channel: 'instagram', rationale: 'görsel ürün', group_id: null }],
  goals: { objective: 'ayda 40 sipariş', kpis: [{ name: 'sipariş', target: '40' }] },
  budget_frame: { lanes: [{ lane: 'organic', period: 'monthly', cap_minor: 0, currency: 'TRY' }] },
  prohibitions: ['indirim vaadi yok'],
  cadence: { per_week: 3, channel_mix: [{ channel: 'instagram', share_pct: 100 }] },
  paid_enabled: false,
};

export const approvedVersion: VersionOut = {
  id: APPROVED_ID,
  number: 1,
  status: 'approved',
  sections,
  hypotheses: [
    {
      id: HYPOTHESIS_ID,
      title: 'Atölye videoları öğrencileri çeker',
      segment_key: 'students',
      angle: 'yapım süreci',
      channel: 'instagram',
      metric: 'kaydetme oranı',
      confidence: 0.6,
      state: 'kept',
    },
  ],
  created_at: '2026-10-20T09:00:00Z',
  submitted_at: '2026-10-20T10:00:00Z',
  approved_at: '2026-10-20T11:00:00Z',
  approved_by_email: 'owner@alpha.example',
  consultation_count: 4,
  gaps: [],
  assumptions: [],
};

export const draftGaps = [
  { field: 'identity.product', message: 'the product is required' },
  { field: 'hypotheses', message: 'at least one hypothesis that is not retired is required' },
];

export const draftVersion: VersionOut = {
  id: DRAFT_ID,
  number: 2,
  status: 'draft',
  sections: { ...sections, identity: { ...sections.identity, product: '' } },
  hypotheses: [],
  created_at: '2026-10-22T09:00:00Z',
  submitted_at: '2026-10-22T10:00:00Z',
  approved_at: null,
  approved_by_email: null,
  consultation_count: 3,
  gaps: draftGaps,
  assumptions: [
    {
      id: '0190a000-0000-7000-8000-000000000045',
      version_id: DRAFT_ID,
      kind: 'assumption',
      section_key: 'audience',
      text: 'Öğrenciler akşamları sipariş verir',
      actor: { kind: 'agent', connection_id: '0190a000-0000-7000-8000-000000000030', user_id: USER_ID },
      at: '2026-10-22T09:40:00Z',
    },
  ],
};

export const strategyWithDraft: StrategyOut = {
  approved: approvedVersion,
  draft: draftVersion,
  gaps: draftGaps,
};

export const versions: VersionSummary[] = [
  {
    id: DRAFT_ID,
    number: 2,
    status: 'draft',
    created_at: '2026-10-22T09:00:00Z',
    submitted_at: '2026-10-22T10:00:00Z',
    approved_at: null,
    archived_at: null,
  },
  {
    id: APPROVED_ID,
    number: 1,
    status: 'approved',
    created_at: '2026-10-20T09:00:00Z',
    submitted_at: '2026-10-20T10:00:00Z',
    approved_at: '2026-10-20T11:00:00Z',
    archived_at: null,
  },
];

export const consultation: ConsultationEntry[] = [
  {
    id: '0190a000-0000-7000-8000-000000000044',
    version_id: DRAFT_ID,
    kind: 'question',
    section_key: 'identity',
    text: 'Hangi ürünü öne çıkaralım?',
    actor: { kind: 'agent', connection_id: '0190a000-0000-7000-8000-000000000030', user_id: USER_ID },
    at: '2026-10-22T09:30:00Z',
  },
  {
    id: '0190a000-0000-7000-8000-000000000043',
    version_id: DRAFT_ID,
    kind: 'note',
    section_key: null,
    text: 'consultation started',
    actor: { kind: 'human', user_id: USER_ID },
    at: '2026-10-22T09:00:00Z',
  },
];

// ---------------------------------------------------------------------------------------------
// Capabilities and budget
// ---------------------------------------------------------------------------------------------

export const BUDGET_ITEM_ID = '0190a000-0000-7000-8000-000000000060';
export const CASH_ITEM_ID = '0190a000-0000-7000-8000-000000000062';

const defaultPolicy: Policy = {
  active_hours: null,
  daily_ops_cap: null,
  spend_cap_minor: null,
  requires_human_approval: false,
  verify_max_age_days: 30,
};

function capability(
  n: number,
  name: string,
  kind_key: string,
  reach: CapabilityOut['capability']['reach'],
  status: CapabilityOut['capability']['status'],
  effective: CapabilityOut['effective_status'],
): CapabilityOut {
  return {
    capability: {
      id: `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
      workspace_id: WS_ID,
      kind_key,
      key_detail: null,
      name,
      description: '',
      reach,
      status,
      external_id: null,
      connector_public: {},
      has_sealed_config: false,
      last_verified_at: status === 'verified' ? '2026-10-21T08:00:00Z' : null,
      evidence: null,
      policy: defaultPolicy,
      budget_item_ids: [],
      strategy_version_id: null,
      declared_by_connection: null,
      created_at: '2026-10-21T08:00:00Z',
      updated_at: '2026-10-21T08:00:00Z',
    },
    effective_status: effective,
  };
}

/** One capability in each of the five effective states. */
export const capabilities: CapabilityOut[] = [
  capability(1, 'Atölye Instagram', 'instagram', 'connector', 'declared', 'declared'),
  capability(2, 'Saha telefonu', 'phone', 'device', 'verified', 'verified'),
  capability(3, 'Ofis yazıcısı', 'printer', 'device', 'verified', 'stale'),
  capability(4, 'Destek kutusu', 'mailbox', 'connector', 'unreachable', 'unreachable'),
  capability(5, 'Eski hat', 'sms_line', 'connector', 'retired', 'retired'),
];
// A phone may spend only from a cash item (`can_link_budget`).
capabilities[1].capability.budget_item_ids = [CASH_ITEM_ID];
capabilities[1].capability.policy = {
  active_hours: { tz: 'Europe/Istanbul', from: 9, to: 24, days: [1, 2, 3, 4, 5] },
  daily_ops_cap: 50,
  spend_cap_minor: null,
  requires_human_approval: true,
  verify_max_age_days: 30,
};

export const groups: GroupOut[] = [
  {
    group: { id: GROUP_ID, workspace_id: WS_ID, name: 'Marka A', purpose: 'ana marka' },
    members: [capabilities[1]],
  },
];

export const budgetItems: BudgetItemOut[] = [
  {
    item: {
      id: BUDGET_ITEM_ID,
      workspace_id: WS_ID,
      name: 'Ekim kampanyası',
      kind: 'ad_budget',
      unit: { kind: 'currency', value: 'TRY' },
      cap: 100000,
      period: 'monthly',
      strategy_version_id: null,
      created_at: '2026-10-21T08:00:00Z',
      retired_at: null,
    },
    spent_in_period: 125000,
    remaining: -25000,
  },
  {
    item: {
      id: CASH_ITEM_ID,
      workspace_id: WS_ID,
      name: 'Saha giderleri',
      kind: 'cash',
      unit: { kind: 'currency', value: 'TRY' },
      cap: 50000,
      period: 'monthly',
      strategy_version_id: null,
      created_at: '2026-10-21T08:00:00Z',
      retired_at: null,
    },
    spent_in_period: 0,
    remaining: 50000,
  },
];

export const spend: BudgetSpend[] = [
  {
    id: '0190a000-0000-7000-8000-000000000061',
    budget_item_id: BUDGET_ITEM_ID,
    workspace_id: WS_ID,
    at: '2026-10-22T08:00:00Z',
    amount: 125000,
    source: { kind: 'human' },
    reference: 'FTR-2026-001',
  },
];

// ---------------------------------------------------------------------------------------------
// Pending work
// ---------------------------------------------------------------------------------------------

export const pendingOverdue: PendingOut = {
  strategy: 'missing',
  items: [
    { kind: 'consult_strategy', priority: 1, hint: 'start the consultation' },
    {
      kind: 'verify_capability',
      capability_id: capabilities[2].capability.id,
      name: 'Ofis yazıcısı',
      stale: true,
      priority: 2,
      hint: 'verify it again',
    },
  ],
  agent: { last_seen_at: '2026-10-20T08:00:00Z', interval_minutes: 1440, overdue: true },
};

// ---------------------------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------------------------

export const PENDING_ID = '0190a000-0000-7000-8000-000000000070';
export const SMS_LINE_ID = '0190a000-0000-7000-8000-000000000171';
export const PAGE_ID = '0190a000-0000-7000-8000-000000000172';

/** A NetGSM line connected by credentials and verified by its probe. */
export const smsLine: CapabilityOut = {
  capability: {
    ...capabilities[0].capability,
    id: SMS_LINE_ID,
    kind_key: 'sms_line',
    name: 'Kampanya hattı',
    status: 'verified',
    external_id: '8508001234',
    has_sealed_config: true,
    last_verified_at: '2026-10-22T08:00:00Z',
    connector_public: {
      provider: 'netgsm',
      hosts: ['api.netgsm.com.tr'],
      health: { ok: true, at: '2026-10-22T08:00:00Z', latency_ms: 42, error_kind: null },
      reconnect_required: false,
    },
  },
  effective_status: 'verified',
};

/** A Facebook page whose login the provider no longer accepts. */
export const lostPage: CapabilityOut = {
  capability: {
    ...capabilities[0].capability,
    id: PAGE_ID,
    kind_key: 'facebook_page',
    name: 'Atölye sayfası',
    status: 'unreachable',
    external_id: 'page-1',
    has_sealed_config: true,
    connector_public: {
      provider: 'meta',
      health: { ok: false, at: '2026-10-22T09:00:00Z', latency_ms: 30, error_kind: 'auth' },
      reconnect_required: true,
    },
  },
  effective_status: 'unreachable',
};

export const connectorHealth: ConnectorHealth[] = [
  {
    capability_id: capabilities[0].capability.id,
    kind_key: 'instagram',
    name: 'Atölye Instagram',
    provider: 'meta',
    status: 'declared',
    last_probe_at: null,
    ok: null,
    error_kind: null,
    token_expires_at: null,
    reconnect_required: false,
  },
  {
    capability_id: SMS_LINE_ID,
    kind_key: 'sms_line',
    name: 'Kampanya hattı',
    provider: 'netgsm',
    status: 'verified',
    last_probe_at: '2026-10-22T08:00:00Z',
    ok: true,
    error_kind: null,
    token_expires_at: null,
    reconnect_required: false,
  },
  {
    capability_id: PAGE_ID,
    kind_key: 'facebook_page',
    name: 'Atölye sayfası',
    provider: 'meta',
    status: 'unreachable',
    last_probe_at: '2026-10-22T09:00:00Z',
    ok: false,
    error_kind: 'auth',
    token_expires_at: '2026-12-01T00:00:00Z',
    reconnect_required: true,
  },
];

/** What a completed Meta flow found: two pages, never a token. */
export const pendingAssets: PendingAssetsOut = {
  pending_id: PENDING_ID,
  assets: [
    {
      kind_key: 'facebook_page',
      external_id: 'page-1',
      name: 'Kahve Evi',
      public: { category: 'Cafe', scopes: ['pages_manage_posts', 'pages_read_engagement'] },
    },
    {
      kind_key: 'instagram',
      external_id: '17841400000000001',
      name: 'kahveevi',
      public: { username: 'kahveevi', expires_at: '2026-12-21T09:00:00Z' },
    },
  ],
};
