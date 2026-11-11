//! Olay-driven publishing's storage (spec `2026-11-03-studio-materials-design.md` §14.2): each
//! slot's planned post, the package requests the triggers write and the workspace's posting
//! policy with its time zone. The rules live in `jt_studio` and are re-exported here.
//!
//! Calls run in the caller's tenant transaction. Use cases that write a post or a request hold the
//! Studio control lock first, as the planner and the publisher do, so they never interleave.
pub use jt_studio::{
    FormatScore, PackageHints, PackageRequest, PackageRequestId, PackageStatus, PackageTrigger,
    PlannedPost, PostFormat, PostRetirement, PostingPolicy,
};

use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_studio::SlotId;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use time::{Date, OffsetDateTime};

use crate::error::AppError;

/// The time zone a workspace's posting hours and days are read in when it set none.
pub const DEFAULT_POSTING_TZ: &str = "Europe/Istanbul";

/// The workspace's posting policy (`studio_posting_policy`) and the IANA time zone its quiet
/// hours, daily caps and summary weeks are read in; the defaults when it never set one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostingSettings {
    #[serde(default)]
    pub policy: PostingPolicy,
    #[serde(default = "default_tz")]
    pub tz: String,
    /// The accounts whose posting a person paused (design 2026-11-10 §7.6): nothing is planned
    /// for one and nothing goes out on it, as under a brake, for that account alone.
    #[serde(default)]
    pub paused_capability_ids: BTreeSet<CapabilityId>,
    /// Counts the changes of the settings; pausing an account names the revision it saw.
    #[serde(default)]
    pub revision: u64,
    /// Whether a post is left with its platform's own scheduler where the platform has one open
    /// to applications (design 2026-11-10 §7.3, B47: Facebook Page text and link posts). Off
    /// until a person switches it on: Jeeta then sends every post itself at its time.
    #[serde(default)]
    pub provider_scheduling: bool,
}

fn default_tz() -> String {
    DEFAULT_POSTING_TZ.to_owned()
}

impl Default for PostingSettings {
    fn default() -> Self {
        PostingSettings {
            policy: PostingPolicy::default(),
            tz: default_tz(),
            paused_capability_ids: BTreeSet::new(),
            revision: 0,
            provider_scheduling: false,
        }
    }
}

/// The five numbers of an account the module shows (design §7.1); one the platform does not
/// give is `None`, never zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountNumbers {
    pub followers: Option<i64>,
    pub reach: Option<i64>,
    pub views: Option<i64>,
    pub engagement: Option<i64>,
    pub profile_visits: Option<i64>,
}

/// What a social account's platform said on one day (`social_account_days`): the first
/// successful read of the day stands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDay {
    pub workspace_id: WorkspaceId,
    pub capability_id: CapabilityId,
    /// The day in the workspace's posting time zone.
    #[serde(with = "jt_studio::time_compat::date")]
    pub day: Date,
    pub numbers: AccountNumbers,
    /// The provider's own counters, as it named them.
    pub raw: BTreeMap<String, i64>,
    #[serde(with = "jt_studio::time_compat")]
    pub read_at: OffsetDateTime,
}

#[async_trait]
pub trait PostRepo: Send + Sync {
    /// Stores `day` unless its account has a snapshot of that day already: `false` then.
    async fn insert_account_day(&mut self, day: AccountDay) -> Result<bool, AppError>;
    /// The account's snapshots with `from <= day <= until`, by day.
    async fn account_days(
        &mut self,
        capability: CapabilityId,
        from: Date,
        until: Date,
    ) -> Result<Vec<AccountDay>, AppError>;
    /// Each account's most recent snapshot, by capability id.
    async fn latest_account_days(&mut self) -> Result<Vec<AccountDay>, AppError>;
    /// Deletes the workspace's snapshots of days before `before`; answers how many.
    async fn purge_account_days(&mut self, before: Date) -> Result<u64, AppError>;

    /// Stores the planned post of a stored slot of the workspace (`NOT_FOUND` otherwise), naming a
    /// stored package request (`NOT_FOUND`) and, when it has one, an olay of the workspace
    /// (`NOT_FOUND`). `CONFLICT` when the slot has a post already. A post is stored without a
    /// retirement.
    async fn insert_post(&mut self, post: PlannedPost) -> Result<(), AppError>;
    async fn get_post(&mut self, slot: SlotId) -> Result<Option<PlannedPost>, AppError>;
    /// Every post of the workspace, by `publish_at`, then slot id.
    async fn list_posts(&mut self) -> Result<Vec<PlannedPost>, AppError>;
    /// Records why and when the post of `slot` was retired, once: `false` (nothing written) when
    /// it was recorded already, `NOT_FOUND` when the slot has no post. Nothing else of a post
    /// ever changes.
    async fn retire_post(
        &mut self,
        slot: SlotId,
        retired: PostRetirement,
    ) -> Result<bool, AppError>;

    /// Adds the request unless one with its key exists: `false` then, and nothing is written.
    async fn insert_package_request(&mut self, request: PackageRequest) -> Result<bool, AppError>;
    /// Replaces the stored request of the same id (`NOT_FOUND` when there is none). Its key,
    /// trigger and creation never change, and only an open request changes (`CONFLICT`).
    async fn update_package_request(&mut self, request: PackageRequest) -> Result<(), AppError>;
    async fn get_package_request(
        &mut self,
        id: PackageRequestId,
    ) -> Result<Option<PackageRequest>, AppError>;
    /// Every request of the workspace, newest first.
    async fn list_package_requests(&mut self) -> Result<Vec<PackageRequest>, AppError>;

    /// The workspace's posting settings; the defaults when it never set them.
    async fn posting_settings(&mut self) -> Result<PostingSettings, AppError>;
    /// Stores the workspace's posting settings, replacing those there. The caller has validated
    /// the policy and the time zone.
    async fn save_posting_settings(&mut self, settings: PostingSettings) -> Result<(), AppError>;
}
