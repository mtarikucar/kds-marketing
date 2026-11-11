//! Production workspaces live inside the existing tenant; sources and publications remain canonical.
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::{MaterialId, PostFormat, SlotId};
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSource {
    pub material_id: MaterialId,
    pub revision: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    Open,
    Done,
    Dismissed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectMaterialRequest {
    pub id: Uuid,
    pub text: String,
    pub status: RequestStatus,
    pub material_ids: Vec<MaterialId>,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub resolved_at: Option<OffsetDateTime>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectOutput {
    pub id: Uuid,
    pub title: String,
    pub format: PostFormat,
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub target_at: Option<OffsetDateTime>,
    pub capability_id: Option<CapabilityId>,
    /// A target date is not a scheduled publication. This names the canonical existing slot.
    pub slot_id: Option<SlotId>,
}
/// The longest goal sentence, progress note, release reason, redo note and package summary.
pub const MAX_GOAL_CHARS: usize = 2000;
/// The most platform versions one package holds.
pub const MAX_VERSIONS: usize = 12;
/// The most tags one version carries, and the longest tag.
pub const MAX_TAGS: usize = 30;
pub const MAX_TAG_CHARS: usize = 100;
/// The longest text, title, link and content type of one version.
pub const MAX_VERSION_TEXT_CHARS: usize = 5000;
pub const MAX_VERSION_TITLE_CHARS: usize = 160;
pub const MAX_LINK_CHARS: usize = 2000;
pub const MAX_CONTENT_TYPE_CHARS: usize = 200;
/// The packages an area's document keeps, newest last; the ledger keeps every delivery.
pub const MAX_PACKAGES: usize = 20;
/// How long a claim lives without a progress report.
pub const AREA_LEASE: time::Duration = time::Duration::minutes(30);
/// The steps of the content module's workflow (design 2026-11-10 §6.2).
pub const AREA_STEPS: u8 = 14;
/// Deliveries refused in a row before the area is held for a person (design B9).
pub const MAX_REFUSALS: u8 = 3;

/// Who opened an area: a person, or the system by one of its triggers (design §6.3).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenedBy {
    #[default]
    Human,
    System {
        trigger: AreaTrigger,
        /// The trigger's stable key: one area per key.
        key: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AreaTrigger {
    Olay,
    Calendar,
    Floor,
}

/// What the person opening the area chose, if anything; empty: the agent decides by the strategy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaHints {
    pub formats: Vec<PostFormat>,
    pub capability_ids: Vec<CapabilityId>,
}

/// The agent working an area. One live claim per area; it runs out at `lease_until`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaClaim {
    pub agent: AgentConnectionId,
    /// SHA-256 of the random bearer token, which only the claim's answer carries.
    pub token_hash: String,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub lease_until: OffsetDateTime,
    /// The redo this agent saw when taking the area; a later note must survive delivery.
    #[serde(default)]
    pub redo_seen: Option<RedoRequest>,
}

/// Where the agent is: the workflow step (1 to [`AREA_STEPS`]) and a sentence about it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaProgress {
    pub step: u8,
    pub note: String,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
}

/// What an area produces: the platform versions of one delivery. Every version passed the
/// checks, unless a person released what the text check alone held (`released`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentPackage {
    pub revision: u32,
    #[serde(with = "jt_studio::time_compat")]
    pub delivered_at: OffsetDateTime,
    pub by: AgentConnectionId,
    pub summary: String,
    pub versions: Vec<PackageVersion>,
    /// The person who released it from a hold, and the text findings released (design B9).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<PackageRelease>,
}

/// A person's release of a held delivery: who, when, and the findings they accepted, as the
/// refusal listed them (`[{"index", "findings"}]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageRelease {
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub findings: serde_json::Value,
}

/// The delivery the checks last refused, kept while it is the area's open matter: a person sees
/// why an area is held, and may release it when only the text check holds it (design B9). An
/// accepted delivery, a redo and a release clear it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusedDelivery {
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub by: AgentConnectionId,
    pub summary: String,
    pub versions: Vec<PackageVersion>,
    /// What held it, as the agent was told: `[{"index": n, "findings": [{"kind", "code", ...}]}]`.
    pub findings: serde_json::Value,
}

/// One platform version of a package.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageVersion {
    pub id: Uuid,
    pub format: PostFormat,
    /// The account it is made for, if the agent chose one.
    pub capability_id: Option<CapabilityId>,
    pub text: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub link: Option<String>,
    /// The area's materials it shows, in display order.
    pub material_ids: Vec<MaterialId>,
    pub hypothesis_id: HypothesisId,
    pub content_type: Option<String>,
    /// The planned post made of it, once it is scheduled.
    pub slot_id: Option<SlotId>,
}

/// A person's "Olmamış": what should change. It stands until a delivery answers it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedoRequest {
    pub note: String,
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AreaState {
    Queued,
    Working,
    WaitingMaterial,
    Done,
    Held,
    Archived,
}

/// An area's state as an answer carries it: the state at the moment of the answer, the agent's
/// step and note, and when the area starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaStatus {
    pub state: AreaState,
    pub step: Option<u8>,
    pub note: Option<String>,
    #[serde(with = "jt_studio::time_compat")]
    pub starts_at: OffsetDateTime,
}

/// A production area (design §6.1): one content job, from its goal to its packages. Stored whole
/// as one document. The fields from `start_at` to `refused` were added with the content module;
/// a document from before reads with their defaults.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductionProject {
    /// When an agent may start; `None` on an area from before, which starts at `created_at`.
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub start_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub opened_by: OpenedBy,
    #[serde(default)]
    pub hints: AreaHints,
    #[serde(default)]
    pub claim: Option<AreaClaim>,
    #[serde(default)]
    pub progress: Option<AreaProgress>,
    /// Oldest first; the last one is the current package.
    #[serde(default)]
    pub packages: Vec<ContentPackage>,
    #[serde(default)]
    pub redo: Option<RedoRequest>,
    /// Deliveries refused since the last accepted one or the last redo.
    #[serde(default)]
    pub refused: u8,
    /// The last refused delivery, while it stands.
    #[serde(default)]
    pub refusal: Option<RefusedDelivery>,
    /// The answer's projection ([`ProductionProject::present`]); never stored and never what
    /// decides the state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<AreaStatus>,
    pub id: Uuid,
    pub workspace_id: WorkspaceId,
    pub title: String,
    /// The goal: one sentence is enough.
    pub brief: String,
    pub revision: u64,
    pub archived: bool,
    pub sources: Vec<ProjectSource>,
    pub requests: Vec<ProjectMaterialRequest>,
    pub outputs: Vec<ProjectOutput>,
    pub production_ids: Vec<Uuid>,
    #[serde(default)]
    pub invalidated_production_ids: Vec<Uuid>,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: OffsetDateTime,
}

impl ProductionProject {
    pub fn starts_at(&self) -> OffsetDateTime {
        self.start_at.unwrap_or(self.created_at)
    }

    /// When the current package was delivered; `None` while there is none, a redo stands or a
    /// requested material is still awaited: such an area is not finished.
    pub fn done_at(&self) -> Option<OffsetDateTime> {
        if self.redo.is_some() || self.awaits_material() {
            return None;
        }
        self.packages.last().map(|p| p.delivered_at)
    }

    fn awaits_material(&self) -> bool {
        self.requests
            .iter()
            .any(|r| r.status == RequestStatus::Open)
    }

    /// The first rule that holds: archived; held after [`MAX_REFUSALS`] refusals; waiting for a
    /// requested material; worked by a live claim; done; otherwise queued.
    pub fn state(&self, now: OffsetDateTime) -> AreaState {
        if self.archived {
            AreaState::Archived
        } else if self.refused >= MAX_REFUSALS {
            AreaState::Held
        } else if self.awaits_material() {
            AreaState::WaitingMaterial
        } else if self.claim.as_ref().is_some_and(|c| c.lease_until > now) {
            AreaState::Working
        } else if self.done_at().is_some() {
            AreaState::Done
        } else {
            AreaState::Queued
        }
    }

    /// What `work.checkin` offers an agent: queued, and its start time has come.
    pub fn needs_agent(&self, now: OffsetDateTime) -> bool {
        self.state(now) == AreaState::Queued && self.starts_at() <= now
    }

    /// The versions of the current package that no planned post was made of, while the area is
    /// finished: none while a redo stands or a material is awaited.
    pub fn waiting_versions(&self) -> impl Iterator<Item = &PackageVersion> {
        self.packages
            .last()
            .filter(|_| !self.archived && self.done_at().is_some())
            .into_iter()
            .flat_map(|p| p.versions.iter())
            .filter(|v| v.slot_id.is_none())
    }

    /// The area with its state as of `now`, for an answer.
    pub fn present(mut self, now: OffsetDateTime) -> Self {
        self.state = Some(AreaStatus {
            state: self.state(now),
            step: self.progress.as_ref().map(|p| p.step),
            note: self.progress.as_ref().map(|p| p.note.clone()),
            starts_at: self.starts_at(),
        });
        self
    }
}

/// Where a page of finished areas ends: the last row's delivery time and id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoneCursor {
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    pub id: Uuid,
}

#[async_trait]
pub trait ProjectRepo: Send + Sync {
    async fn get_project(&mut self, id: Uuid) -> Result<Option<ProductionProject>, AppError>;
    /// At most 101 rows for a 100-row page, newest first, before an exclusive ID cursor.
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
    ) -> Result<Vec<ProductionProject>, AppError>;
    /// Areas not archived. `done == false`: those without a finished package, earliest start
    /// first, then id, at most 200 (`before` is not used). `done == true`: those with one, newest
    /// delivery first, then id descending, at most 51 rows for a 50-row page, after the exclusive
    /// cursor `before`.
    async fn list_areas(
        &mut self,
        done: bool,
        before: Option<DoneCursor>,
    ) -> Result<Vec<ProductionProject>, AppError>;
    /// Finished areas whose current package holds a version no planned post was made of, oldest
    /// delivery first, then id, at most 200: what waits for a time (design §7.2).
    async fn list_areas_waiting(&mut self) -> Result<Vec<ProductionProject>, AppError>;
    /// Stores the area at `project.revision`, which must follow `expected` (`None`: a new area).
    /// The answer projection `state` is not stored.
    async fn save_project(
        &mut self,
        project: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError>;
}
