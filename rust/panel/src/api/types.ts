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
export type Permission =
  | 'workspace.read'
  | 'team.manage'
  | 'api_keys.manage'
  | 'ledger.read'
  | 'capabilities.manage'
  | 'budget.manage'
  | 'inbox.work'
  | 'inbox.manage'
  | 'studio.work'
  | 'studio.manage'
  | 'calls.work'
  | 'calls.manage'
  | 'calls.bridge'
  | 'devices.work'
  | 'devices.bridge'
  | 'prospects.work'
  | 'prospects.manage'
  | 'outreach.work'
  | 'outreach.manage';
export const PERMISSIONS: readonly Permission[] = [
  'workspace.read',
  'team.manage',
  'api_keys.manage',
  'ledger.read',
  'capabilities.manage',
  'budget.manage',
  'inbox.work',
  'inbox.manage',
  'studio.work',
  'studio.manage',
  'calls.work',
  'calls.manage',
  'calls.bridge',
  'devices.work',
  'devices.bridge',
  'prospects.work',
  'prospects.manage',
  'outreach.work',
  'outreach.manage',
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
  /** Not seen for longer than the workspace's check-in interval. */
  overdue: boolean;
}

/** `jt_ledger::Actor`, tagged by `kind`. */
export type Actor =
  | { kind: 'human'; user_id: Uuid }
  | { kind: 'agent'; connection_id: Uuid; user_id: Uuid }
  | { kind: 'system'; component: string };
export type ActorKind = Actor['kind'];
export const ACTOR_KINDS: readonly ActorKind[] = ['human', 'agent', 'system'];

/** `jt_app::usecases::agents::WhoAmI`: who the caller is, where, and what it may do. */
export interface WhoAmI {
  actor: Actor;
  workspace_id: Uuid;
  role_key: string | null;
  permissions: Permission[];
}

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

// ---------------------------------------------------------------------------------------------
// Strategy (`jt_strategy`, `jt_app::usecases::strategy`)
// ---------------------------------------------------------------------------------------------

/** `jt_strategy::VersionStatus`. */
export type VersionStatus = 'draft' | 'approved' | 'archived';

/** `jt_strategy::Identity`. */
export interface Identity {
  product: string;
  voice: string;
  positioning: string;
  usp: string;
}

/** `jt_strategy::Segment`: `key` is `[a-z0-9_]{2,32}`, unique within the strategy. */
export interface Segment {
  key: string;
  name: string;
  description: string;
}

/** `jt_strategy::ChannelChoice`: a capability kind key or `any`, optionally narrowed to a group. */
export interface ChannelChoice {
  channel: string;
  rationale: string;
  group_id: Uuid | null;
}

/** `jt_strategy::Kpi`. */
export interface Kpi {
  name: string;
  target: string;
}

/** `jt_strategy::Goals`. */
export interface Goals {
  objective: string;
  kpis: Kpi[];
}

/** `jt_strategy::LaneKind`. */
export type LaneKind = 'organic' | 'paid';
export const LANE_KINDS: readonly LaneKind[] = ['organic', 'paid'];

/** `jt_strategy::Period` (a budget frame lane's period). */
export type LanePeriod = 'weekly' | 'monthly';
export const LANE_PERIODS: readonly LanePeriod[] = ['weekly', 'monthly'];

/** `jt_strategy::Lane`: the cap in minor units of `currency` (ISO 4217). */
export interface Lane {
  lane: LaneKind;
  period: LanePeriod;
  cap_minor: number;
  currency: string;
}

/** `jt_strategy::BudgetFrame`. */
export interface BudgetFrame {
  lanes: Lane[];
}

/** `jt_strategy::Mix`: one channel's share of the cadence. */
export interface Mix {
  channel: string;
  share_pct: number;
}

/** `jt_strategy::Cadence`: posts per week (0 to 70) and the shares per channel (sum 100). */
export interface Cadence {
  per_week: number;
  channel_mix: Mix[];
}

/** `jt_strategy::Sections`. */
export interface Sections {
  identity: Identity;
  audience: Segment[];
  channels: ChannelChoice[];
  goals: Goals;
  budget_frame: BudgetFrame;
  prohibitions: string[];
  cadence: Cadence;
  paid_enabled: boolean;
}

/** `Sections::KEYS`: one section is written at a time under its key. */
export type SectionKey = keyof Sections;
export const SECTION_KEYS: readonly SectionKey[] = [
  'identity',
  'audience',
  'channels',
  'goals',
  'budget_frame',
  'prohibitions',
  'cadence',
  'paid_enabled',
];

/** `jt_strategy::ANY_CHANNEL`: stands for any channel wherever one is named. */
export const ANY_CHANNEL = 'any';

/** `jt_strategy::HypothesisState`. */
export type HypothesisState = 'kept' | 'retired' | 'added';

/** `jt_strategy::Hypothesis`: `id` is stable across versions; `confidence` is 0 to 1. */
export interface HypothesisCadence {
  slots_per_week: number;
  exploration_bps?: number;
  content_types: { key: string; min_bps: number; max_bps: number }[];
}

export interface Hypothesis {
  id: Uuid;
  title: string;
  segment_key: string;
  angle: string;
  channel: string;
  metric: string;
  prior_confidence: number;
  state: HypothesisState;
  derived_confidence: number | null;
  cadence: Partial<Record<LaneKind, HypothesisCadence>>;
}

/** `jt_strategy::HypothesisInput`: no state; no `id` when the hypothesis is new. */
export interface HypothesisInput {
  cadence?: Partial<Record<LaneKind, HypothesisCadence>>;
  id?: Uuid;
  title: string;
  segment_key: string;
  angle: string;
  channel: string;
  metric: string;
  prior_confidence: number;
}

/** `jt_strategy::Gap`: a dotted field path and what is wrong with it (in English). */
export interface Gap {
  field: string;
  message: string;
}

/** `jt_app::usecases::strategy::VersionOut`. */
export interface VersionOut {
  id: Uuid;
  number: number;
  status: VersionStatus;
  sections: Sections;
  /** In order, retired ones included. */
  hypotheses: Hypothesis[];
  created_at: Rfc3339;
  submitted_at: Rfc3339 | null;
  approved_at: Rfc3339 | null;
  approved_by_email: string | null;
  consultation_count: number;
  /** For a draft, everything that stops its approval today; empty otherwise. */
  gaps: Gap[];
  /**
   * For a draft, the assumptions its consultation recorded without the owner's answer, newest
   * first: listed to whoever approves it. Empty for any other version.
   */
  assumptions: ConsultationEntry[];
}

/** `jt_app::usecases::strategy::StrategyOut`. */
export interface StrategyOut {
  approved: VersionOut | null;
  draft: VersionOut | null;
  /** The draft's gaps; empty without a draft. */
  gaps: Gap[];
}

/** `jt_app::usecases::strategy::VersionSummary`. */
export interface VersionSummary {
  id: Uuid;
  number: number;
  status: VersionStatus;
  created_at: Rfc3339;
  submitted_at: Rfc3339 | null;
  approved_at: Rfc3339 | null;
  archived_at: Rfc3339 | null;
}

/** `jt_strategy::ConsultationKind`. */
export type ConsultationKind =
  | 'question'
  | 'answer'
  | 'assumption'
  | 'section_draft'
  | 'note'
  | 'submitted'
  | 'approved'
  | 'archived';

/** `jt_app::usecases::strategy::RecordKind`: what a caller may record. */
export type RecordKind = 'question' | 'answer' | 'assumption' | 'note';
export const RECORD_KINDS: readonly RecordKind[] = ['note', 'question', 'answer', 'assumption'];

/** `jt_strategy::ConsultationEntry`. */
export interface ConsultationEntry {
  id: Uuid;
  version_id: Uuid;
  kind: ConsultationKind;
  section_key: string | null;
  text: string;
  actor: Actor;
  at: Rfc3339;
}

/**
 * What approving names (`jt_panel_http::routes::strategy::ApproveBody`): the draft as it was
 * shown, its id and its `submitted_at` exactly as the server answered them. A draft that changed
 * since is refused with `409 CONFLICT`.
 */
export interface ApproveStamp {
  version_id: Uuid;
  submitted_at: Rfc3339;
}

/** `jt_panel_http::routes::strategy::RecordedBody`. */
export interface RecordedOut {
  id: Uuid;
}

// ---------------------------------------------------------------------------------------------
// Capabilities (`jt_capability`, `jt_app::usecases::{capabilities,groups}`)
// ---------------------------------------------------------------------------------------------

/** `jt_capability::Reach`. */
export type Reach = 'connector' | 'agent' | 'device';

/** `jt_capability::KindGroup`, in the order of `KINDS`. */
export const KIND_GROUPS = [
  'social_account',
  'messaging',
  'telephony',
  'community',
  'ads',
  'calendar',
  'marketplace',
  'device',
  'agent_connection',
  'computer_access',
  'third_party',
] as const;
export type KindGroup = (typeof KIND_GROUPS)[number];

/** `jt_capability::KINDS`: the closed list of capability kinds, grouped, in a stable order. */
export const KINDS = [
  { group: 'social_account', key: 'instagram' },
  { group: 'social_account', key: 'facebook_page' },
  { group: 'social_account', key: 'x' },
  { group: 'social_account', key: 'linkedin_page' },
  { group: 'social_account', key: 'linkedin_member' },
  { group: 'social_account', key: 'tiktok' },
  { group: 'social_account', key: 'pinterest' },
  { group: 'social_account', key: 'youtube' },
  { group: 'social_account', key: 'google_business' },
  { group: 'messaging', key: 'whatsapp_cloud' },
  { group: 'messaging', key: 'instagram_dm' },
  { group: 'messaging', key: 'messenger' },
  { group: 'messaging', key: 'sms_line' },
  { group: 'messaging', key: 'mailbox' },
  { group: 'messaging', key: 'webchat' },
  { group: 'telephony', key: 'netgsm_pbx' },
  { group: 'telephony', key: 'voice_bridge' },
  { group: 'community', key: 'discord' },
  { group: 'community', key: 'reddit' },
  { group: 'community', key: 'review_google' },
  { group: 'community', key: 'review_facebook' },
  { group: 'ads', key: 'meta_ads' },
  { group: 'ads', key: 'tiktok_ads' },
  { group: 'ads', key: 'linkedin_ads' },
  { group: 'ads', key: 'google_ads' },
  { group: 'calendar', key: 'google_calendar' },
  { group: 'calendar', key: 'outlook_calendar' },
  { group: 'marketplace', key: 'trendyol' },
  { group: 'marketplace', key: 'hepsiburada' },
  { group: 'device', key: 'phone' },
  { group: 'device', key: 'computer' },
  { group: 'device', key: 'printer' },
  { group: 'device', key: 'printer_3d' },
  { group: 'device', key: 'audio_io' },
  { group: 'device', key: 'camera' },
  { group: 'device', key: 'screen' },
  { group: 'device', key: 'scanner' },
  { group: 'device', key: 'usb_storage' },
  { group: 'agent_connection', key: 'claude_code' },
  { group: 'agent_connection', key: 'codex' },
  { group: 'agent_connection', key: 'claude_ai' },
  { group: 'agent_connection', key: 'other_agent' },
  { group: 'computer_access', key: 'filesystem_root' },
  { group: 'computer_access', key: 'browser_profile' },
  { group: 'computer_access', key: 'shell' },
  { group: 'computer_access', key: 'adb' },
  { group: 'computer_access', key: 'screen_control' },
  { group: 'third_party', key: 'notion' },
  { group: 'third_party', key: 'slack' },
  { group: 'third_party', key: 'gmail' },
  { group: 'third_party', key: 'apify' },
  { group: 'third_party', key: 'firecrawl' },
  { group: 'third_party', key: 'other' },
] as const satisfies readonly { group: KindGroup; key: string }[];
export type CapabilityKind = (typeof KINDS)[number];
export type KindKey = CapabilityKind['key'];

/** `jt_capability::StoredStatus`. */
export type StoredStatus = 'declared' | 'verified' | 'unreachable' | 'retired';

/** `jt_capability::EffectiveStatus`: the stored status, but `stale` once a verification lapsed. */
export type EffectiveStatus = 'declared' | 'verified' | 'stale' | 'unreachable' | 'retired';
export const EFFECTIVE_STATUSES: readonly EffectiveStatus[] = [
  'declared',
  'verified',
  'stale',
  'unreachable',
  'retired',
];

/**
 * `jt_capability::Hours`: open from `from`:00 to `to`:00 local time on each ISO weekday in `days`
 * (1 = Monday … 7 = Sunday); `from` is 0 to 23, `to` 1 to 24 (24 = midnight) and after `from`.
 */
export interface Hours {
  tz: string;
  from: number;
  to: number;
  days: number[];
}

/** `jt_capability::Policy`. */
export interface Policy {
  active_hours: Hours | null;
  daily_ops_cap: number | null;
  spend_cap_minor: number | null;
  requires_human_approval: boolean;
  /** 0 = a verification never goes stale. */
  verify_max_age_days: number;
}

/** `jt_capability::DEFAULT_VERIFY_MAX_AGE_DAYS`. */
export const DEFAULT_VERIFY_MAX_AGE_DAYS = 30;

/** `jt_capability::Evidence`: the agent's claim, recorded and never checked. */
export interface Evidence {
  text: string;
  refs: string[];
}

/** `jt_capability::Capability`: never its sealed data, only whether it has any. */
export interface Capability {
  id: Uuid;
  workspace_id: Uuid;
  kind_key: string;
  key_detail: string | null;
  name: string;
  description: string;
  reach: Reach;
  status: StoredStatus;
  external_id: string | null;
  connector_public: Record<string, unknown>;
  has_sealed_config: boolean;
  last_verified_at: Rfc3339 | null;
  evidence: Evidence | null;
  policy: Policy;
  budget_item_ids: Uuid[];
  strategy_version_id: Uuid | null;
  /** The agent connection that declared it; `null` when a person did. */
  declared_by_connection: Uuid | null;
  created_at: Rfc3339;
  updated_at: Rfc3339;
}

/** `jt_app::usecases::capabilities::CapabilityOut`. */
export interface CapabilityOut {
  capability: Capability;
  effective_status: EffectiveStatus;
}

/** `jt_panel_http::routes::capabilities::DeclareBody`. */
export interface DeclareInput {
  kind_key: string;
  key_detail?: string;
  name: string;
  description?: string;
  external_id?: string;
  connector_public?: Record<string, unknown>;
  policy?: Policy;
}

/**
 * `jt_app::usecases::capabilities::UpdateCapability`: each field given replaces the capability's
 * (at least one); the kind, public settings and policy are not edited this way.
 */
export interface UpdateCapabilityInput {
  name?: string;
  description?: string;
  external_id?: string;
}

/**
 * `jt_app::usecases::capabilities::UpdatedCapability`: `verification_reset` when a connector's
 * account changed, so its verification was reset and its stored credentials dropped.
 */
export interface UpdatedCapability extends CapabilityOut {
  verification_reset: boolean;
}

/** `jt_capability::CapabilityGroup`. */
export interface CapabilityGroup {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  purpose: string | null;
}

/** `jt_app::usecases::groups::GroupOut`. */
export interface GroupOut {
  group: CapabilityGroup;
  members: CapabilityOut[];
}

/** `jt_panel_http::routes::strategy::ArchivedBody`, as `jeeta.strategy.archive` answers too. */
export interface ArchivedOut {
  version_id: Uuid;
  archived: boolean;
}

/** `jt_panel_http::routes::groups::DeletedBody`. */
export interface GroupDeletedOut {
  group_id: Uuid;
  deleted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Budget (`jt_capability::budget`, `jt_app::usecases::budget`)
// ---------------------------------------------------------------------------------------------

/** `jt_capability::BudgetKind`. */
export type BudgetKind = 'cash' | 'ad_budget' | 'sms_budget' | 'agent_quota' | 'agent_hours' | 'consumable';
export const BUDGET_KINDS: readonly BudgetKind[] = [
  'cash',
  'ad_budget',
  'sms_budget',
  'agent_quota',
  'agent_hours',
  'consumable',
];

/** `jt_capability::Unit`, adjacently tagged: a currency code, a count label, or minutes. */
export type Unit =
  | { kind: 'currency'; value: string }
  | { kind: 'count'; value: string }
  | { kind: 'minutes' };
export type UnitKind = Unit['kind'];

/** `jt_capability::Period` (a budget item's period). */
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'total';
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['daily', 'weekly', 'monthly', 'total'];

/** `jt_capability::BudgetItem`: `cap` in `unit` (minor units of a currency). */
export interface BudgetItem {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  kind: BudgetKind;
  unit: Unit;
  cap: number;
  period: BudgetPeriod;
  strategy_version_id: Uuid | null;
  created_at: Rfc3339;
  /** When it was retired: it then takes no links and no spend. `null` while it is live. */
  retired_at: Rfc3339 | null;
  unit_cost_minor: number | null;
}

/** `jt_app::usecases::budget::BudgetItemInput`. */
export interface BudgetItemInput {
  name: string;
  kind: BudgetKind;
  unit: Unit;
  cap: number;
  period: BudgetPeriod;
}

/**
 * `jt_app::usecases::budget::UpdateBudgetItem`: each field given replaces the item's (at least
 * one); the kind and unit never change.
 */
export interface UpdateBudgetItemInput {
  name?: string;
  cap?: number;
  period?: BudgetPeriod;
}

/** `jt_app::usecases::budget::BudgetItemOut`: `remaining` is negative when over the cap. */
export interface BudgetItemOut {
  item: BudgetItem;
  spent_in_period: number;
  remaining: number;
}

/** `jt_capability::SpendSource`, adjacently tagged. */
export type SpendSource = { kind: 'connector'; value: string } | { kind: 'agent' } | { kind: 'human' };

/** `jt_capability::BudgetSpend`. */
export interface BudgetSpend {
  id: Uuid;
  budget_item_id: Uuid;
  workspace_id: Uuid;
  at: Rfc3339;
  amount: number;
  source: SpendSource;
  reference: string | null;
}

/** `jt_app::usecases::budget::BudgetSpendOut`. */
export interface BudgetSpendOut {
  spend: BudgetSpend;
  remaining: number;
}

// ---------------------------------------------------------------------------------------------
// Pending work (`jt_app::usecases::work`)
// ---------------------------------------------------------------------------------------------

/**
 * `jt_app::usecases::work::StrategyState`: a state without fields is its name, one with fields an
 * object under its name.
 */
export type StrategyState =
  | 'missing'
  | { draft_open: { gaps: Gap[] } }
  | { submitted: ApproveStamp }
  | { approved: { number: number } };

/** `jt_app::usecases::work::WorkKind`, tagged by `kind`. */
export type WorkKind =
  | { kind: 'consult_strategy' }
  | { kind: 'approve_strategy' }
  | { kind: 'verify_capability'; capability_id: Uuid; name: string; stale: boolean }
  | { kind: 'declare_first_capability' }
  | { kind: 'connect_connector'; capability_id: Uuid; name: string }
  | { kind: 'reconnect_connector'; capability_id: Uuid; name: string }
  /** Unprocessed inbound events, counted up to `INBOUND_EVENTS_COUNT_CAP`. */
  | { kind: 'inbound_events'; count: number }
  | { kind: 'reply_due'; conversation_id: string }
  | { kind: 'reopen_question'; conversation_id: string }
  | { kind: 'merge_suggested'; merge_id: string }
  | { kind: 'task_due'; task_id: string }
  /** A voice bridge that has not registered within its heartbeat; `last_seen_at` is its last one. */
  | { kind: 'voice_bridge_offline'; capability_id: Uuid; name: string; last_seen_at: Rfc3339 | null }
  /** A phone no device bridge has listed within its heartbeat; `last_seen_at` is the last listing. */
  | { kind: 'phone_offline'; capability_id: Uuid; name: string; last_seen_at: Rfc3339 | null }
  // The nine kinds of the leads program (spec 2026-10-30-leads-pool-outreach-design.md §3.17).
  /** An open research task may still record `remaining_today` prospects today. */
  | { kind: 'research_due'; task_id: Uuid; remaining_today: number }
  /** New prospects without a score under the approved rubric. */
  | { kind: 'prospects_to_score'; count: number }
  /** Qualified prospects waiting for promotion into the inbox. */
  | { kind: 'prospects_to_promote'; count: number }
  /** Open journeys without an owner; `oldest_journey_id` has waited longest. */
  | { kind: 'ownerless_journeys'; count: number; oldest_journey_id: Uuid | null }
  /** Assignments past their SLA after the last reassignment. */
  | { kind: 'assignment_stalled'; count: number }
  // The four outreach kinds (`jt_app::usecases::outreach::work`).
  /** Promoted ≥ 2 days ago, journey open, nothing sent yet. */
  | { kind: 'promoted_not_contacted'; count: number }
  /** A launched campaign revision waits for a human with `outreach.manage`. */
  | { kind: 'campaign_approval'; campaign_id: Uuid; revision: number }
  /** A campaign stopped by a fence or an auto-pause (`reason`). */
  | { kind: 'campaign_blocked'; campaign_id: Uuid; reason: PauseReason }
  /** Enrollments of a campaign wait for their `custom.*` values. */
  | { kind: 'personalization_due'; campaign_id: Uuid; count: number };

/** `jt_app::usecases::work::WorkItem`: the kind flattened beside its priority and hint. */
export type WorkItem = WorkKind & {
  /** 1 is the most urgent. */
  priority: number;
  /** For the agent, in English; the panel shows its own copy. */
  hint: string;
};

/** `jt_app::usecases::work::AgentState`. */
export interface AgentState {
  last_seen_at: Rfc3339 | null;
  interval_minutes: number;
  overdue: boolean;
}

/** `jt_app::usecases::work::PendingOut`. */
export interface PendingOut {
  strategy: StrategyState;
  items: WorkItem[];
  agent: AgentState;
}

/**
 * `jt_app::usecases::work::INBOUND_EVENTS_COUNT_CAP`: an `inbound_events` count of the cap means at
 * least that many.
 */
export const INBOUND_EVENTS_COUNT_CAP = 1000;

/** `jt_app::ports::{MIN,MAX}_AGENT_CHECKIN_INTERVAL_MINUTES`. */
export const MIN_CHECKIN_INTERVAL_MINUTES = 15;
export const MAX_CHECKIN_INTERVAL_MINUTES = 10_080;

// ---------------------------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------------------------

/** `jt_connector::Provider`. */
export type Provider = 'meta' | 'netgsm' | 'x' | 'mail' | 'tiktok' | 'linkedin';
export const PROVIDERS: readonly Provider[] = ['meta', 'netgsm', 'x', 'mail', 'tiktok', 'linkedin'];

/** `jt_app::usecases::connector::StartOut`: where to send the browser, until when. */
export interface StartOut {
  authorize_url: string;
  pending_id: Uuid;
  expires_at: Rfc3339;
}

/** `jt_app::ports::connectors::AssetPublic`: what the owner chooses from; never a credential. */
export interface AssetPublic {
  kind_key: string;
  external_id: string;
  name: string;
  /** The provider's public facts, e.g. a category, the granted scopes, an expiry. */
  public: unknown;
}

/** `jt_app::usecases::connector::PendingAssetsOut`. */
export interface PendingAssetsOut {
  pending_id: Uuid;
  assets: AssetPublic[];
}

/** `jt_app::usecases::connector::CredentialInput`, tagged by `kind`. */
export type CredentialInput =
  | { kind: 'mailbox'; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number; username: string; password: string; from_address: string; tls: 'implicit' | 'start_tls' }
  | { kind: 'netgsm_iys'; usercode: string; password: string; brand_code: string }
  | { kind: 'netgsm_sms'; usercode: string; password: string; msgheader: string }
  | { kind: 'netgsm_pbx'; username: string; password: string; trunk?: string; pbxnum?: string }
  | { kind: 'meta_token'; access_token: string };
export type CredentialKind = CredentialInput['kind'];

/**
 * `jt_app::usecases::connector::SetCredentials`: an existing capability (`capability_id`) or a new
 * one (`kind_key` and `name`), the account it should reach when known, and the credentials.
 */
export type SetCredentialsInput = ({ capability_id: Uuid } | { kind_key: string; name: string }) & {
  external_id?: string;
  credential: Exclude<CredentialInput, { kind: 'netgsm_iys' }>;
} | { capability_id: Uuid; external_id?: never; credential: Extract<CredentialInput, { kind: 'netgsm_iys' }> };

/** `jt_app::usecases::connector::ProbeResultPublic`: never the credential. */
export interface ProbeResultPublic {
  ok: boolean;
  latency_ms: number;
  /** `jt_connector::ConnectorError` kind of a failure. */
  error_kind: string | null;
  /** The provider's reason, redacted by the server; shown under the kind's sentence. */
  error_reason: string | null;
  facts: unknown;
}

/** `jt_app::usecases::connector::ProbeOut`. */
export interface ProbeOut {
  result: ProbeResultPublic;
  status: StoredStatus;
}

/** The purposes of NetGSM's callback URLs (`jt_connector::NetgsmPurpose`), in the server's order. */
export const NETGSM_PURPOSES = ['mo', 'events', 'iys', 'voice-report', 'autocall-report'] as const;
export type NetgsmPurpose = (typeof NETGSM_PURPOSES)[number];

/** `jt_app::usecases::connector::MetaHook`: the verify token itself is never sent. */
export interface MetaHook {
  url: string;
  verify_token_hint: string;
}

/** `jt_app::usecases::connector::NetgsmHook`: the URL carries the workspace's hook token. */
export interface NetgsmHook {
  purpose: NetgsmPurpose;
  url: string;
}

/** `jt_app::usecases::connector::TiktokHook`: the TikTok app's callback URL and the events acted on. */
export interface TiktokHook {
  url: string;
  events: string[];
}

/**
 * `jt_app::usecases::connector::HooksOut`; `meta` and `tiktok` are `null` while the platform has
 * no Meta or TikTok app (`tiktok` is absent from a server that predates TikTok's webhooks).
 */
export interface HooksOut {
  meta: MetaHook | null;
  netgsm: NetgsmHook[];
  tiktok?: TiktokHook | null;
}

/** `jt_app::usecases::connector::PbxCallMode`. */
export type PbxCallMode = 'originate' | 'linkup';

/** `jt_app::usecases::connector::PbxPolicyInput`: at least one field. */
export interface PbxPolicyInput {
  call_mode?: PbxCallMode;
  recording_allowed?: boolean;
}

/** `jt_app::usecases::connector::PbxPolicyOut`. */
export interface PbxPolicyOut {
  capability_id: Uuid;
  call_mode: PbxCallMode;
  recording_allowed: boolean;
}

/** `jt_app::usecases::connector::ConnectorHealth`. */
export interface ConnectorHealth {
  capability_id: Uuid;
  kind_key: string;
  name: string;
  /** `null` for a connector kind no provider serves yet. */
  provider: Provider | null;
  status: EffectiveStatus;
  last_probe_at: Rfc3339 | null;
  ok: boolean | null;
  error_kind: string | null;
  /** The last failed probe's line, `kind: provider: reason` (≤ 300 chars, redacted); `null` after a success. */
  reason: string | null;
  token_expires_at: Rfc3339 | null;
  reconnect_required: boolean;
  /**
   * Whether it takes its comments or questions (`jt_app::usecases::inbox::public::CommentStatus`):
   * `off` until Meta approved them, `reconnect` when this account's grant lacks them; `null` for a
   * kind without comments. Absent from a server older than it.
   */
  comments?: CommentStatus | null;
  /**
   * Whether Studio can read its counters with its grant (`MeasureStatus`), for a kind Studio
   * publishes to: `reconnect` when the grant lacks the read scope; `null` for another kind.
   */
  measure?: 'on' | 'reconnect' | null;
}

export type CommentStatus = 'off' | 'reconnect' | 'on';

// Inbox: Rust domain serde enums are externally tagged, not `{ kind: … }` objects.
export type InboxQueue = 'ours' | 'unassigned' | 'snoozed' | 'all';
export type InboxSource = { channel: string } | 'meta_ads' | 'import' | 'form' | 'repeat';
export type InboxActor = 'system' | 'agent' | { human: Uuid };
/** Who wrote a message: an actor of the workspace, the customer, or the business itself from the WhatsApp Business app on its phone. */
export type InboxAuthor = InboxActor | 'customer' | 'business_app';
/** A variant of a provider's sign-in: `whatsapp_business_app` connects a number already in the WhatsApp Business app. */
export type OAuthFlow = 'whatsapp_business_app';
export interface InboxPerson {
  id: Uuid;
  workspace_id: Uuid;
  display_name: string;
  company: string;
  first_touch: { source: InboxSource; capability_id: Uuid | null; at: Rfc3339 };
  merged_into: Uuid | null;
  erased_at: Rfc3339 | null;
  created_at: Rfc3339;
  updated_at: Rfc3339;
}
/** Where a conversation happens: a direct one, comments or questions in public, or mail a marketplace relays. */
export type InboxSurface = 'private' | 'public' | 'relay';
export interface InboxConversationRow {
  id: Uuid;
  workspace_id: Uuid;
  person_id: Uuid;
  capability_id: Uuid;
  kind_key: string;
  state: 'open' | 'ours' | 'theirs' | 'closed' | { snoozed: { until: Rfc3339 } };
  executor: 'agent' | { human: { user_id: Uuid | null } };
  executor_generation: number;
  last_inbound_at: Rfc3339 | null;
  last_outbound_at: Rfc3339 | null;
  created_at: Rfc3339;
  updated_at: Rfc3339;
  /** The view's computed fields (inbox.conversations.list/get); absent on rows read elsewhere. */
  surface?: InboxSurface;
  channel?: string | null;
  owed_items?: number;
  next_deadline?: Rfc3339 | null;
  held_replies?: number;
}
export interface InboxMessage {
  id: Uuid;
  workspace_id: Uuid;
  conversation_id: Uuid;
  direction: 'inbound' | 'outbound';
  author: InboxAuthor;
  body: string;
  external_id: string | null;
  status:
    | 'received'
    | 'queued'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'unknown'
    | { refused: { reason: string } };
  cost_minor: number | null;
  at: Rfc3339;
  /** For a failed or uncertain outbound message, the recorded `kind: provider reason`. */
  failure_reason?: string | null;
  /** On a public conversation: the comment or question the message is, or our reply answers. */
  item?: { item_id: Uuid; kind: PublicKind; answer_state: PublicAnswerKey; visibility: Visibility | null };
}
export type PublicKind = 'comment' | 'question';
export type Visibility = 'public' | 'private';
export type PublicAnswerKey = 'awaiting' | 'pending' | 'answered' | 'rejected' | 'handled' | 'expired';
export type PublicModeration = 'visible' | 'hidden' | 'deleted' | 'removed' | 'reported';
export type HandledReason = 'no_reply_needed' | 'spam' | 'duplicate' | 'answered_elsewhere';
export type ReportReason = 'spam' | 'offensive' | 'personal_data' | 'irrelevant' | 'other';
export type PublicAnswer =
  | { state: 'awaiting' }
  | { state: 'pending'; message_id: Uuid }
  | { state: 'answered'; by: 'us' | 'elsewhere'; message_id: Uuid | null; at: Rfc3339 }
  | { state: 'rejected'; reason: string; message_id: Uuid | null; at: Rfc3339 }
  | { state: 'handled'; by: unknown; reason: HandledReason; at: Rfc3339 }
  | { state: 'expired'; at: Rfc3339 };
/** One comment or question of a public conversation: ids, states and times only (its text is its message's). */
export interface PublicItem {
  id: Uuid;
  workspace_id: Uuid;
  capability_id: Uuid;
  conversation_id: Uuid;
  message_id: Uuid;
  subject_id: Uuid | null;
  kind: PublicKind;
  external_id: string;
  parent_external_id: string | null;
  root_external_id: string;
  created_at: Rfc3339;
  taken_at?: Rfc3339 | null;
  deadline: Rfc3339 | null;
  private_reply_until: Rfc3339 | null;
  live: boolean;
  answer: PublicAnswer;
  moderation: PublicModeration;
  private_reply_message_id: Uuid | null;
  agent_answers: number;
  checked_at: Rfc3339 | null;
  updated_at: Rfc3339;
}
/** The post or product an item is on. */
export interface PublicSubject {
  id: Uuid;
  kind: 'post' | 'product';
  external_id: string;
  title: string;
  url: string | null;
  image_url: string | null;
  facts: Record<string, unknown>;
  publication_id: Uuid | null;
}
export interface PublicRules {
  public: { min: number; max: number };
  private: { window_s: number; max_chars: number } | null;
  one_answer: boolean;
  moderated: boolean;
  hide: boolean;
  delete: boolean;
  report: boolean;
  marketplace: boolean;
}
export interface PublicThreadEntry {
  author: 'us' | 'them' | 'other';
  text: string;
  at: Rfc3339;
  external_id: string | null;
}
/** What `inbox.context` adds for a comment or question conversation. */
export interface PublicContext {
  channel: string;
  rules: PublicRules;
  approval_required: boolean;
  hint: string;
  items: {
    item: PublicItem;
    subject: PublicSubject | null;
    thread: PublicThreadEntry[];
    private_reply_until: Rfc3339 | null;
    owed: boolean;
  }[];
}
export interface PublicDue {
  conversation_id: Uuid;
  item_id: Uuid;
  channel: string;
  awaiting_since: Rfc3339;
  deadline: Rfc3339 | null;
}
/** A held reply waiting for a human's approval. */
export interface HeldReply {
  outbox_id: Uuid;
  conversation_id: Uuid;
  item_id: Uuid | null;
  deadline: Rfc3339 | null;
}
export interface ModerationOut {
  item: PublicItem;
  outcome: 'applied' | 'unchanged' | 'skipped';
}
export type JourneyStatus =
  | 'new'
  | 'contacted'
  | 'unreachable'
  | 'appointment'
  | 'met'
  | 'quoted'
  | 'pending'
  | 'won'
  | 'lost';
export interface InboxJourney {
  id: Uuid;
  workspace_id: Uuid;
  person_id: Uuid;
  status: JourneyStatus;
  owner: Uuid | null;
  opened_at: Rfc3339;
  closed_at: Rfc3339 | null;
  updated_at: Rfc3339;
  lost_reason: { reason_key: string; reason_label: string } | null;
  unreachable_attempts: number;
  source: InboxSource;
}
export type ReportEvent =
  | { kind: 'call_made'; payload: { connected: boolean } }
  | {
      kind: 'appointment_booked' | 'meeting_held' | 'quote_accepted' | 'reopened';
      payload: Record<string, never>;
    }
  | { kind: 'won'; payload: { product: string; amount_minor: number; currency: string } }
  | { kind: 'lost'; payload: { reason_key: string } }
  | { kind: 'snoozed'; payload: { until: Rfc3339 } };
export type ReportInput = ReportEvent & { idempotency_key: string };
export type JourneyEventKind =
  | 'message_received'
  | 'replied'
  | 'appointment_booked'
  | 'meeting_held'
  | 'quote_sent'
  | 'quote_accepted'
  | 'reopened'
  | { call_made: { connected: boolean } }
  | { won: { product: string; amount_minor: number; currency: string } }
  | { lost: { reason_key: string } }
  | { snoozed: { until: Rfc3339 } }
  | { merged: { target: Uuid } };
export interface InboxEvent {
  id: Uuid;
  workspace_id: Uuid;
  journey_id: Uuid;
  source: InboxActor;
  kind: JourneyEventKind;
  idempotency_key: string;
  reason_label: string | null;
  at: Rfc3339;
}
export interface InboxTask {
  id: Uuid;
  workspace_id: Uuid;
  journey_id: Uuid;
  title: string;
  due_at: Rfc3339;
  assignee: Uuid | null;
  status: 'open' | 'done' | 'cancelled';
}
export interface InboxNote {
  id: Uuid;
  workspace_id: Uuid;
  journey_id: Uuid;
  author: InboxActor;
  text: string;
  at: Rfc3339;
}
export interface InboxJourneyOut {
  appointments: InboxAppointment[];
  /** All nine stages: the fixed Turkish defaults extended by the workspace's overrides. */
  status_labels: Record<JourneyStatus, string>;
  /** Only the labels the workspace set itself; the panel shows its own language for the rest. */
  status_label_overrides: Partial<Record<JourneyStatus, string>>;
  journey: InboxJourney;
  events: InboxEvent[];
  tasks: InboxTask[];
  notes: InboxNote[];
}
export interface InboxContext {
  status_labels: Record<JourneyStatus, string>;
  status_label_overrides: Partial<Record<JourneyStatus, string>>;
  person: InboxPerson;
  journey: InboxJourney | null;
  events: InboxEvent[];
  open_tasks: InboxTask[];
  recent_conversations: { conversation: InboxConversationRow; messages: InboxMessage[] }[];
  strategy_guidance: { summary: Identity; segments: Segment[]; hypotheses: Hypothesis[] } | null;
  prohibitions: string[];
  /** For a comment or question conversation only. */
  public?: PublicContext;
}
export interface InboxPersonOut {
  person: InboxPerson;
  identities: {
    id: Uuid;
    workspace_id: Uuid;
    person_id: Uuid;
    channel: string;
    value_normalized: string;
    value_display: string;
    active: boolean;
    first_seen_at: Rfc3339;
  }[];
  open_journey: InboxJourney | null;
  conversations: InboxConversationRow[];
}
export type MergeConflict = 'two_open_journeys' | 'display_name' | 'email' | 'phone' | 'company';
export interface InboxMerge {
  id: Uuid;
  workspace_id: Uuid;
  source_id: Uuid;
  target_id: Uuid;
  decision: { auto: { keep: Uuid; merge: Uuid } } | { suggest: MergeConflict[] };
  conflicts: MergeConflict[];
  status: string;
  moved_snapshot: unknown;
  at: Rfc3339;
  applied_by: Uuid | null;
  undone_at: Rfc3339 | null;
}
export interface InboxLostReason {
  workspace_id: Uuid;
  key: string;
  label: string;
  active: boolean;
  seeded: boolean;
}
export interface InboxPageOut<T> {
  items: T[];
  next_cursor: string | null;
}
export interface InboxPendingOut {
  ours: InboxConversationRow[];
  reopen_questions: InboxConversationRow[];
  merges: InboxMerge[];
  tasks_due: InboxTask[];
  public_due?: PublicDue[];
  /** Held replies; listed to human callers only. */
  approvals?: HeldReply[];
}
export interface InboxReplyOut {
  message_id: Uuid;
  state: string;
}
export type InboxJourneyEffect =
  | 'conversation_ours'
  | 'conversation_theirs'
  | 'close_tasks'
  | 'close_conversations'
  | 'cancel_open_tasks'
  | { conversation_snoozed: { until: Rfc3339 } }
  | { commission_due: { amount_minor: number; currency: string } };
export interface InboxReportOut {
  transition: {
    from: JourneyStatus;
    patch: Pick<InboxJourney, 'status' | 'unreachable_attempts' | 'closed_at' | 'lost_reason' | 'updated_at'>;
    effects: InboxJourneyEffect[];
  } | null;
  effects: InboxJourneyEffect[];
  duplicate: boolean;
}

export type CommissionState = 'no_payee' | 'pending' | 'approved' | 'paid';
export interface InboxCommission {
  id: string;
  workspace_id: string;
  journey_id: string;
  payee: string | null;
  amount_minor: number;
  currency: string;
  rate_bp: number;
  state: CommissionState;
  created_at: string;
}

// Mirrors usecases/inbox/schema.rs; both transports validate these same request fields.
export type ContactChannel = 'sms' | 'email' | 'phone' | 'whats_app' | 'messenger' | 'instagram_dm' | 'webchat';
export type SendChannel = Exclude<ContactChannel, 'phone' | 'webchat'>;
export type SendIntent = 'reply' | 'commercial';
export interface ConsentInput {
  channel: ContactChannel;
  kind: 'explicit' | 'implied_by_contract' | 'withdrawn';
  source: 'form' | 'agent' | 'import' | 'iys_sync' | 'customer';
  at: string;
}
export type SuppressionReason = 'manual' | 'unsubscribe' | 'bounce' | 'complaint';
export interface ConsentList {
  consents: (ConsentInput & { id: string; sync_state: 'pending' | 'sent' | 'failed' | 'failed_final' })[];
  suppressions: { channel: ContactChannel; reason: SuppressionReason }[];
}
export interface QuoteInput {
  amount_minor: number;
  currency: string;
  valid_until: string;
  file_ref: string | null;
  channel: SendChannel;
  text: string;
  intent: SendIntent;
  request_key?: string;
}
export interface InboxQuote {
  id: string;
  amount_minor: number;
  currency: string;
  valid_until: string;
  file_ref: string | null;
  state: 'sent' | 'accepted' | 'expired';
}
export interface AppointmentInput {
  starts_at: string;
  ends_at: string;
  location: string;
  intent: SendIntent;
}
export interface InboxAppointment extends Omit<AppointmentInput, 'intent'> {
  id: string;
  state: 'booked' | 'held' | 'cancelled';
}

/** Operator-only payment evidence and one-time delivery responses. */
export interface PlatformEntitlement {
  id: string; source: 'paid' | 'grandfathered'; payment_id: string | null;
  confirmed_at: string; activated_at: string | null; revoked_at: string | null;
}
export interface PlatformPayment {
  workspace_id: string; payment_id: string; reference: string; amount_minor: number;
  currency: string; paid_at: string; reported_at: string; entitlement: PlatformEntitlement | null;
}
export interface ActivationDelivery { code: string; expires_at: string }
export interface PlatformConfirmation {
  workspace: WorkspaceAdminOut; entitlement: PlatformEntitlement; activation: ActivationDelivery | null;
}
export type HealthState = 'ok' | 'degraded' | 'unknown';
export interface OpsHealthOut {
  observed_at: string; process_started_at: string; history: string; boot_complete: boolean;
  database: HealthState; files: HealthState; disk: HealthState; disk_available_bytes: number | null;
  database_pool_size: number; database_pool_idle: number; connectors_state: HealthState;
  jobs: { name: string; last_success_at: string | null; failed_total: number }[];
  connectors: { workspace_id: string; kind_key: string; reconnect_required: number; expires_before: string | null }[];
  webhooks: { accepted: number; unrouted: number; unresolved: number };
  backup: { last_backup_at: string | null; last_wal_archive_at: string | null; backup_state: HealthState; wal_state: HealthState };
}

// ---------------------------------------------------------------------------------------------
// Leads: the prospect pool, research tasks, distribution and outreach (spec
// `docs/superpowers/specs/2026-10-30-leads-pool-outreach-design.md`). Each type names its Rust
// source; the routes are spec §7.1's.
// ---------------------------------------------------------------------------------------------

/** `jt_prospects::ProspectStatus`. */
export type ProspectStatus = 'new' | 'qualified' | 'rejected' | 'promoted' | 'do_not_contact';
export const PROSPECT_STATUSES: readonly ProspectStatus[] = ['new', 'qualified', 'rejected', 'promoted', 'do_not_contact'];

/** `jt_prospects::EntityKind`. */
export type EntityKind = 'legal_entity' | 'sole_trader' | 'unknown_business';

/** `jt_prospects::RejectReason`; `other` needs a note. */
export type RejectReason =
  | 'not_icp'
  | 'closed_business'
  | 'no_contact_data'
  | 'competitor'
  | 'already_customer'
  | 'duplicate'
  | 'other';
export const REJECT_REASONS: readonly RejectReason[] = [
  'not_icp',
  'closed_business',
  'no_contact_data',
  'competitor',
  'already_customer',
  'duplicate',
  'other',
];

/** `jt_prospects::DncReason`. */
export type DncReason = 'objected' | 'legal' | 'other';
export const DNC_REASONS: readonly DncReason[] = ['objected', 'legal', 'other'];

/** `jt_prospects::KeyKind`: the first four are hard keys (the blocklist holds only those). */
export type KeyKind = 'phone' | 'email' | 'instagram' | 'tiktok' | 'domain' | 'name_city';

/** `jt_prospects::Bucket`, serialised as its range. */
export type ScoreBucket = '0-24' | '25-49' | '50-74' | '75-100';
export const SCORE_BUCKETS: readonly ScoreBucket[] = ['0-24', '25-49', '50-74', '75-100'];

/** `jt_prospects::SourceRef`, tagged by `kind`: where a value was seen. */
export type SourceRef =
  | { kind: 'url'; url: string; note?: string | null }
  | { kind: 'manual'; note: string }
  | { kind: 'import'; system: string; record: string };

/** `jt_prospects::Recorder`, tagged by `kind`: who recorded a value (never input). */
export type Recorder =
  | { kind: 'agent'; connection_id: Uuid; user_id: Uuid }
  | { kind: 'human'; user_id: Uuid }
  | { kind: 'import'; system: string; record: string }
  | { kind: 'system'; job: string };

/** `jt_prospects::Evidence` (named apart from the capabilities' `Evidence`). */
export interface FieldEvidence {
  sources: SourceRef[];
  captured_at: Rfc3339;
  recorder: Recorder;
}

/** `jt_prospects::Field<T>`: a value with its evidence. */
export interface ProspectField<T> {
  value: T;
  evidence: FieldEvidence;
  /** False once a bounce (or a `tr444:` phone) made it unusable for contact. */
  deliverable: boolean;
}

/** `jt_prospects::ContactPerson`. */
export interface ContactPerson {
  name: string;
  role: string;
}

/** `jt_prospects::ContactFields`. */
export interface ContactFields {
  phone?: ProspectField<string> | null;
  email?: ProspectField<string> | null;
  website?: ProspectField<string> | null;
  instagram?: ProspectField<string> | null;
  tiktok?: ProspectField<string> | null;
  address?: ProspectField<string> | null;
  contact_person?: ProspectField<ContactPerson> | null;
}

/** `jt_prospects::EmployeeBand`. */
export type EmployeeBand = '1-9' | '10-49' | '50-249' | '250+';

/** `jt_prospects::SizeHint`. */
export interface SizeHint {
  branches?: number | null;
  employees?: EmployeeBand | null;
  note?: string | null;
}

/** `jt_prospects::Signal`. */
export interface Signal {
  text: string;
  source: SourceRef;
}

/** `jt_prospects::OriginVia`. */
export type OriginVia = 'research_task' | 'manual' | 'agent' | 'v1_import' | 'system';

/** `jt_prospects::Origin`. */
export interface Origin {
  via: OriginVia;
  discovered_at: SourceRef[];
  distinct_from: Uuid[];
  recorder: Recorder;
  at: Rfc3339;
}

/** `jt_prospects::ScoreSummary`. */
export interface ScoreSummary {
  score: number;
  digest: string;
  at: Rfc3339;
}

/** `jt_prospects::DecisionKind` (externally tagged). */
export type DecisionKind = { rejected: RejectReason } | { do_not_contact: DncReason };

/** `jt_prospects::Decision`. */
export interface Decision {
  kind: DecisionKind;
  note: string;
  by: Recorder;
  at: Rfc3339;
}

/** `jt_prospects::Promotion`: the score at promotion is frozen here. */
export interface Promotion {
  person_id: Uuid;
  journey_id: Uuid;
  at: Rfc3339;
  score: number | null;
  bucket: ScoreBucket | null;
}

/** `jt_prospects::Prospect` (spec §3.1). */
export interface Prospect {
  id: Uuid;
  workspace_id: Uuid;
  status: ProspectStatus;
  business_name: string;
  entity_kind: EntityKind;
  sector: string | null;
  city: string | null;
  district: string | null;
  country: string;
  language: string | null;
  segment_key: string | null;
  labels: string[];
  contact: ContactFields;
  size: ProspectField<SizeHint> | null;
  signals: Signal[];
  notes: string;
  origin: Origin;
  research_task_id: Uuid | null;
  latest_score: ScoreSummary | null;
  decision: Decision | null;
  promoted: Promotion | null;
  purge_after: Rfc3339 | null;
  revision: number;
  created_at: Rfc3339;
  updated_at: Rfc3339;
}

/** `jt_prospects::FieldName`. */
export type ProspectFieldName =
  | 'sector'
  | 'city'
  | 'district'
  | 'language'
  | 'segment_key'
  | 'labels'
  | 'phone'
  | 'email'
  | 'website'
  | 'instagram'
  | 'tiktok'
  | 'address'
  | 'contact_person'
  | 'size'
  | 'signals'
  | 'notes';

/** `jt_app::ports::prospects::ProspectRow`: a list row, without contact values or evidence. */
export interface ProspectRow {
  id: Uuid;
  status: ProspectStatus;
  business_name: string;
  entity_kind: EntityKind;
  sector: string | null;
  city: string | null;
  district: string | null;
  country: string;
  language: string | null;
  segment_key: string | null;
  labels: string[];
  research_task_id: Uuid | null;
  latest_score: ScoreSummary | null;
  bucket: ScoreBucket | null;
  /** The fields that hold a value. */
  fields: ProspectFieldName[];
  promoted: Promotion | null;
  revision: number;
  decided_at: Rfc3339 | null;
  purge_after: Rfc3339 | null;
  created_at: Rfc3339;
  updated_at: Rfc3339;
}

/** `jt_app::usecases::prospects::DuplicateCandidate`. */
export interface DuplicateCandidate {
  prospect_id: Uuid;
  business_name: string;
  city: string | null;
  status: ProspectStatus;
  /** The soft keys it shares: `domain`, `name_city`. */
  matched: KeyKind[];
}

/** `jt_app::usecases::prospects::Flag`, tagged by `flag`: a soft key shared, never a refusal. */
export type ProspectFlag =
  | { flag: 'possible_duplicate'; candidates: DuplicateCandidate[] }
  | { flag: 'previously_rejected_soft'; candidates: DuplicateCandidate[] };

/** `jt_app::usecases::prospects::ProspectOut`. */
export interface ProspectOut {
  prospect: Prospect;
  flags: ProspectFlag[];
}

/** `jt_app::usecases::prospects::NextPage`: pass both back as `before_at` and `before_id`. */
export interface NextPage {
  before_at: string;
  before_id: Uuid;
}

/** `jt_app::usecases::prospects::ListInput` (query string). */
export interface ProspectListQuery {
  status?: ProspectStatus;
  research_task_id?: Uuid;
  city?: string;
  segment_key?: string;
  bucket?: ScoreBucket;
  /** `1..=200`, 50 unless given. */
  limit?: number;
  before_at?: string;
  before_id?: Uuid;
}

/** `jt_app::usecases::prospects::ListOut`. */
export interface ProspectListOut {
  items: ProspectRow[];
  next: NextPage | null;
}

/** `jt_prospects::Reason`: one criterion's points and why. */
export interface ScoreReason {
  criterion: string;
  points: number;
  evidence: string;
  source?: SourceRef | null;
}

/** `jt_app::ports::prospects::ScoreRow`. */
export interface ScoreRow {
  id: Uuid;
  prospect_id: Uuid;
  score: number;
  reasons: ScoreReason[];
  rubric_digest: string;
  strategy_version_id: Uuid | null;
  recorder: Recorder;
  at: Rfc3339;
}

/** `jt_app::usecases::prospects::GetOut`. */
export interface ProspectGetOut {
  prospect: Prospect;
  /** The latest scores, newest first. */
  scores: ScoreRow[];
  /** Prospects sharing a soft key with it now. */
  duplicate_candidates: DuplicateCandidate[];
  /** The pool's ledger entries about it, newest first. */
  ledger: LedgerEntryOut[];
}

/** `jt_app::usecases::prospects::CheckInput`. */
export interface ProspectCheckInput {
  business_name?: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  instagram?: string;
  tiktok?: string;
  distinct_from?: Uuid[];
}

/** `jt_app::usecases::prospects::CheckOut`: `ok`, or the refusal's details beside it. */
export type ProspectCheckOut = { ok: boolean; flags: ProspectFlag[] } & Record<string, unknown>;

/** `jt_app::usecases::prospects::DecideKind`. */
export type DecideKind = 'qualify' | 'reject' | 'reopen';

/** `jt_app::usecases::prospects::DecideInput`. */
export interface DecideInput {
  decision: DecideKind;
  reason?: RejectReason;
  /** At most 500 characters; required for the reason `other`. */
  note?: string;
  expected_revision: number;
}

/** `jt_app::usecases::prospects::ScoreOut`. */
export interface ScoreOut {
  score: ScoreRow;
  status: ProspectStatus;
  qualified: boolean;
}

/** `jt_app::usecases::prospects::RawKey`. */
export interface RawKey {
  kind: KeyKind;
  value: string;
}

/** `jt_app::usecases::prospects::DncInput`: a prospect, or raw hard keys. */
export interface DncInput {
  confirm: true;
  prospect_id?: Uuid;
  keys?: RawKey[];
  reason: DncReason;
  note?: string;
}

/** `jt_app::usecases::prospects::DncOut`. */
export interface DncOut {
  prospect_id: Uuid | null;
  prospects: Uuid[];
  /** Inbox people of promoted holders: record the objection on them too. */
  people: Uuid[];
  kinds: KeyKind[];
}

/** `jt_app::usecases::prospects::LiftOut`. */
export interface LiftOut {
  kind: KeyKind;
  lifted: boolean;
}

/** `jt_app::usecases::prospects::EraseOut`. */
export interface EraseOut {
  prospect_id: Uuid;
  erased: boolean;
  kinds: KeyKind[];
}

/** `jt_app::usecases::prospects::PromoteOutcome`, tagged by `outcome`. */
export type PromoteOutcome =
  | {
      outcome: 'promoted';
      prospect_id: Uuid;
      person_id: Uuid;
      journey_id: Uuid;
      created_person: boolean;
      owner_id: Uuid | null;
    }
  | { outcome: 'already_promoted'; prospect_id: Uuid; person_id: Uuid; journey_id: Uuid }
  | { outcome: 'refused'; prospect_id: Uuid; reason: string; details?: unknown };

/** `jt_app::usecases::prospects::PromoteInput`: 1 to 50 prospects. */
export interface PromoteInput {
  prospect_ids: Uuid[];
  request_key?: string;
}

/** `jt_app::usecases::prospects::PromoteOut`: one outcome per prospect, in order. */
export interface PromoteOut {
  items: PromoteOutcome[];
}

/** `jt_prospects::ProspectsPolicy`. */
export interface ProspectsPolicy {
  rejected_retention_days: number;
  unpromoted_retention_days: number;
  rejected_memory_days: number;
  max_promotions_per_day: number;
  agents_promote_qualified_only: boolean;
}

/** `jt_app::usecases::prospects::SettingsOut`: the policy flattened beside the time zone. */
export type PoolSettingsOut = ProspectsPolicy & { timezone: string };

/** `jt_app::usecases::prospects::SettingsInput`: the keys to change. */
export type PoolSettingsInput = Partial<PoolSettingsOut>;

/** `jt_strategy::Area`. */
export interface Area {
  city: string;
  district: string | null;
}

/** `jt_strategy::IcpEntry`. */
export interface IcpEntry {
  key: string;
  segment_key: string;
  sectors: string[];
  areas: Area[];
  signals: string[];
  exclusions: string[];
  size_hint: string;
  language: string | null;
  daily_cap: number;
  backlog_target: number;
}

/** `jt_strategy::Criterion`. */
export interface Criterion {
  key: string;
  description: string;
  weight: number;
}

/** `jt_strategy::Rubric`. */
export interface Rubric {
  criteria: Criterion[];
  qualify_at: number;
}

/** `jt_app::usecases::prospects::PlaybookOut` (spec §3.8). */
export interface PlaybookOut {
  version: number;
  text: string;
  workspace: {
    prospecting_on: boolean;
    icp: IcpEntry[];
    rubric: Rubric;
    rubric_digest: string | null;
    caps: {
      timezone: string;
      daily_prospects: number;
      recorded_today: number;
      max_promotions_per_day: number;
      resets_at: string;
    };
    remaining_today: { task_id: Uuid; icp_key: string | null; remaining: number }[];
    retention_days: { rejected: number; unpromoted: number; rejected_memory: number };
    blocklist_rules: { listed: KeyKind[]; flagged: KeyKind[] };
  };
}

/** `jt_prospects::TaskStatus`. */
export type TaskStatus = 'open' | 'done' | 'canceled' | 'superseded';
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'canceled', 'superseded'];

/** `jt_prospects::TaskKind`, tagged by `type`. */
export type TaskKind = { type: 'standing'; icp_key: string } | { type: 'ad_hoc'; target_count: number };

/** `jt_prospects::Brief`: what to look for, where, and what disqualifies. */
export interface Brief {
  segment_key: string | null;
  sectors: string[];
  areas: Area[];
  signals: string[];
  exclusions: string[];
  size_hint: string;
  language: string | null;
  note: string;
}

/** `jt_prospects::Claim`: an advisory lease. */
export interface Claim {
  by: Recorder;
  until: Rfc3339;
}

/** `jt_prospects::ResearchTask`. */
export interface ResearchTask {
  id: Uuid;
  workspace_id: Uuid;
  kind: TaskKind;
  strategy_version_id: Uuid;
  brief: Brief;
  rubric_digest: string;
  daily_cap: number;
  status: TaskStatus;
  claim: Claim | null;
  created_by: Recorder;
  created_at: Rfc3339;
  closed_at: Rfc3339 | null;
  close_note: string;
}

/** `jt_app::usecases::research::TaskOut`. */
export interface TaskOut {
  task: ResearchTask;
  remaining_today: number;
}

/** `jt_app::usecases::research::ListOut`. */
export interface TaskListOut {
  items: TaskOut[];
  next: NextPage | null;
}

/** `jt_app::usecases::research::GetOut`. */
export interface TaskGetOut {
  task: ResearchTask;
  remaining_today: number;
  /** Prospects recorded with this task. */
  found: number;
  /** Its 20 newest prospects. */
  prospects: ProspectRow[];
}

/** `jt_app::usecases::research::CreateInput`: an ad-hoc task. */
export interface TaskCreateInput {
  brief: Brief;
  /** `1..=500`. */
  target_count: number;
  /** `1..=500` a local day. */
  daily_cap: number;
  request_key?: string;
}

/** `jt_app::usecases::research::ClaimOut`. */
export interface ClaimOut {
  task_id: Uuid;
  claimed: boolean;
  claim: Claim;
  held_by_other: boolean;
}

/** `jt_app::usecases::research::CloseInput`. */
export interface TaskCloseInput {
  outcome: 'done' | 'canceled';
  note?: string;
}

/** `jt_app::ports::DistributionMode`. */
export type DistributionMode = 'auto' | 'manual';

/** `jt_inbox::SourceKind`: where a journey came from, as distribution matches it. */
export type LeadSourceKind = 'prospect' | 'channel' | 'meta_ads' | 'form' | 'import' | 'repeat';
export const LEAD_SOURCE_KINDS: readonly LeadSourceKind[] = ['prospect', 'channel', 'meta_ads', 'form', 'import', 'repeat'];

/** `jt_inbox::Match`: an empty list matches anything. */
export interface RuleMatch {
  sources: LeadSourceKind[];
  cities: string[];
  sectors: string[];
  languages: string[];
  segments: string[];
  min_score: number | null;
}

/** `jt_inbox::MemberPool`, tagged by `kind`. */
export type MemberPool = { kind: 'members'; user_ids: Uuid[] } | { kind: 'all_eligible' };

/** `jt_inbox::Method`. */
export type DistributionMethod = 'round_robin' | 'least_loaded';

/** `jt_inbox::Rule`. */
export interface DistributionRule {
  id: Uuid;
  name: string;
  enabled: boolean;
  when: RuleMatch;
  to: MemberPool;
  method: DistributionMethod;
  sla_minutes: number | null;
  cursor: Uuid | null;
}

/** `jt_app::usecases::distribution::RuleInput`: an `id` it already has keeps its cursor. */
export interface RuleInput {
  id?: Uuid;
  name: string;
  enabled: boolean;
  when: RuleMatch;
  to: MemberPool;
  method: DistributionMethod;
  /** `5..=10080` working minutes. */
  sla_minutes?: number | null;
}

/** `jt_app::usecases::distribution::RulesSetInput`: the whole ordered set. */
export interface RulesSetInput {
  rules: RuleInput[];
  mode?: DistributionMode;
  /** `0..=10`. */
  max_reassignments?: number;
}

/** `jt_inbox::RepProfile`. */
export interface RepProfile {
  user_id: Uuid;
  accepting: boolean;
  max_open: number | null;
  languages: string[];
  cities: string[];
  sectors: string[];
  hours: Hours | null;
  away_until: Rfc3339 | null;
  updated_at: Rfc3339;
}

/** `jt_app::usecases::distribution::RepSetInput`: the profile, replaced whole. */
export interface RepSetInput {
  accepting: boolean;
  /** `1..=10000`. */
  max_open?: number | null;
  languages: string[];
  cities: string[];
  sectors: string[];
  hours?: Hours | null;
  away_until?: Rfc3339 | null;
}

/** `jt_app::usecases::distribution::RepOut`. */
export interface RepOut {
  user_id: Uuid;
  display_name: string | null;
  role_key: string;
  profile: RepProfile;
  open_owned: number;
  on_shift: boolean;
  /** Takes a new journey now. */
  eligible: boolean;
}

/** `jt_app::usecases::distribution::DistributionOut`. */
export interface DistributionOut {
  mode: DistributionMode;
  max_reassignments: number;
  rules: DistributionRule[];
  /** The active members who hold `inbox.work`. */
  reps: RepOut[];
  ownerless: { count: number; oldest_journey_id: Uuid | null };
  stalled: number;
}

/** `jt_inbox::Cause`. */
export type AssignmentCause =
  | 'rule'
  | 'default'
  | 'manual'
  | 'sla_reassign'
  | 'member_left'
  | 'import'
  | 'no_eligible';

/** `jt_app::ports::distribution::AssignmentRow`. */
export interface AssignmentRow {
  id: Uuid;
  journey_id: Uuid;
  user_id: Uuid | null;
  cause: AssignmentCause;
  rule_id: Uuid | null;
  assigned_at: Rfc3339;
  sla_due_at: Rfc3339 | null;
  acted_at: Rfc3339 | null;
  superseded_at: Rfc3339 | null;
  by: Actor;
}

/** `jt_app::ports::distribution::AssignmentCursor`. */
export interface AssignmentCursor {
  assigned_at: Rfc3339;
  id: Uuid;
}

/** `jt_app::usecases::distribution::AssignmentsListInput` (query string). */
export interface AssignmentsQuery {
  journey_id?: Uuid;
  user_id?: Uuid;
  limit?: number;
  before_at?: Rfc3339;
  before_id?: Uuid;
}

/** `jt_app::usecases::distribution::AssignmentsOut`. */
export interface AssignmentsOut {
  items: AssignmentRow[];
  next: AssignmentCursor | null;
}

/** `jt_app::usecases::distribution::Distributed`. */
export interface Distributed {
  assigned: number;
  no_eligible: number;
  imported: number;
  reassigned: number;
  kept: number;
}

/** `jt_inbox::RecipientKind`. */
export type RecipientKind = 'unknown' | 'business' | 'individual';

/** `jt_inbox::CommercialBasis`. */
export type CommercialBasis = 'consent' | 'business_recipient';

/** `jt_outreach::Lang`. */
export type TemplateLang = 'tr' | 'en';

/** `jt_outreach::Var` keys a template may use (and `custom.<key>`). */
export const TEMPLATE_VARS = [
  'first_name',
  'contact_name',
  'company',
  'city',
  'district',
  'sector',
  'sender_name',
  'sender_company',
] as const;

/** `jt_outreach::Template`. */
export interface OutreachTemplate {
  id: Uuid;
  name: string;
  language: TemplateLang;
  subject: string;
  body: string;
  revision: number;
  archived: boolean;
}

/** `jt_outreach::TemplateFacts`: the variables (as keys) and the body's links. */
export interface TemplateFacts {
  vars: string[];
  links: string[];
}

/** `jt_app::usecases::outreach::TemplateOut`. */
export interface TemplateOut {
  template: OutreachTemplate;
  facts: TemplateFacts;
  updated_at: Rfc3339;
}

/** `jt_app::usecases::outreach::TemplateSaveInput`: a new template, or a new revision. */
export interface TemplateSaveInput {
  template_id?: Uuid;
  expected_revision?: number;
  name: string;
  language: TemplateLang;
  subject: string;
  body: string;
  request_key?: string;
}

/** `jt_app::usecases::outreach::TemplateListOut`. */
export interface TemplateListOut {
  items: TemplateOut[];
  next: { before_at: string; before_id: Uuid } | null;
}

/** `jt_outreach::StepSnapshot`: a step's content frozen at launch. */
export interface StepSnapshot {
  template_revision: number;
  subject: string;
  body: string;
  links: string[];
  language: TemplateLang;
}

/** `jt_outreach::Step`. */
export interface CampaignStep {
  template_id: Uuid;
  /** 0 for the first step, then `1..=30`. */
  delay_days: number;
  same_thread: boolean;
  snapshot?: StepSnapshot | null;
}

/** `jt_outreach::Schedule`. */
export interface CampaignSchedule {
  start_at?: Rfc3339 | null;
  window: Hours;
}

/** `jt_outreach::Throttle`: per hour `1..=60`, per day `1..=500`. */
export interface Throttle {
  per_hour: number;
  per_day: number;
}

/** `jt_outreach::OwnerFilter`, tagged by `kind`. */
export type OwnerFilter = { kind: 'user'; user_id: Uuid } | { kind: 'unowned' };

/** `jt_outreach::PeopleFilter`. */
export interface PeopleFilter {
  journey_statuses?: JourneyStatus[];
  owner?: OwnerFilter | null;
  source_kinds?: LeadSourceKind[];
  recipient_kind?: RecipientKind | null;
  segments?: string[];
  cities?: string[];
  sectors?: string[];
  opened_after?: Rfc3339 | null;
  opened_before?: Rfc3339 | null;
}

/** `jt_outreach::ProspectFilter`: over qualified prospects, promoted at enrollment. */
export interface ProspectFilter {
  segment_keys?: string[];
  research_task_ids?: Uuid[];
  cities?: string[];
  sectors?: string[];
  min_score?: number | null;
}

/** `jt_outreach::Audience`. */
export interface Audience {
  people?: PeopleFilter | null;
  prospects?: ProspectFilter | null;
  explicit: Uuid[];
}

/** `jt_outreach::Definition`. */
export interface CampaignDefinition {
  sender_name: string;
  steps: CampaignStep[];
  audience: Audience;
  schedule: CampaignSchedule;
  throttle: Throttle;
  click_tracking: boolean;
  evergreen: boolean;
  segment_key?: string | null;
}

/** `jt_outreach::CampaignStatus`. */
export type CampaignStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'canceled';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'awaiting_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'canceled',
];

/** `jt_outreach::PauseReason`. */
export type PauseReason = 'manual' | 'bounce_rate' | 'complaints' | 'mailbox_down' | 'strategy_changed';

/** `jt_outreach::Approval`: bound to one revision. */
export interface Approval {
  revision: number;
  by: Uuid;
  at: Rfc3339;
}

/** `jt_app::ports::outreach::CampaignRow`. */
export interface CampaignRow {
  id: Uuid;
  name: string;
  mailbox_id: Uuid;
  status: CampaignStatus;
  definition: CampaignDefinition;
  revision: number;
  approval: Approval | null;
  pause_reason: PauseReason | null;
  strategy_version_id: Uuid;
  created_by: Actor;
  created_at: Rfc3339;
  updated_at: Rfc3339;
  launched_at: Rfc3339 | null;
  completed_at: Rfc3339 | null;
}

/** `jt_app::usecases::outreach::EnrollOut`. */
export interface EnrollOut {
  campaign_id: Uuid | null;
  enrolled: number;
  /** By skip reason. */
  skipped: Record<string, number>;
  already_enrolled: number;
  promoted: number;
  waiting_for_promotion: number;
  truncated: boolean;
}

/** `jt_app::usecases::outreach::CampaignOut`. */
export interface CampaignOut {
  campaign: CampaignRow;
  approval_required: boolean;
  active_enrollments: number;
  /** What a launch (or the approval that starts it) enrolled. */
  enrollment?: EnrollOut;
}

/** `jt_app::usecases::outreach::CampaignListOut`. */
export interface CampaignListOut {
  items: CampaignRow[];
  next: { before_at: string; before_id: Uuid } | null;
}

/** `jt_app::usecases::outreach::CampaignSaveInput`: a new campaign, or a new revision. */
export interface CampaignSaveInput {
  campaign_id?: Uuid;
  expected_revision?: number;
  name: string;
  mailbox_id: Uuid;
  definition: CampaignDefinition;
  request_key?: string;
}

/** `jt_app::usecases::outreach::ControlAction`. */
export type ControlAction = 'pause' | 'resume' | 'cancel';

/** `jt_outreach::SkipReason`. */
export type SkipReason =
  | 'no_deliverable_email'
  | 'suppressed'
  | 'no_basis'
  | 'do_not_contact'
  | 'active_elsewhere'
  | 'person_gone'
  | 'journey_closed'
  | 'promotion_cap';

/** `jt_app::usecases::outreach::PreviewOut`: computed as enrollment would, nothing written. */
export interface PreviewOut {
  eligible: number;
  by_skip_reason: Record<string, number>;
  basis: { consent: number; business_recipient: number };
  promotions_needed: number;
  business_basis_in_force: boolean;
  truncated: boolean;
}

/** `jt_outreach::EnrollmentStatus`. */
export type EnrollmentStatus = 'active' | 'completed' | 'stopped' | 'skipped';

/** `jt_app::ports::outreach::EnrollmentRow`; `stop` is a `StopReason` key (`refused:<key>`, …). */
export interface EnrollmentRow {
  id: Uuid;
  campaign_id: Uuid;
  person_id: Uuid;
  journey_id: Uuid | null;
  prospect_id: Uuid | null;
  status: EnrollmentStatus;
  stop: string | null;
  skip: SkipReason | null;
  next_step: number;
  next_send_at: Rfc3339 | null;
  personalization: Record<string, string>;
  basis: CommercialBasis | null;
  enrolled_at: Rfc3339;
  stopped_at: Rfc3339 | null;
  last_sent_at: Rfc3339 | null;
}

/** `jt_app::usecases::outreach::EnrollmentListOut`. */
export interface EnrollmentListOut {
  items: EnrollmentRow[];
  next: Uuid | null;
}

/** `jt_app::usecases::outreach::EnrollInput`: the audience, or people, or prospects. */
export interface EnrollInput {
  audience?: boolean;
  person_ids?: Uuid[];
  prospect_ids?: Uuid[];
}

/** `jt_app::usecases::outreach::PersonalizeInput`: 1 to 100 items. */
export interface PersonalizeInput {
  items: { enrollment_id: Uuid; values: Record<string, string> }[];
}

/** `jt_outreach::LegalAck`: the owner's record of the counsel's confirmation. */
export interface LegalAck {
  counsel_confirmed: boolean;
  note: string;
  by: Uuid;
  at: Rfc3339;
}

/** `jt_outreach::WarmupPolicy`. */
export interface WarmupPolicy {
  enabled: boolean;
  start: number;
  step: number;
  max: number;
}

/** `jt_outreach::Frequency`. */
export interface Frequency {
  min_gap_days: number;
  max_per_30_days: number;
}

/** `jt_outreach::OutreachPolicy`. */
export interface OutreachPolicy {
  requires_approval: boolean;
  /** Channels with the business-recipient basis (email only; off by default). */
  b2b_basis: ContactChannel[];
  require_iys_lookup: boolean;
  legal_ack: LegalAck | null;
  sender_company: string;
  sender_address: string;
  privacy_notice_url: string;
  warmup: WarmupPolicy;
  frequency: Frequency;
  click_tracking_default: boolean;
}

/** `jt_app::usecases::outreach::SettingsOut`: the policy flattened beside what follows from it. */
export type OutreachSettingsOut = OutreachPolicy & {
  sender_identity_complete: boolean;
  /** `JEETA_OUTREACH_ENABLED`: while off, nothing launches. */
  platform_enabled: boolean;
  b2b_channels_in_force: ContactChannel[];
};

/** `jt_app::usecases::outreach::SettingsInput`: the keys to change. */
export interface OutreachSettingsInput {
  requires_approval?: boolean;
  b2b_basis?: ContactChannel[];
  require_iys_lookup?: boolean;
  legal_ack?: { counsel_confirmed: boolean; note: string };
  sender_company?: string;
  sender_address?: string;
  privacy_notice_url?: string;
  warmup?: Partial<WarmupPolicy>;
  frequency?: Partial<Frequency>;
  click_tracking_default?: boolean;
}

/** `jt_app::usecases::outreach::report::GroupBy`. */
export type OutreachReportGroup = 'campaign' | 'step' | 'template';

/** `jt_app::usecases::outreach::report::ReportGroup`: one group's counts. */
export interface OutreachReportRow {
  /** Set when grouped by campaign or step. */
  campaign_id: Uuid | null;
  /** Set when grouped by step. */
  step: number | null;
  /** Set when grouped by step or template. */
  template_id: Uuid | null;
  enrolled: number;
  /** By skip reason key. */
  skipped: Record<string, number>;
  sent: number;
  unknown: number;
  failed: number;
  refused: number;
  bounced: number;
  complained: number;
  replied: number;
  replied_threaded: number;
  replied_unthreaded: number;
  unsubscribed: number;
  /** `null` while no campaign of the group tracks clicks. */
  unique_clicks: number | null;
  automated_clicks: number;
  meetings_30d: number;
  won_30d: number;
  /** By stop reason key. */
  stopped: Record<string, number>;
}

/** `jt_app::usecases::outreach::report::ReportOut` over `[from, to)`. */
export interface OutreachReportOut {
  from: Rfc3339;
  to: Rfc3339;
  campaign_id: Uuid | null;
  group_by: OutreachReportGroup;
  groups: OutreachReportRow[];
  truncated: boolean;
}

/** `jt_app::usecases::prospects::report::GroupBy`. */
export type ProspectsReportGroup =
  | 'source'
  | 'research_task'
  | 'segment'
  | 'sector'
  | 'city'
  | 'score_bucket'
  | 'rubric_digest';
export const PROSPECTS_REPORT_GROUPS: readonly ProspectsReportGroup[] = [
  'source',
  'research_task',
  'segment',
  'sector',
  'city',
  'score_bucket',
  'rubric_digest',
];

/** `jt_app::usecases::prospects::report::ReportGroup`: one group's counts. */
export interface ProspectsReportRow {
  /** The group's value; `null` for the prospects without one. */
  key: string | null;
  created: number;
  scored: number;
  qualified: number;
  /** By reject reason key. */
  rejected: Record<string, number>;
  promoted: number;
  contacted: number;
  replied: number;
  meetings: number;
  quoted: number;
  won: number;
  /** By lost-reason key. */
  lost: Record<string, number>;
  /** Minor units per currency code; never summed across currencies. */
  won_revenue: Record<string, number>;
  rates: { promoted_to_replied: number | null; replied_to_meeting: number | null; meeting_to_won: number | null };
}

/** `jt_app::usecases::prospects::report::ReportOut` over `[from, to)`. */
export interface ProspectsReportOut {
  from: Rfc3339;
  to: Rfc3339;
  group_by: ProspectsReportGroup;
  groups: ProspectsReportRow[];
  truncated: boolean;
}
