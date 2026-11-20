//! Production workspaces live inside the existing tenant; sources and publications remain canonical.
use crate::error::AppError;
use async_trait::async_trait;
use jt_capability::CapabilityId;
use jt_strategy::HypothesisId;
use jt_studio::{MaterialId, OlayId, PostFormat, SlotId};
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
/// The longest one-line result of a step (design 2026-11-18 §4).
pub const MAX_STEP_OUTPUT_CHARS: usize = 240;
/// The most materials one step names (the files chosen at steps 9 and 10).
pub const MAX_STEP_MATERIALS: usize = 20;

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

/// One step of the workflow as the agent reported it (design 2026-11-18 §4): its note, when, and
/// what it produced, in one line, and the materials it chose. An area keeps one per step for the
/// attempt that leads to its current or next package ([`ProductionProject::steps`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaStep {
    pub step: u8,
    pub note: String,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    /// The step's result in one line: the platform and format at step 3, the main message at 6,
    /// the headline at 7.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// The materials the step chose, in order (steps 9 and 10: the files the content shows).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_ids: Vec<MaterialId>,
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
    /// The steps of the attempt that made it, as the area held them when it was accepted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<AreaStep>,
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
    /// By version, whether the server gave it the owner's request as its hypothesis (a person's
    /// content delivered without a topic, design 2026-11-19 §3.5); absent: none was.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assigned: Vec<bool>,
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
    /// A person cancelled the planned post made of it ([`VersionCancel`]): the version keeps that
    /// retired post and is never planned again. Absent on every other version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<VersionCancel>,
}

/// A person's cancellation of the planned post made of a version ("İptal et": `studio.slot_cancel`
/// in person). The post does not go out and the version is never planned again: it keeps its
/// retired post as its `slot_id`, so neither `social.versions_waiting` nor the agent's next run
/// offers it, and `social.version_schedule` refuses it (`version_cancelled`). The content's other
/// versions are left as they are; once every version of the current package is cancelled and
/// nothing of the content went out, the content is archived with the last one. A redo of the
/// content makes a new package, whose versions are new. An agent's cancel is not one: it moves the
/// post, and the version waits for a time again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionCancel {
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    /// What the person wrote when cancelling.
    pub reason: String,
    /// The planned post that was cancelled. Read as optional (design 2026-11-19 "Paylaşımlar
    /// and Bilgi bankası" §3.7.3, D18), so that a version cancelled before it had a planned post
    /// reads in every later binary's rollback target; every cancel written today names one.
    #[serde(default)]
    pub slot_id: Option<SlotId>,
}

/// A person's "Düzenleme iste": what should change. It stands until a delivery answers it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RedoRequest {
    pub note: String,
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
    /// The planned posts the redo took back (of every redo standing, when a person wrote the
    /// note again): where the content had posts that are now being made again. A redo from
    /// before this field reads with none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub withdrawn: Vec<SlotId>,
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
    /// The person who asked for this content in person (`studio.project_create` from a panel
    /// session, never an agent's key): their choice of account or format in `hints` is their
    /// decision (design 2026-11-19 R3). `None` for an area an agent or the system opened, and for
    /// one from before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<UserId>,
    #[serde(default)]
    pub hints: AreaHints,
    #[serde(default)]
    pub claim: Option<AreaClaim>,
    #[serde(default)]
    pub progress: Option<AreaProgress>,
    /// The olay the area's content is about (design 2026-11-18 §2): the trigger's olay for an
    /// area the system opened for an olay or a calendar occasion, the one a person named. `None`:
    /// no olay, and the panel shows the area under "Genel".
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    /// The steps of the current attempt, ascending, one per step: the attempt that leads to the
    /// next package, or that led to the current one. A report of step `n` replaces `n` and drops
    /// every later step (they are redone after it); a redo clears them, since the package they
    /// led to is abandoned; a delivery copies them into its package ([`ContentPackage::steps`]).
    #[serde(default)]
    pub steps: Vec<AreaStep>,
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
    /// The files a person attached to this content (the composer, a capture answer) whose share
    /// is not set yet (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §3.4.4): while any is
    /// listed no agent takes the area ([`ProductionProject::needs_agent`]), so nothing is made
    /// without the person's files and then refused `share_unset`. A file leaves the list when it
    /// gets its share (by rule or by a person), leaves the sources, or is deleted. Absent on an
    /// area from before, which waits for nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_files: Vec<MaterialId>,
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

    /// What `work.checkin` offers an agent: queued, its start time has come, and no file a
    /// person attached still waits for its share ([`ProductionProject::pending_files`]).
    pub fn needs_agent(&self, now: OffsetDateTime) -> bool {
        self.state(now) == AreaState::Queued
            && self.starts_at() <= now
            && self.pending_files.is_empty()
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

    /// Records step `s` of the current attempt (see [`ProductionProject::steps`]): it replaces
    /// what was reported for its step and drops every later one; the area's `progress` follows.
    pub fn record_step(&mut self, s: AreaStep) {
        self.steps.retain(|x| x.step < s.step);
        self.progress = Some(AreaProgress {
            step: s.step,
            note: s.note.clone(),
            at: s.at,
        });
        self.steps.push(s);
    }

    /// A new attempt: the steps of the abandoned one are dropped (their package keeps its own).
    pub fn restart_steps(&mut self) {
        self.steps.clear();
    }

    /// Whether its deliveries were refused [`MAX_REFUSALS`] times in a row: held for a person.
    pub fn held(&self) -> bool {
        !self.archived && self.refused >= MAX_REFUSALS
    }

    /// The planned posts made of its packages' versions, oldest package first, each with whether
    /// it is of the current (last) package.
    pub fn posts(&self) -> Vec<AreaPost> {
        let last = self.packages.len();
        self.packages
            .iter()
            .enumerate()
            .flat_map(|(n, k)| {
                k.versions.iter().filter_map(move |v| {
                    v.slot_id.map(|slot_id| AreaPost {
                        version_id: v.id,
                        slot_id,
                        current: n + 1 == last,
                    })
                })
            })
            .collect()
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

/// Which olay's areas a list holds (design 2026-11-18 §2): those of one olay, or those of none
/// ("Genel").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AreaOlay {
    Olay(OlayId),
    Genel,
}

impl AreaOlay {
    pub fn matches(self, p: &ProductionProject) -> bool {
        match self {
            Self::Olay(id) => p.olay_id == Some(id),
            Self::Genel => p.olay_id.is_none(),
        }
    }
}

/// A planned post made of a version of an area's package (design 2026-11-18 §4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AreaPost {
    pub version_id: Uuid,
    pub slot_id: SlotId,
    /// Its version is of the current (last) package.
    pub current: bool,
}

/// What the content tree needs of an area that is held or has planned posts, without its
/// document: its olay, whether it is held, whether its current package is finished
/// ([`ProductionProject::done_at`]), and its planned posts ([`ProductionProject::posts`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AreaPosts {
    pub id: Uuid,
    pub olay_id: Option<OlayId>,
    pub held: bool,
    pub done: bool,
    pub posts: Vec<AreaPost>,
}

impl AreaPosts {
    /// The area's, when it is not archived and is held or has a planned post; `None` otherwise.
    pub fn of(p: &ProductionProject) -> Option<Self> {
        let posts = p.posts();
        (!p.archived && (p.held() || !posts.is_empty())).then(|| AreaPosts {
            id: p.id,
            olay_id: p.olay_id,
            held: p.held(),
            done: p.done_at().is_some(),
            posts,
        })
    }
}

/// How many areas not archived one olay holds (`None`: no olay, "Genel"), and how many captures
/// their agents asked for that nobody supplied yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AreaCount {
    pub olay_id: Option<OlayId>,
    pub areas: u64,
    pub open_requests: u64,
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
    /// At most 101 rows for a 100-row page, newest first, before an exclusive ID cursor; only
    /// `olay`'s areas when given.
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError>;
    /// Areas not archived. `done == false`: those without a finished package, earliest start
    /// first, then id, at most 200 (`before` is not used). `done == true`: those with one, newest
    /// delivery first, then id descending, at most 51 rows for a 50-row page, after the exclusive
    /// cursor `before`. Only `olay`'s areas when given.
    async fn list_areas(
        &mut self,
        done: bool,
        before: Option<DoneCursor>,
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError>;
    /// The areas not archived, counted in the store by olay: one row per olay that has one
    /// (`None`: the areas of no olay), by olay id, no olay first.
    async fn area_counts(&mut self) -> Result<Vec<AreaCount>, AppError>;
    /// [`AreaPosts::of`] every area not archived that is held or has a planned post, by id,
    /// without reading the documents whole.
    async fn area_posts(&mut self) -> Result<Vec<AreaPosts>, AppError>;
    /// Of `ids`, the materials some area holds, archived or not: a source of it, or shown by a
    /// version of any of its packages. One read, whatever the number of areas.
    async fn materials_in_areas(
        &mut self,
        ids: &[MaterialId],
    ) -> Result<std::collections::BTreeSet<MaterialId>, AppError>;
    /// Finished areas whose current package holds a version no planned post was made of, oldest
    /// delivery first, then id, at most 200: what waits for a time (design §7.2).
    async fn list_areas_waiting(&mut self) -> Result<Vec<ProductionProject>, AppError>;
    /// Every area not archived, whole documents, newest first, with no cap (design 2026-11-19
    /// "Paylaşımlar and Bilgi bankası" §3.9): the read of `content.posts`. One read in the
    /// database; the default pages through [`Self::list_projects`].
    async fn list_live_areas(&mut self) -> Result<Vec<ProductionProject>, AppError> {
        let mut out: Vec<ProductionProject> = Vec::new();
        let mut before = None;
        loop {
            let page = self.list_projects(false, before, None).await?;
            let more = page.len() > 100;
            out.extend(page.into_iter().take(100));
            if !more {
                return Ok(out);
            }
            before = out.last().map(|p| p.id);
        }
    }
    /// The area, archived or not, one of whose packages holds the version `version_id`; `None`
    /// when no area does. One read in the database; the default scans every area.
    async fn find_area_by_version(
        &mut self,
        version_id: Uuid,
    ) -> Result<Option<ProductionProject>, AppError> {
        for archived in [false, true] {
            let mut before = None;
            loop {
                let page = self.list_projects(archived, before, None).await?;
                let more = page.len() > 100;
                if let Some(p) = page.iter().take(100).find(|p| {
                    p.packages
                        .iter()
                        .any(|k| k.versions.iter().any(|v| v.id == version_id))
                }) {
                    return Ok(Some(p.clone()));
                }
                if !more {
                    break;
                }
                before = page.get(99).map(|p| p.id);
            }
        }
        Ok(None)
    }
    /// Stores the area at `project.revision`, which must follow `expected` (`None`: a new area).
    /// The answer projection `state` is not stored.
    async fn save_project(
        &mut self,
        project: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError>;
}
