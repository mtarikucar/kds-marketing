import type {
  CampaignOut,
  CampaignRow,
  DistributionOut,
  MeOut,
  OutreachSettingsOut,
  Prospect,
  ProspectGetOut,
  ProspectRow,
  ResearchTask,
  TemplateOut,
} from '@/api/types';
import { me, USER_ID, WS_ID } from './fixtures';

// Invented leads data shaped like the server's answers: `example.invalid` addresses, numbers made
// of zeros, made-up businesses. No real people or customers.

/**
 * How long a test waits for a page's first answer: the whole panel renders first (session,
 * shell, the page's queries), which a loaded machine can take over the default second for.
 */
export const LOADED = { timeout: 5000 };

export const AGENT_CONNECTION_ID = '0190a000-0000-7000-8000-000000000030';
export const REP_ID = '0190a000-0000-7000-8000-0000000000a1';
export const STRATEGY_ID = '0190a000-0000-7000-8000-000000000040';
export const MAILBOX_ID = '0190a000-0000-7000-8000-0000000000b1';

/** The owner, with every leads permission, in an active workspace. */
export const leadsMe: MeOut = {
  ...me,
  memberships: [
    {
      ...me.memberships[0],
      workspace_status: 'active',
      permissions: [
        ...me.memberships[0].permissions,
        'inbox.work',
        'inbox.manage',
        'prospects.work',
        'prospects.manage',
        'outreach.work',
        'outreach.manage',
      ],
    },
  ],
};

/** A rep: works the pool and the inbox, manages neither. */
export const leadsRep: MeOut = {
  ...me,
  user_id: REP_ID,
  email: 'rep@alpha.example.invalid',
  display_name: 'Rana Temsilci',
  memberships: [
    {
      ...me.memberships[0],
      role_key: 'rep',
      workspace_status: 'active',
      permissions: ['workspace.read', 'inbox.work', 'prospects.work', 'outreach.work'],
    },
  ],
};

export function prospectId(n: number): string {
  return `0190a000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;
}

export function taskId(n: number): string {
  return `0190a000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`;
}

export function row(n: number, extra: Partial<ProspectRow> = {}): ProspectRow {
  return {
    id: prospectId(n),
    status: 'qualified',
    business_name: `Örnek Kafe ${n}`,
    entity_kind: 'legal_entity',
    sector: 'kafe',
    city: 'İzmir',
    district: null,
    country: 'TR',
    language: 'tr',
    segment_key: 'kafeler',
    labels: [],
    research_task_id: taskId(1),
    latest_score: { score: 72, digest: 'abc123', at: '2026-11-01T09:00:00Z' },
    bucket: '50-74',
    fields: ['phone', 'email'],
    promoted: null,
    revision: 3,
    decided_at: null,
    purge_after: '2027-04-30T09:00:00Z',
    created_at: `2026-11-01T09:${String(n).padStart(2, '0')}:00Z`,
    updated_at: '2026-11-01T09:00:00Z',
    ...extra,
  };
}

const agent = { kind: 'agent' as const, connection_id: AGENT_CONNECTION_ID, user_id: USER_ID };

export function prospect(n: number, extra: Partial<Prospect> = {}): Prospect {
  return {
    id: prospectId(n),
    workspace_id: WS_ID,
    status: 'qualified',
    business_name: `Örnek Kafe ${n}`,
    entity_kind: 'legal_entity',
    sector: 'kafe',
    city: 'İzmir',
    district: 'Alsancak',
    country: 'TR',
    language: 'tr',
    segment_key: 'kafeler',
    labels: [],
    contact: {
      phone: {
        value: '+905000000000',
        deliverable: true,
        evidence: {
          sources: [{ kind: 'url', url: 'https://ornek-kafe.example.invalid/iletisim', note: null }],
          captured_at: '2026-11-01T08:55:00Z',
          recorder: agent,
        },
      },
      email: {
        value: 'merhaba@ornek-kafe.example.invalid',
        deliverable: true,
        evidence: {
          // A source that is no web page: shown as text, never as a link.
          sources: [{ kind: 'url', url: 'javascript:alert(1)', note: null }],
          captured_at: '2026-11-01T08:56:00Z',
          recorder: { kind: 'human', user_id: USER_ID },
        },
      },
    },
    size: null,
    signals: [
      {
        text: 'Yeni şube açıyor',
        source: { kind: 'url', url: 'https://haber.example.invalid/ornek-kafe', note: null },
      },
    ],
    notes: '',
    origin: { via: 'research_task', discovered_at: [], distinct_from: [], recorder: agent, at: '2026-11-01T09:00:00Z' },
    research_task_id: taskId(1),
    latest_score: { score: 72, digest: 'abc123def456', at: '2026-11-01T09:10:00Z' },
    decision: null,
    promoted: null,
    purge_after: '2027-04-30T09:00:00Z',
    revision: 3,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '2026-11-01T09:10:00Z',
    ...extra,
  };
}

export function prospectOut(n: number, extra: Partial<Prospect> = {}): ProspectGetOut {
  return {
    prospect: prospect(n, extra),
    scores: [
      {
        id: '0190a000-0000-7000-8000-000000000301',
        prospect_id: prospectId(n),
        score: 72,
        reasons: [
          { criterion: 'sube_sayisi', points: 30, evidence: 'İki şubesi var', source: null },
          {
            criterion: 'aktif_sosyal',
            points: 42,
            evidence: 'Haftada üç gönderi',
            source: { kind: 'url', url: 'https://sosyal.example.invalid/ornekkafe', note: null },
          },
        ],
        rubric_digest: 'abc123def456',
        strategy_version_id: STRATEGY_ID,
        recorder: agent,
        at: '2026-11-01T09:10:00Z',
      },
    ],
    duplicate_candidates: [
      { prospect_id: prospectId(n + 1), business_name: `Örnek Kafe ${n + 1}`, city: 'İzmir', status: 'new', matched: ['domain'] },
    ],
    ledger: [
      {
        id: 41,
        entry: {
          workspace_id: WS_ID,
          at: '2026-11-01T09:10:00Z',
          actor: { kind: 'system', component: 'prospects' },
          action: 'prospects.qualified',
          subject: { kind: 'prospect', id: prospectId(n) },
          payload: { auto: true },
          strategy_version_id: STRATEGY_ID,
        },
      },
    ],
  };
}

export function task(n: number, extra: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: taskId(n),
    workspace_id: WS_ID,
    kind: { type: 'standing', icp_key: 'kafeler_izmir' },
    strategy_version_id: STRATEGY_ID,
    brief: {
      segment_key: 'kafeler',
      sectors: ['kafe'],
      areas: [{ city: 'İzmir', district: null }],
      signals: ['yeni şube'],
      exclusions: ['zincir'],
      size_hint: '1-3 şube',
      language: 'tr',
      note: '',
    },
    rubric_digest: 'abc123def456',
    daily_cap: 20,
    status: 'open',
    claim: null,
    created_by: { kind: 'system', job: 'research_plan' },
    created_at: '2026-11-01T08:00:00Z',
    closed_at: null,
    close_note: '',
    ...extra,
  };
}

export const playbook = {
  version: 1,
  text: 'Kendi araçlarınızla araştırın; her iletişim bilgisi için kaynak verin.',
  workspace: {
    prospecting_on: true,
    icp: [],
    rubric: { criteria: [], qualify_at: 60 },
    rubric_digest: 'abc123def456',
    caps: {
      timezone: 'Europe/Istanbul',
      daily_prospects: 500,
      recorded_today: 12,
      max_promotions_per_day: 100,
      resets_at: '2026-11-04T21:00:00Z',
    },
    remaining_today: [],
    retention_days: { rejected: 30, unpromoted: 180, rejected_memory: 365 },
    blocklist_rules: { listed: ['phone', 'email', 'instagram', 'tiktok'], flagged: ['domain', 'name_city'] },
  },
};

export const team = [
  {
    membership_id: '0190a000-0000-7000-8000-000000000003',
    user_id: USER_ID,
    email: 'owner@alpha.example.invalid',
    display_name: 'Ada Sahip',
    role_key: 'owner',
    role_name: 'Owner',
    status: 'active',
    created_at: '2026-10-22T09:00:00Z',
  },
  {
    membership_id: '0190a000-0000-7000-8000-0000000000a2',
    user_id: REP_ID,
    email: 'rep@alpha.example.invalid',
    display_name: 'Rana Temsilci',
    role_key: 'rep',
    role_name: 'Rep',
    status: 'active',
    created_at: '2026-10-22T10:00:00Z',
  },
];

export const agentsList = [
  {
    id: AGENT_CONNECTION_ID,
    api_key_id: '0190a000-0000-7000-8000-000000000020',
    api_key_name: 'Gece işleri',
    client_name: 'arastirma-ajani',
    client_version: '1.0.0',
    protocol_version: '2025-06-18',
    first_seen_at: '2026-10-22T11:05:00Z',
    last_seen_at: '2026-11-01T09:00:00Z',
    tool_calls: 42,
    overdue: false,
  },
];

export const distribution: DistributionOut = {
  mode: 'auto',
  max_reassignments: 2,
  rules: [
    {
      id: '0190a000-0000-7000-8000-000000000401',
      name: 'İzmir kafeleri',
      enabled: true,
      when: { sources: ['prospect'], cities: ['İzmir'], sectors: [], languages: [], segments: [], min_score: null },
      to: { kind: 'members', user_ids: [REP_ID] },
      method: 'round_robin',
      sla_minutes: 60,
      cursor: null,
    },
    {
      id: '0190a000-0000-7000-8000-000000000402',
      name: 'Reklam formları',
      enabled: true,
      when: { sources: ['meta_ads'], cities: [], sectors: [], languages: [], segments: [], min_score: null },
      to: { kind: 'all_eligible' },
      method: 'least_loaded',
      sla_minutes: null,
      cursor: REP_ID,
    },
  ],
  reps: [
    {
      user_id: USER_ID,
      display_name: 'Ada Sahip',
      role_key: 'owner',
      profile: {
        user_id: USER_ID,
        accepting: true,
        max_open: null,
        languages: [],
        cities: [],
        sectors: [],
        hours: null,
        away_until: null,
        updated_at: '2026-11-01T09:00:00Z',
      },
      open_owned: 4,
      on_shift: true,
      eligible: true,
    },
    {
      user_id: REP_ID,
      display_name: 'Rana Temsilci',
      role_key: 'rep',
      profile: {
        user_id: REP_ID,
        accepting: true,
        max_open: 30,
        languages: ['tr'],
        cities: ['İzmir'],
        sectors: [],
        hours: null,
        away_until: null,
        updated_at: '2026-11-01T09:00:00Z',
      },
      open_owned: 7,
      on_shift: false,
      eligible: true,
    },
  ],
  ownerless: { count: 3, oldest_journey_id: '0190a000-0000-7000-8000-000000000501' },
  stalled: 1,
};

export function template(n: number, extra: Partial<TemplateOut['template']> = {}): TemplateOut {
  return {
    template: {
      id: `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`,
      name: `Tanışma ${n}`,
      language: 'tr',
      subject: 'Merhaba {{company}}',
      body: 'Merhaba {{contact_name|ekip}},\n\n{{company}} için bir önerimiz var: https://teklif.example.invalid/kafe\n\nSevgiler,\n{{sender_name}}',
      revision: 1,
      archived: false,
      ...extra,
    },
    facts: { vars: ['company', 'contact_name', 'sender_name'], links: ['https://teklif.example.invalid/kafe'] },
    updated_at: '2026-11-01T10:00:00Z',
  };
}

export const CAMPAIGN_ID = '0190a000-0000-7000-8000-000000000701';

export function campaignRow(extra: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: CAMPAIGN_ID,
    name: 'İzmir kafeleri tanışma',
    mailbox_id: MAILBOX_ID,
    status: 'draft',
    definition: {
      sender_name: 'Ada Sahip',
      steps: [{ template_id: template(1).template.id, delay_days: 0, same_thread: false, snapshot: null }],
      audience: { people: null, prospects: { segment_keys: ['kafeler'], cities: ['İzmir'] }, explicit: [] },
      schedule: { start_at: null, window: { tz: 'Europe/Istanbul', from: 9, to: 18, days: [1, 2, 3, 4, 5] } },
      throttle: { per_hour: 10, per_day: 50 },
      click_tracking: false,
      evergreen: false,
      segment_key: 'kafeler',
    },
    revision: 2,
    approval: null,
    pause_reason: null,
    strategy_version_id: STRATEGY_ID,
    created_by: { kind: 'agent', connection_id: AGENT_CONNECTION_ID, user_id: USER_ID },
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:30:00Z',
    launched_at: null,
    completed_at: null,
    ...extra,
  };
}

export function campaignOut(extra: Partial<CampaignRow> = {}, out: Partial<CampaignOut> = {}): CampaignOut {
  return { campaign: campaignRow(extra), approval_required: false, active_enrollments: 0, ...out };
}

export const outreachSettings: OutreachSettingsOut = {
  requires_approval: false,
  b2b_basis: [],
  require_iys_lookup: true,
  legal_ack: null,
  sender_company: 'Alfa Atölye',
  sender_address: 'Örnek Mah. 1, İzmir',
  privacy_notice_url: 'https://alfa.example.invalid/kvkk',
  warmup: { enabled: true, start: 20, step: 10, max: 150 },
  frequency: { min_gap_days: 3, max_per_30_days: 4 },
  click_tracking_default: false,
  sender_identity_complete: true,
  platform_enabled: true,
  b2b_channels_in_force: [],
};

/** A `mailbox` capability as `GET /api/capabilities?kind=mailbox` lists it (the fields the panel reads). */
export const mailbox = {
  capability: { id: MAILBOX_ID, workspace_id: WS_ID, kind_key: 'mailbox', name: 'Satış posta kutusu' },
  effective_status: 'verified',
};

/** A manager: every leads permission, but not the owner's role. */
export const leadsManager: MeOut = {
  ...leadsMe,
  memberships: [{ ...leadsMe.memberships[0], role_key: 'manager' }],
};
