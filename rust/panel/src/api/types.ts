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
  | 'studio.manage';
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
  | { kind: 'task_due'; task_id: string };

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
export type Provider = 'meta' | 'netgsm' | 'x' | 'mail';
export const PROVIDERS: readonly Provider[] = ['meta', 'netgsm', 'x', 'mail'];

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
  /** Redacted by the server; for logs and agents, not shown. */
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

/** `jt_app::usecases::connector::HooksOut`; `meta` is `null` while the platform has no Meta app. */
export interface HooksOut {
  meta: MetaHook | null;
  netgsm: NetgsmHook[];
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
  token_expires_at: Rfc3339 | null;
  reconnect_required: boolean;
}

// Inbox: Rust domain serde enums are externally tagged, not `{ kind: … }` objects.
export type InboxQueue = 'ours' | 'unassigned' | 'snoozed' | 'all';
export type InboxSource = { channel: string } | 'meta_ads' | 'import' | 'form' | 'repeat';
export type InboxActor = 'system' | 'agent' | { human: Uuid };
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
}
export interface InboxMessage {
  id: Uuid;
  workspace_id: Uuid;
  conversation_id: Uuid;
  direction: 'inbound' | 'outbound';
  author: InboxActor | 'customer';
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
  status_labels: Record<JourneyStatus, string>;
  journey: InboxJourney;
  events: InboxEvent[];
  tasks: InboxTask[];
  notes: InboxNote[];
}
export interface InboxContext {
  status_labels: Record<JourneyStatus, string>;
  person: InboxPerson;
  journey: InboxJourney | null;
  events: InboxEvent[];
  open_tasks: InboxTask[];
  recent_conversations: { conversation: InboxConversationRow; messages: InboxMessage[] }[];
  strategy_guidance: { summary: Identity; segments: Segment[]; hypotheses: Hypothesis[] } | null;
  prohibitions: string[];
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
