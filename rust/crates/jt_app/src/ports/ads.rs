//! Ad campaigns (design 2026-11-10 §8): one record per campaign, from a goal and a budget to
//! what was built at the ad platform, what the agent changed and what it brought.
//!
//! A campaign is opened by a person, or proposed by an agent and approved by a person. An agent
//! only decides: it delivers one plan. Jeeta checks the plan, holds the campaign's whole budget
//! against every limit, and builds the campaign at the provider itself, paused first, with the
//! provider's own total budget as the hard limit.
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::MaterialId;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// How long an agent's claim of a campaign lasts without a sign of life.
pub const CAMPAIGN_LEASE: Duration = Duration::minutes(30);
/// How many plans in a row may be refused before the campaign waits for a person.
pub const MAX_PLAN_REFUSALS: u8 = 3;
/// How long a proposal waits for a person's decision before it closes by itself (B16).
pub const PROPOSAL_DAYS: i64 = 7;
/// The most ads one campaign carries.
pub const MAX_ADS: usize = 6;
/// The shortest and the longest a campaign runs.
pub const MIN_RUN: Duration = Duration::hours(24);
pub const MAX_RUN: Duration = Duration::days(90);
/// The most moves a campaign's record keeps (the ledger keeps every one).
pub const MAX_MOVES: usize = 200;
/// The longest goal, reason and note.
pub const MAX_TEXT_CHARS: usize = 2000;
/// How long after its end a campaign that ran at the provider is still read: what the provider
/// reports as spent arrives late, and the last hours before the end would otherwise be lost.
pub const SETTLE_WINDOW: Duration = Duration::hours(48);

/// The ad platform a campaign runs on: the one its ad account is of (design 2026-11-11 B61).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdsPlatform {
    /// A record written before a campaign could run anywhere else reads as Meta.
    #[default]
    Meta,
    Google,
    Linkedin,
    Tiktok,
    X,
}

impl AdsPlatform {
    /// Every platform a campaign can be built on, in a fixed order.
    pub fn all() -> &'static [AdsPlatform] {
        &[
            AdsPlatform::Meta,
            AdsPlatform::Google,
            AdsPlatform::Linkedin,
            AdsPlatform::Tiktok,
            AdsPlatform::X,
        ]
    }

    /// The capability kind of its ad accounts.
    pub fn kind_key(self) -> &'static str {
        match self {
            AdsPlatform::Meta => "meta_ads",
            AdsPlatform::Google => "google_ads",
            AdsPlatform::Linkedin => "linkedin_ads",
            AdsPlatform::Tiktok => "tiktok_ads",
            AdsPlatform::X => "x_ads",
        }
    }

    /// The platform whose ad accounts are of capability kind `kind_key`, if one is.
    pub fn of_kind(kind_key: &str) -> Option<AdsPlatform> {
        AdsPlatform::all()
            .iter()
            .copied()
            .find(|p| p.kind_key() == kind_key)
    }
}

fn youngest() -> u8 {
    18
}
fn oldest() -> u8 {
    65
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CampaignOpenedBy {
    /// A person opened it: it starts without anybody's approval (S20).
    Human { user: UserId },
    /// An agent proposed it: it spends nothing until a person approves it (S24).
    System { agent: AgentConnectionId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignApproval {
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignDecline {
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub reason: String,
}

/// An agent's hold on a campaign while it plans. The token itself is never stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignClaim {
    pub agent: AgentConnectionId,
    pub token_hash: String,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub lease_until: OffsetDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdResult {
    LinkClick,
    LeadForm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Destination {
    Website {
        url: String,
    },
    LeadForm {
        /// The Facebook Page the form belongs to.
        page: CapabilityId,
        name: String,
        /// `FULL_NAME`, `EMAIL`, `PHONE`.
        questions: Vec<String>,
        privacy_policy_url: String,
        thank_you_url: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanInterest {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanAudience {
    pub countries: Vec<String>,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub cities: Vec<String>,
    /// 18 when left out.
    #[serde(default = "youngest")]
    pub age_min: u8,
    /// 65 (and older) when left out.
    #[serde(default = "oldest")]
    pub age_max: u8,
    /// `1` men, `2` women; empty: everybody.
    #[serde(default)]
    pub genders: Vec<u8>,
    #[serde(default)]
    pub interests: Vec<PlanInterest>,
    #[serde(default)]
    pub broad: bool,
}

/// Where the ads are shown: left to the platform (the default, and the only choice on a platform
/// that has no placements to name), or on the named ones.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanPlacements {
    #[default]
    Automatic,
    #[serde(untagged)]
    Platforms { platforms: Vec<String> },
}

/// One ad of a plan. Which of its fields an ad carries is its platform's
/// (`usecases::ads::platform`): an image ad its image, its texts, its call to action and the
/// account it speaks as; a search ad its headlines and descriptions. A field the platform does
/// not take is left out; one given anyway is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanAd {
    pub name: String,
    /// One image material, on a platform whose ad shows an image.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_ids: Vec<MaterialId>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub primary_text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub headline: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `LEARN_MORE`, `SIGN_UP`, `SHOP_NOW`, `CONTACT_US`, `GET_QUOTE`, `SUBSCRIBE`, `APPLY_NOW`,
    /// `BOOK_NOW`, `DOWNLOAD`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub call_to_action: String,
    /// The account the ad speaks as: a Facebook Page on Meta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<CapabilityId>,
    #[serde(default)]
    pub instagram: Option<CapabilityId>,
    /// A search ad's headlines, of which the platform shows a few at a time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headlines: Vec<String>,
    /// A search ad's descriptions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub descriptions: Vec<String>,
    pub hypothesis_id: HypothesisId,
}

/// What the agent delivers: everything Jeeta needs to build the campaign, and nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CampaignPlan {
    pub ad_account: CapabilityId,
    pub result: AdResult,
    pub destination: Destination,
    /// Must be empty in this version (B33).
    #[serde(default)]
    pub special_ad_categories: Vec<String>,
    pub audience: PlanAudience,
    #[serde(default)]
    pub placements: PlanPlacements,
    /// The searches the ads answer, on a platform that shows ads on searches.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(with = "jt_studio::time_compat")]
    pub end_at: OffsetDateTime,
    pub ads: Vec<PlanAd>,
    /// What the agent decided, for the person who reads the campaign.
    pub summary: String,
    /// Who sees it, in one sentence.
    pub audience_summary: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuiltAdStatus {
    Active,
    Paused,
    InReview,
    Disapproved,
}

/// One ad as it stands at the provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuiltAd {
    /// Its place in the plan's ads.
    pub index: usize,
    pub status: BuiltAdStatus,
    #[serde(default)]
    pub feedback: Option<String>,
    #[serde(default)]
    pub image_hash: Option<String>,
    #[serde(default)]
    pub creative_id: Option<String>,
    #[serde(default)]
    pub ad_id: Option<String>,
    /// A person or the agent paused this ad (a move): it stays paused when the campaign runs.
    #[serde(default)]
    pub held: bool,
    /// How many times the ad was replaced after the provider turned it down: part of its name
    /// at the provider, so that a replacement is never taken for the ad it replaces.
    #[serde(default)]
    pub generation: u32,
    /// The provider ads this one replaced; they stay paused.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replaced_ad_ids: Vec<String>,
}

/// What Jeeta built at the provider, step by step: each id is recorded before the next step, so
/// that a build that was cut off goes on from where it was and nothing is created twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Built {
    pub account: CapabilityId,
    /// The platform of `account`.
    #[serde(default)]
    pub platform: AdsPlatform,
    #[serde(default)]
    pub campaign_id: Option<String>,
    #[serde(default)]
    pub adset_id: Option<String>,
    #[serde(default)]
    pub form_id: Option<String>,
    pub ads: Vec<BuiltAd>,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub activated_at: Option<OffsetDateTime>,
    /// The provider refused a step for good: what it said. What was created stays paused.
    #[serde(default)]
    pub failed: Option<String>,
    /// When the provider was last asked how the campaign stands.
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub watched_at: Option<OffsetDateTime>,
    /// Whether the provider confirmed the campaign paused, after a stop asked for it.
    #[serde(default)]
    pub provider_paused: bool,
}

impl Built {
    /// Whether every provider object exists.
    pub fn complete(&self) -> bool {
        self.campaign_id.is_some()
            && self.adset_id.is_some()
            && !self.ads.is_empty()
            && self.ads.iter().all(|a| a.ad_id.is_some())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveKind {
    PauseAd,
    ResumeAd,
    AddAd,
    FixAd,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveOutcome {
    Done,
    Refused,
}

/// What the agent changed while the campaign ran, with why and what came of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignMove {
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub kind: MoveKind,
    #[serde(default)]
    pub ad: Option<usize>,
    pub reason: String,
    pub outcome: MoveOutcome,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopBy {
    Person,
    Budget,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignStop {
    pub by: StopBy,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    BudgetSpent,
    EndDate,
    Person,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignEnd {
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub reason: EndReason,
}

/// One ad's numbers on one day, as the provider reports them. A number it does not give is
/// absent, never zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdDayRow {
    #[serde(with = "jt_studio::time_compat::date")]
    pub day: Date,
    pub ad: usize,
    #[serde(default)]
    pub spent_minor: Option<i64>,
    #[serde(default)]
    pub impressions: Option<i64>,
    #[serde(default)]
    pub clicks: Option<i64>,
    #[serde(default)]
    pub results: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignState {
    Proposed,
    Queued,
    Planning,
    Building,
    InReview,
    Live,
    Paused,
    Rejected,
    Ended,
    Held,
    Expired,
    Declined,
}

/// The state as an answer carries it; never stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignStateOut {
    pub state: CampaignState,
    pub note: Option<String>,
}

/// What the campaign spent and brought so far; never stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignTotals {
    pub spent_minor: i64,
    pub results: Option<i64>,
    pub result_kind: Option<AdResult>,
    pub impressions: Option<i64>,
    pub clicks: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdCampaign {
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub revision: u64,
    pub title: String,
    pub goal: String,
    /// The campaign's budget: a total, in minor units of `currency`. The provider gets it as the
    /// campaign's lifetime budget (B32).
    pub budget_minor: i64,
    pub currency: String,
    #[serde(with = "jt_studio::time_compat")]
    pub start_at: OffsetDateTime,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub end_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub account_hint: Option<CapabilityId>,
    pub opened_by: CampaignOpenedBy,
    #[serde(default)]
    pub approval: Option<CampaignApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declined: Option<CampaignDecline>,
    /// Why the agent proposed it, for a proposal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<CampaignClaim>,
    #[serde(default)]
    pub refused: u8,
    /// Why the last plan was refused, field by field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<serde_json::Value>,
    #[serde(default)]
    pub plan: Option<CampaignPlan>,
    #[serde(default)]
    pub built: Option<Built>,
    #[serde(default)]
    pub moves: Vec<CampaignMove>,
    #[serde(default)]
    pub stop: Option<CampaignStop>,
    #[serde(default)]
    pub ended: Option<CampaignEnd>,
    /// Daily numbers per ad; one row per ad and day, the latest reading.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<AdDayRow>,
    /// What of the provider's reported spend is already in the budget's spend entries.
    #[serde(default)]
    pub recorded_spend_minor: i64,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: OffsetDateTime,
    /// Projections of an answer; never stored.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub state: Option<CampaignStateOut>,
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub totals: Option<CampaignTotals>,
}

impl AdCampaign {
    /// The state at `now`, first match wins (design §8.3).
    pub fn state_at(&self, now: OffsetDateTime) -> CampaignState {
        if self.ended.is_some() {
            return CampaignState::Ended;
        }
        if self.declined.is_some() {
            return CampaignState::Declined;
        }
        if matches!(self.opened_by, CampaignOpenedBy::System { .. }) && self.approval.is_none() {
            return if now - self.created_at >= Duration::days(PROPOSAL_DAYS) {
                CampaignState::Expired
            } else {
                CampaignState::Proposed
            };
        }
        if self.refused >= MAX_PLAN_REFUSALS {
            return CampaignState::Held;
        }
        if self.stop.is_some() {
            return CampaignState::Paused;
        }
        if let Some(built) = &self.built {
            if built.failed.is_some() {
                return CampaignState::Held;
            }
            if built.activated_at.is_none() {
                return CampaignState::Building;
            }
            let running: Vec<_> = built.ads.iter().filter(|a| !a.held).collect();
            if built
                .ads
                .iter()
                .any(|a| a.status == BuiltAdStatus::Disapproved)
            {
                return CampaignState::Rejected;
            }
            if !running.is_empty() && running.iter().all(|a| a.status == BuiltAdStatus::Active) {
                return CampaignState::Live;
            }
            return CampaignState::InReview;
        }
        if self.claim.as_ref().is_some_and(|c| c.lease_until > now) {
            return CampaignState::Planning;
        }
        CampaignState::Queued
    }

    /// Whether an agent is needed now: a plan, or a fix after the provider turned an ad down.
    pub fn needs_agent(&self, now: OffsetDateTime) -> bool {
        self.start_at <= now
            && match self.state_at(now) {
                CampaignState::Queued => true,
                CampaignState::Rejected => self.claim.as_ref().is_none_or(|c| c.lease_until <= now),
                _ => false,
            }
    }

    /// Whether the campaign is over for good: nothing more is spent on it.
    pub fn closed_at(&self, now: OffsetDateTime) -> bool {
        matches!(
            self.state_at(now),
            CampaignState::Ended | CampaignState::Declined | CampaignState::Expired
        )
    }

    /// What the provider reported as spent, from the daily rows.
    pub fn spent_minor(&self) -> i64 {
        self.results
            .iter()
            .filter_map(|r| r.spent_minor)
            .fold(0i64, i64::saturating_add)
    }

    /// Whether the campaign may still be running at the provider: it was activated there and
    /// the provider has not confirmed a pause since.
    pub fn at_provider(&self) -> bool {
        self.built
            .as_ref()
            .is_some_and(|b| b.activated_at.is_some() && !b.provider_paused)
    }

    /// What of the budget is still committed: nothing once the campaign is over, else what is
    /// left to spend. A campaign that has not started building commits its whole budget from
    /// the moment it is opened (or approved), so that two campaigns cannot share one remainder.
    /// A campaign that ended keeps its commitment until the provider confirms its pause: until
    /// then the provider may still spend what is left of it.
    pub fn committed_minor(&self, now: OffsetDateTime) -> i64 {
        match self.state_at(now) {
            CampaignState::Declined | CampaignState::Expired | CampaignState::Proposed => 0,
            CampaignState::Ended if !self.at_provider() => 0,
            _ => (self.budget_minor - self.spent_minor()).max(0),
        }
    }

    /// The campaign with its projections for an answer at `now`.
    pub fn present(mut self, now: OffsetDateTime) -> Self {
        let state = self.state_at(now);
        let note = match state {
            CampaignState::Held => self
                .built
                .as_ref()
                .and_then(|b| b.failed.clone())
                .or_else(|| Some("plan_refused".into())),
            CampaignState::Paused => self.stop.as_ref().map(|s| s.reason.clone()),
            // Over here, not yet confirmed paused there: the watch keeps trying.
            CampaignState::Ended if self.at_provider() => Some("provider_still_running".into()),
            CampaignState::Rejected => self.built.as_ref().and_then(|b| {
                b.ads
                    .iter()
                    .find(|a| a.status == BuiltAdStatus::Disapproved)
                    .and_then(|a| a.feedback.clone())
            }),
            _ => None,
        };
        let sum = |pick: fn(&AdDayRow) -> Option<i64>| {
            let values: Vec<i64> = self.results.iter().filter_map(pick).collect();
            (!values.is_empty()).then(|| values.into_iter().fold(0i64, i64::saturating_add))
        };
        self.totals = Some(CampaignTotals {
            spent_minor: self.spent_minor(),
            results: sum(|r| r.results),
            result_kind: self.plan.as_ref().map(|p| p.result),
            impressions: sum(|r| r.impressions),
            clicks: sum(|r| r.clicks),
        });
        self.state = Some(CampaignStateOut { state, note });
        // The claim is the agent's: the token's hash is nobody's to read.
        if let Some(claim) = &mut self.claim {
            claim.token_hash = String::new();
        }
        self
    }
}

/// Which campaigns a list holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignScope {
    /// Not over: by start time, then id.
    Open,
    /// Over (ended, declined, expired): newest first.
    Closed,
}

#[async_trait]
pub trait AdsRepo: Send + Sync {
    async fn get_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError>;
    /// The campaign, locked until the bundle ends.
    async fn lock_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError>;
    /// The campaigns that are not marked closed (at most 200, by start time then id), or the
    /// closed ones newest first, 50 a page, those closed before `before`.
    async fn list_campaigns(
        &mut self,
        scope: CampaignScope,
        before: Option<OffsetDateTime>,
    ) -> Result<Vec<AdCampaign>, AppError>;
    /// The closed campaigns the watch still follows: the ones that were activated at the
    /// provider and either closed after `since` (their last spend may still arrive) or are not
    /// confirmed paused there. At most 200, the ones closed first first.
    async fn list_winding_down(
        &mut self,
        since: OffsetDateTime,
    ) -> Result<Vec<AdCampaign>, AppError>;
    /// Stores the campaign at `campaign.revision`, which must follow `expected` (`None`: a new
    /// campaign; a taken id is `CONFLICT`). `closed_at` marks it as over for the lists.
    async fn save_campaign(
        &mut self,
        campaign: AdCampaign,
        expected: Option<u64>,
        closed_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError>;
}
