//! The content page's read model (design 2026-11-18 §5): one module, the olay at its root. The
//! tree of olays with what waits for a person, the analysis queue, the production line with each
//! area's pipeline, and one olay's view (its flow, contents, files and "Eksikler"), each in one
//! call. Nothing here writes.
use super::pipeline::{self, Pipeline, PostReads, TimeWait};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        materials::{AnalysisStatus, Material, MaterialIntelligence, Olay, OlayKind, OlayStatus},
        production_projects::*,
    },
    usecases::{
        Deps,
        social::schedule::VersionAccounts,
        studio::{
            library,
            projects::{self, OlayFilter, ProjectQuery},
        },
    },
};
use jt_ledger::Actor;
use jt_studio::{
    Binding, CalendarEntry, MaterialId, OccasionKind, OlayId, ShootReason, ShootRequestId,
    ShootStatus, SlotId, istanbul_day,
};
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// Who may read the page: whoever works the library or the content (design 2026-11-18 §5).
pub const PAGE_PERMISSIONS: &[Permission] = &[
    Permission::MaterialsWork,
    Permission::ContentWork,
    Permission::ContentManage,
];
/// Who may read the production line.
pub const AREA_PERMISSIONS: &[Permission] = &[Permission::ContentWork, Permission::ContentManage];
/// How far ahead the tree lists the special days that have no olay yet.
pub const UPCOMING_DAYS: i64 = 120;
/// How long an answered or dismissed request stays in an olay's "Eksikler".
pub const RESOLVED_NEEDS_DAYS: i64 = 30;

/// An olay as the page's reads show it: the whole record to a caller with `materials.work`, who
/// works the library (the shape of `studio.olay_get`), and its identity alone to anyone else: what
/// the page needs to draw its folder, without its place, client, notes or who confirmed it
/// (design 2026-11-18 §5). The same keys either way, the identity's a subset.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum OlayOut {
    Full(Olay),
    Identity(OlayIdentity),
}

/// An olay's identity: what draws its folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OlayIdentity {
    pub id: OlayId,
    pub workspace_id: WorkspaceId,
    pub kind: OlayKind,
    pub title: String,
    #[serde(with = "jt_studio::time_compat::date")]
    pub starts_on: Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub ends_on: Date,
    /// The calendar key of a season or special day.
    pub occasion: Option<String>,
    pub status: OlayStatus,
    pub revision: u64,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
}

impl OlayOut {
    /// `o` as a caller sees it: whole with `materials.work` (`full`), its identity otherwise.
    pub fn of(o: Olay, full: bool) -> Self {
        if full {
            return Self::Full(o);
        }
        Self::Identity(OlayIdentity {
            id: o.id,
            workspace_id: o.workspace_id,
            kind: o.kind,
            title: o.title,
            starts_on: o.starts_on,
            ends_on: o.ends_on,
            occasion: o.occasion,
            status: o.status,
            revision: o.revision,
            created_at: o.created_at,
        })
    }

    pub fn id(&self) -> OlayId {
        match self {
            Self::Full(o) => o.id,
            Self::Identity(o) => o.id,
        }
    }

    pub fn status(&self) -> OlayStatus {
        match self {
            Self::Full(o) => o.status,
            Self::Identity(o) => o.status,
        }
    }
}

/// Why a folder waits for a person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    /// An agent opened it: a person confirms it.
    OlayProposed,
    /// The çekim listesi asks for a capture of it.
    ShootRequest,
    /// An agent working one of its contents asked for a capture.
    MaterialRequest,
    /// One of its contents waits for a person's approval.
    ContentApproval,
    /// One of its contents is finished and waits for an account and a time: the agent gives
    /// them on its next run, or a person does.
    ContentTime,
    /// One of its contents is stuck (refused three times, or a post that cannot go out).
    ContentProblem,
}

/// A folder's counts: its live files, its contents (areas), those with a post out, and why it
/// waits for a person, if it does.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Folder {
    pub files: u32,
    pub areas: u32,
    pub published: u32,
    pub waits: Vec<WaitReason>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TreeOlay {
    /// Whole with `materials.work`, its identity otherwise ([`OlayOut`]).
    pub olay: OlayOut,
    #[serde(flatten)]
    pub folder: Folder,
}

/// Where a special day with no olay stands today.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DayPhase {
    /// Its preparation day has not come.
    Ahead,
    /// Its preparation day has come; its window has not started.
    Preparing,
    /// Its window has started and not ended: it is now, not coming.
    Open,
}

/// A special day of the calendar, coming up or under way, with no olay yet (design 2026-11-18
/// §5). The system opens no olay for it (spec 2026-11-03 D3, D25): from `prepares_from` the
/// calendar trigger makes content for the confirmed olay of its occasion and season year once that
/// olay has a usable file, and while there is none it asks for a capture on the çekim listesi
/// (`shoot_request_id`). A person opens the olay, or confirms one an agent proposed.
#[derive(Clone, Debug, Serialize)]
pub struct UpcomingDay {
    pub key: String,
    pub year: i32,
    pub name: String,
    pub kind: OccasionKind,
    #[serde(with = "jt_studio::time_compat::date")]
    pub window_start: Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub window_end: Date,
    /// When the system starts preparing for it: the window's start less its lead.
    #[serde(with = "jt_studio::time_compat::date")]
    pub prepares_from: Date,
    pub phase: DayPhase,
    /// The çekim listesi's open request for it (`season:{key}:{year}`), once the calendar trigger
    /// asked for a capture because it has no olay with a usable file.
    pub shoot_request_id: Option<Uuid>,
}

/// "Sizi bekleyenler": what waits for a person across the workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct WaitingCounts {
    /// Olays an agent opened, waiting for a person's confirmation.
    pub olay_confirmations: u32,
    /// Open captures asked for: the çekim listesi's and the areas' own requests.
    pub shoot_requests: u32,
    /// Planned posts of the contents waiting for a person's approval.
    pub content_approvals: u32,
    /// Finished contents waiting for an account and a time some account can take (the agent's
    /// next run gives them, or a person does). One no account can take is a problem instead.
    pub content_times: u32,
    /// Contents that are stuck.
    pub problem_contents: u32,
}

/// `content.tree`'s answer.
#[derive(Clone, Debug, Serialize)]
pub struct TreeOut {
    /// Every olay, newest start first.
    pub olays: Vec<TreeOlay>,
    /// The permanent "Genel" folder: the materials bound genel and the areas of no olay.
    pub genel: Folder,
    pub upcoming: Vec<UpcomingDay>,
    /// What "Analiz sırası" lists ([`analysis_queue`]).
    pub analysis_queue: u32,
    /// Every area not archived ("Tüm üretim").
    pub areas: u32,
    pub waiting: WaitingCounts,
}

/// Where a material is in the analysis queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueStage {
    /// No agent has taken it (with no agent connected it stays here).
    Waiting,
    /// An agent is analysing it now.
    Analysing,
    /// Analysed, but nobody filed it: a person files it.
    NeedsFiling,
    /// The analysis failed; it waits for a retry or a person.
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct QueueItem {
    pub material: Material,
    pub intelligence: MaterialIntelligence,
    pub unfiled: bool,
    pub stage: QueueStage,
}

/// `content.analysis_queue`'s answer, oldest upload first.
#[derive(Clone, Debug, Serialize)]
pub struct QueueOut {
    pub items: Vec<QueueItem>,
}

/// An area as the production line shows it: what a row needs, without the documents' history.
#[derive(Clone, Debug, Serialize)]
pub struct AreaSummary {
    pub id: Uuid,
    pub title: String,
    pub brief: String,
    pub olay_id: Option<OlayId>,
    pub opened_by: OpenedBy,
    pub hints: AreaHints,
    pub status: AreaStatus,
    pub revision: u64,
    pub redo: Option<RedoRequest>,
    /// The captures its agent asked for that nobody supplied yet.
    pub open_requests: u32,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, Serialize)]
pub struct AreaRow {
    pub area: AreaSummary,
    pub pipeline: Pipeline,
    /// For a content that names its accounts, what stands between it and a post on each
    /// (design 2026-11-19 F3): the account's stops and whether its materials are what the
    /// platform takes. Empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<crate::usecases::social::ready::AccountStops>,
}

/// `content.areas`' answer: a page of the production line, as `studio.project_list` pages it.
#[derive(Clone, Debug, Serialize)]
pub struct AreasOut {
    pub areas: Vec<AreaRow>,
    pub next_cursor: Option<Uuid>,
    pub next_done_before: Option<String>,
}

/// The input of `content.olay_view`: an olay's id, or `genel`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayViewInput {
    pub olay_id: OlayFilter,
}

/// An olay's flow, left to right.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Flow {
    pub files: u32,
    /// Files whose analysis is complete.
    pub analysed: u32,
    /// Files whose analysis is waiting, running or failed.
    pub in_queue: u32,
    pub contents: u32,
    /// Contents not finished yet: queued, worked, waiting for a capture, held.
    pub in_production: u32,
    /// Finished contents waiting for an account and a time ([`Pipeline::awaits_time`]).
    pub awaiting_time: u32,
    pub awaiting_approval: u32,
    pub published: u32,
    pub problems: u32,
}

/// A file of the olay with its analysis and the areas that use it (as a source, in a step, or
/// in a version of their current package).
#[derive(Clone, Debug, Serialize)]
pub struct FileRow {
    pub material: Material,
    pub intelligence: MaterialIntelligence,
    pub used_in: Vec<Uuid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedKind {
    /// The çekim listesi's request.
    ShootRequest,
    /// A capture an agent working one of the olay's contents asked for.
    MaterialRequest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedStatus {
    Open,
    Done,
    Dismissed,
}

/// One of an olay's "Eksikler": what is asked, by whom, and how it ended.
#[derive(Clone, Debug, Serialize)]
pub struct Need {
    pub kind: NeedKind,
    /// The shoot request's id, or the area request's.
    pub id: Uuid,
    pub text: String,
    pub status: NeedStatus,
    #[serde(with = "jt_studio::time_compat")]
    pub created_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat::option")]
    pub resolved_at: Option<OffsetDateTime>,
    /// The content that asked (a material request's area).
    pub project_id: Option<Uuid>,
    pub project_title: Option<String>,
    /// What answered it (a material request's materials).
    pub material_ids: Vec<MaterialId>,
    /// Who asked (a shoot request's maker).
    pub asked_by: Option<Actor>,
}

/// `content.olay_view`'s answer. `contents` needs `content.work` or `content.manage`, `files`
/// needs `materials.work`: each is `null` for a caller without its permission. Without
/// `materials.work` the olay is its identity alone ([`OlayOut`]) and `needs` holds no çekim
/// listesi request (a material request, with its content's title, stays: whoever supplies the
/// capture is told what it is for).
#[derive(Clone, Debug, Serialize)]
pub struct OlayViewOut {
    /// The olay; `null` for "Genel".
    pub olay: Option<OlayOut>,
    pub flow: Flow,
    pub contents: Option<Vec<AreaRow>>,
    pub files: Option<Vec<FileRow>>,
    pub needs: Vec<Need>,
}

/// A tenant bundle of an active workspace for a caller holding one of `permissions`.
async fn open(
    d: &Deps,
    ctx: &Ctx,
    permissions: &[Permission],
) -> Result<Box<dyn TenantRepos>, AppError> {
    ctx.require_any(permissions)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    crate::usecases::studio::chain::active(r.as_mut()).await?;
    Ok(r)
}

fn has_any(ctx: &Ctx, permissions: &[Permission]) -> bool {
    permissions.iter().any(|p| ctx.permissions.contains(p))
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Every area of `olay` not archived, newest first: the store's olay filter (its index), page
/// by page, with no cap.
async fn olay_areas(
    r: &mut dyn TenantRepos,
    olay: AreaOlay,
) -> Result<Vec<ProductionProject>, AppError> {
    let mut out: Vec<ProductionProject> = Vec::new();
    let mut before = None;
    loop {
        let page = r
            .studio_projects()
            .list_projects(false, before, Some(olay))
            .await?;
        let more = page.len() > 100;
        out.extend(page.into_iter().take(100));
        if !more {
            return Ok(out);
        }
        before = out.last().map(|p| p.id);
    }
}

/// The versions of each of `areas`' finished packages that wait for a time, by area, with the
/// accounts that could take each and why none can (as `social.versions_waiting` says it); the
/// strategy and the channels are read once, and only when some version waits.
async fn time_waits<'p>(
    d: &Deps,
    r: &mut dyn TenantRepos,
    areas: impl IntoIterator<Item = &'p ProductionProject>,
    now: OffsetDateTime,
) -> Result<BTreeMap<Uuid, Vec<TimeWait>>, AppError> {
    let mut out = BTreeMap::new();
    let mut reader: Option<VersionAccounts> = None;
    for p in areas {
        let mut waits = Vec::new();
        for v in p.waiting_versions() {
            if reader.is_none() {
                reader = Some(VersionAccounts::load(d, r, now).await?);
            }
            let Some(accounts_of) = reader.as_ref() else {
                continue;
            };
            let (choices, blocked) = accounts_of.of(d, r, p, v, now).await?;
            waits.push(TimeWait {
                version_id: v.id,
                format: v.format,
                capability_id: v.capability_id,
                accounts: choices.iter().map(|c| c.capability_id).collect(),
                blocked,
            });
        }
        if !waits.is_empty() {
            out.insert(p.id, waits);
        }
    }
    Ok(out)
}

/// The areas with their pipelines at `now`; their planned posts are read once for all of them.
async fn rows(
    d: &Deps,
    r: &mut dyn TenantRepos,
    areas: Vec<ProductionProject>,
    now: OffsetDateTime,
) -> Result<Vec<AreaRow>, AppError> {
    let posts: Vec<Vec<AreaPost>> = areas.iter().map(ProductionProject::posts).collect();
    let slots: Vec<SlotId> = posts.iter().flatten().map(|p| p.slot_id).collect();
    let reads = PostReads::load(r, &slots).await?;
    let mut waits = time_waits(d, r, &areas, now).await?;
    // What each content naming its accounts would meet there, read once for all of them.
    let mut checks = BTreeMap::new();
    if areas
        .iter()
        .any(|p| !p.archived && !p.hints.capability_ids.is_empty())
    {
        let ready = crate::usecases::social::ready::Reader::load(r).await?;
        for p in &areas {
            let list = ready.area(d, r, p, now).await?;
            if !list.is_empty() {
                checks.insert(p.id, list);
            }
        }
    }
    Ok(areas
        .into_iter()
        .zip(posts)
        .map(|(p, posts)| {
            let facts = reads.facts(&posts);
            let unscheduled = waits.remove(&p.id).unwrap_or_default();
            let pipeline = pipeline::project(&p, now, &facts, unscheduled);
            let checks = checks.remove(&p.id).unwrap_or_default();
            row(p, now, pipeline, checks)
        })
        .collect())
}

fn row(
    p: ProductionProject,
    now: OffsetDateTime,
    pipeline: Pipeline,
    checks: Vec<crate::usecases::social::ready::AccountStops>,
) -> AreaRow {
    let open_requests = count(
        p.requests
            .iter()
            .filter(|q| q.status == RequestStatus::Open)
            .count(),
    );
    let p = p.present(now);
    AreaRow {
        area: AreaSummary {
            status: p.state.clone().unwrap_or(AreaStatus {
                state: p.state(now),
                step: None,
                note: None,
                starts_at: p.starts_at(),
            }),
            id: p.id,
            title: p.title,
            brief: p.brief,
            olay_id: p.olay_id,
            opened_by: p.opened_by,
            hints: p.hints,
            revision: p.revision,
            redo: p.redo,
            open_requests,
            created_at: p.created_at,
            updated_at: p.updated_at,
        },
        pipeline,
        checks,
    }
}

/// The olay a material belongs to in the tree: its olay, or `None` for genel. Unfiled materials
/// belong to no folder (they are the analysis queue's).
fn folder_of(m: &Material) -> Option<Option<OlayId>> {
    match m.binding {
        Binding::Olay { olay_id } => Some(Some(olay_id)),
        Binding::Genel => Some(None),
        Binding::Unfiled => None,
    }
}

/// The olay a shoot request asks for, when it asks for one: an upcoming olay's, or the olay of
/// the occasion and season year of a season's request. `None`: the workspace's ("Genel").
fn shoot_olay(
    reason: &ShootReason,
    olays: &[Olay],
    season_year: &dyn Fn(&Olay) -> Option<i32>,
) -> Option<OlayId> {
    match reason {
        ShootReason::OlayUpcoming { olay_id } => Some(*olay_id),
        ShootReason::SeasonAhead { occasion, year } => olays
            .iter()
            .find(|o| o.occasion.as_deref() == Some(occasion) && season_year(o) == Some(*year))
            .map(|o| o.id),
        _ => None,
    }
}

/// What the analysis queue holds at `now`: an unfiled material whatever its analysis, and a
/// filed one whose analysis waits or runs.
fn queue_stage(m: &Material, i: &MaterialIntelligence, leased: bool) -> Option<QueueStage> {
    if m.erased_at.is_some() {
        return None;
    }
    let stage = match i.status {
        AnalysisStatus::Pending => QueueStage::Waiting,
        AnalysisStatus::Running if leased => QueueStage::Analysing,
        AnalysisStatus::Running => QueueStage::Waiting,
        AnalysisStatus::Completed => QueueStage::NeedsFiling,
        AnalysisStatus::Failed => QueueStage::Failed,
    };
    match stage {
        QueueStage::Waiting | QueueStage::Analysing => Some(stage),
        _ if m.is_unfiled() => Some(stage),
        _ => None,
    }
}

/// Every live material with its analysis, by id.
async fn analyses(
    r: &mut dyn TenantRepos,
    now: OffsetDateTime,
) -> Result<Vec<(Material, MaterialIntelligence, bool)>, AppError> {
    let rows: BTreeMap<MaterialId, _> = r
        .studio_materials()
        .list_intelligence()
        .await?
        .into_iter()
        .map(|row| (row.material_id, row))
        .collect();
    Ok(r.studio_materials()
        .list_materials()
        .await?
        .into_iter()
        .filter(|m| m.erased_at.is_none())
        .map(|m| {
            let row = rows.get(&m.id);
            let leased = row
                .and_then(|x| x.lease.as_ref())
                .is_some_and(|l| l.expires_at > now);
            let intelligence = library::intelligence_of(&m, row, now);
            (m, intelligence, leased)
        })
        .collect())
}

/// `content.analysis_queue` (panel, `materials.work`): "Analiz sırası", oldest first. With no
/// agent connected a material simply stays `waiting`.
pub async fn analysis_queue(d: &Deps, ctx: &Ctx) -> Result<QueueOut, AppError> {
    let mut r = open(d, ctx, &[Permission::MaterialsWork]).await?;
    let mut items: Vec<QueueItem> = analyses(r.as_mut(), ctx.now)
        .await?
        .into_iter()
        .filter_map(|(m, i, leased)| {
            queue_stage(&m, &i, leased).map(|stage| QueueItem {
                unfiled: m.is_unfiled(),
                material: m,
                intelligence: i,
                stage,
            })
        })
        .collect();
    items.sort_by_key(|i| (i.material.created_at, i.material.id));
    Ok(QueueOut { items })
}

fn count64(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// What the tree counts of the areas, without reading their documents whole: how many each olay
/// holds and their open captures, counted in the store; and, for the areas that are held or have
/// planned posts, their [`pipeline::Marks`], from the same rules as their pipelines.
struct AreaTally {
    counts: Vec<AreaCount>,
    marks: Vec<(Option<OlayId>, pipeline::Marks)>,
}

impl AreaTally {
    async fn read(
        d: &Deps,
        r: &mut dyn TenantRepos,
        now: OffsetDateTime,
    ) -> Result<Self, AppError> {
        let counts = r.studio_projects().area_counts().await?;
        let noted = r.studio_projects().area_posts().await?;
        // The finished areas whose versions wait for a time, planned posts or none.
        let waiting = r.studio_projects().list_areas_waiting().await?;
        let waits = time_waits(d, r, &waiting, now).await?;
        let slots: Vec<SlotId> = noted
            .iter()
            .flat_map(|a| a.posts.iter().map(|p| p.slot_id))
            .collect();
        let reads = PostReads::load(r, &slots).await?;
        let none = Vec::new();
        let mut marks: Vec<(Option<OlayId>, pipeline::Marks)> = noted
            .iter()
            .map(|a| {
                let unscheduled = waits.get(&a.id).unwrap_or(&none);
                (
                    a.olay_id,
                    pipeline::marks(a.held, a.done, &reads.facts(&a.posts), unscheduled),
                )
            })
            .collect();
        for p in waiting
            .iter()
            .filter(|p| !noted.iter().any(|a| a.id == p.id))
        {
            if let Some(unscheduled) = waits.get(&p.id) {
                marks.push((p.olay_id, pipeline::marks(p.held(), true, &[], unscheduled)));
            }
        }
        Ok(AreaTally { counts, marks })
    }

    fn of(&self, olay: Option<OlayId>) -> Option<&AreaCount> {
        self.counts.iter().find(|c| c.olay_id == olay)
    }

    fn marks_of(&self, olay: Option<OlayId>) -> impl Iterator<Item = &pipeline::Marks> {
        self.marks
            .iter()
            .filter(move |(o, _)| *o == olay)
            .map(|(_, m)| m)
    }
}

/// `content.tree` (panel; `materials.work`, `content.work` or `content.manage`): the folders, what
/// waits for a person, the special days coming up with no olay, and the analysis queue's size.
pub async fn tree(d: &Deps, ctx: &Ctx) -> Result<TreeOut, AppError> {
    let mut r = open(d, ctx, PAGE_PERMISSIONS).await?;
    let now = ctx.now;
    let lib = crate::usecases::studio::materials::library(r.as_mut(), now).await?;
    let materials = analyses(r.as_mut(), now).await?;
    let analysis_queue = count(
        materials
            .iter()
            .filter(|(m, i, leased)| queue_stage(m, i, *leased).is_some())
            .count(),
    );
    let tally = AreaTally::read(d, r.as_mut(), now).await?;
    let full = ctx.permissions.contains(&Permission::MaterialsWork);
    let shoots: Vec<_> = r
        .studio_materials()
        .list_shoot_requests()
        .await?
        .into_iter()
        .filter(|q| q.status == ShootStatus::Open)
        .collect();
    let season_year = |o: &Olay| {
        o.occasion
            .as_deref()
            .and_then(|k| lib.calendar.season_year(k, o.starts_on))
    };
    let folder = |olay: Option<OlayId>| {
        let counted = tally.of(olay);
        let mut waits = BTreeSet::new();
        if olay.is_some_and(|id| {
            lib.olays
                .iter()
                .any(|o| o.id == id && o.status == OlayStatus::Proposed)
        }) {
            waits.insert(WaitReason::OlayProposed);
        }
        if shoots
            .iter()
            .any(|q| shoot_olay(&q.reason, &lib.olays, &season_year) == olay)
        {
            waits.insert(WaitReason::ShootRequest);
        }
        if counted.is_some_and(|c| c.open_requests > 0) {
            waits.insert(WaitReason::MaterialRequest);
        }
        let mut published = 0;
        for m in tally.marks_of(olay) {
            if m.awaits_approval {
                waits.insert(WaitReason::ContentApproval);
            }
            if m.awaits_time {
                waits.insert(WaitReason::ContentTime);
            }
            if m.problem {
                waits.insert(WaitReason::ContentProblem);
            }
            published += usize::from(m.published);
        }
        Folder {
            files: count(
                materials
                    .iter()
                    .filter(|(m, _, _)| folder_of(m) == Some(olay))
                    .count(),
            ),
            areas: count64(counted.map_or(0, |c| c.areas)),
            published: count(published),
            waits: waits.into_iter().collect(),
        }
    };
    let olays: Vec<TreeOlay> = lib
        .olays
        .iter()
        .map(|o| TreeOlay {
            olay: OlayOut::of(o.clone(), full),
            folder: folder(Some(o.id)),
        })
        .collect();
    let genel = folder(None);
    let policy = r.studio_materials().material_policy().await?;
    let today = istanbul_day(now);
    let season_request = |key: &str, year: i32| {
        shoots
            .iter()
            .find(|q| {
                matches!(&q.reason, ShootReason::SeasonAhead { occasion, year: y }
                    if occasion == key && *y == year)
            })
            .map(|q| ShootRequestId::as_uuid(&q.id))
    };
    let mut upcoming: Vec<UpcomingDay> = lib
        .calendar
        .entries
        .iter()
        .filter_map(|e: &CalendarEntry| {
            let (start, end) = e.window()?;
            let covered = lib.olays.iter().any(|o| {
                o.occasion.as_deref() == Some(e.key.as_str()) && season_year(o) == Some(e.year)
            });
            let prepares_from =
                start - Duration::days(i64::from(e.lead_days.unwrap_or(policy.lead_days)));
            (end >= today && start <= today + Duration::days(UPCOMING_DAYS) && !covered).then(
                || UpcomingDay {
                    key: e.key.clone(),
                    year: e.year,
                    name: e.name.clone(),
                    kind: e.kind,
                    window_start: start,
                    window_end: end,
                    prepares_from,
                    phase: if start <= today {
                        DayPhase::Open
                    } else if prepares_from <= today {
                        DayPhase::Preparing
                    } else {
                        DayPhase::Ahead
                    },
                    shoot_request_id: season_request(&e.key, e.year),
                },
            )
        })
        .collect();
    upcoming.sort_by_key(|u| (u.window_start, u.key.clone()));
    let open_area_requests: u64 = tally.counts.iter().map(|c| c.open_requests).sum();
    let waiting = WaitingCounts {
        olay_confirmations: count(
            lib.olays
                .iter()
                .filter(|o| o.status == OlayStatus::Proposed)
                .count(),
        ),
        shoot_requests: count64(shoots.len() as u64 + open_area_requests),
        content_approvals: count(tally.marks.iter().map(|(_, m)| m.approvals_waiting).sum()),
        content_times: count(tally.marks.iter().filter(|(_, m)| m.awaits_time).count()),
        problem_contents: count(tally.marks.iter().filter(|(_, m)| m.problem).count()),
    };
    Ok(TreeOut {
        olays,
        genel,
        upcoming,
        analysis_queue,
        areas: count64(tally.counts.iter().map(|c| c.areas).sum()),
        waiting,
    })
}

/// `content.areas` (panel; `content.work` or `content.manage`): a page of the production line
/// (`studio.project_list`'s query: `scope`, cursors, `archived`, and `olay_id`, an olay's id or
/// `genel`), each area with its pipeline.
pub async fn areas(d: &Deps, ctx: &Ctx, q: ProjectQuery) -> Result<AreasOut, AppError> {
    let mut r = open(d, ctx, AREA_PERMISSIONS).await?;
    let page = projects::list_in(r.as_mut(), q, ctx.now).await?;
    Ok(AreasOut {
        areas: rows(d, r.as_mut(), page.projects, ctx.now).await?,
        next_cursor: page.next_cursor,
        next_done_before: page.next_done_before,
    })
}

/// Whether an area of `rows` uses `material`: a source, a step's choice, or a version of its
/// current package.
fn uses(p: &ProductionProject, material: MaterialId) -> bool {
    p.sources.iter().any(|s| s.material_id == material)
        || p.steps.iter().any(|s| s.material_ids.contains(&material))
        || p.packages.last().is_some_and(|k| {
            k.versions
                .iter()
                .any(|v| v.material_ids.contains(&material))
        })
}

/// `content.olay_view` (panel and MCP; `materials.work`, `content.work` or `content.manage`):
/// one olay, or `genel`, with its flow, its contents and their pipelines (with a content
/// permission), its files (with `materials.work`), and its "Eksikler": the çekim listesi's
/// requests for it and the captures its contents' agents asked for, open ones and those
/// resolved in the last [`RESOLVED_NEEDS_DAYS`] days.
pub async fn olay_view(d: &Deps, ctx: &Ctx, i: OlayViewInput) -> Result<OlayViewOut, AppError> {
    let mut r = open(d, ctx, PAGE_PERMISSIONS).await?;
    let now = ctx.now;
    let target = match i.olay_id.0 {
        AreaOlay::Olay(id) => Some(id),
        AreaOlay::Genel => None,
    };
    // The library's reader sees the olay whole and the çekim listesi; anyone else its identity.
    let library_reader = ctx.permissions.contains(&Permission::MaterialsWork);
    let lib = crate::usecases::studio::materials::library(r.as_mut(), now).await?;
    let olay = match target {
        Some(id) => Some(
            lib.olays
                .iter()
                .find(|o| o.id == id)
                .cloned()
                .ok_or_else(|| AppError::not_found("olay"))?,
        ),
        None => None,
    };
    let mine: Vec<ProductionProject> = olay_areas(r.as_mut(), i.olay_id.0).await?;
    let recent = |at: Option<OffsetDateTime>| {
        at.is_none_or(|at| at >= now - Duration::days(RESOLVED_NEEDS_DAYS))
    };
    let season_year = |o: &Olay| {
        o.occasion
            .as_deref()
            .and_then(|k| lib.calendar.season_year(k, o.starts_on))
    };
    let shoots = if library_reader {
        r.studio_materials().list_shoot_requests().await?
    } else {
        Vec::new()
    };
    let mut needs: Vec<Need> = shoots
        .into_iter()
        .filter(|q| {
            shoot_olay(&q.reason, &lib.olays, &season_year) == target
                && (q.status == ShootStatus::Open || recent(q.resolved_at))
        })
        .map(|q| Need {
            kind: NeedKind::ShootRequest,
            id: ShootRequestId::as_uuid(&q.id),
            text: q.text,
            status: match q.status {
                ShootStatus::Open => NeedStatus::Open,
                ShootStatus::Done => NeedStatus::Done,
                ShootStatus::Dismissed => NeedStatus::Dismissed,
            },
            created_at: q.created_at,
            resolved_at: q.resolved_at,
            project_id: None,
            project_title: None,
            material_ids: Vec::new(),
            asked_by: Some(q.created_by),
        })
        .collect();
    for p in &mine {
        for q in &p.requests {
            if q.status != RequestStatus::Open && !recent(q.resolved_at) {
                continue;
            }
            needs.push(Need {
                kind: NeedKind::MaterialRequest,
                id: q.id,
                text: q.text.clone(),
                status: match q.status {
                    RequestStatus::Open => NeedStatus::Open,
                    RequestStatus::Done => NeedStatus::Done,
                    RequestStatus::Dismissed => NeedStatus::Dismissed,
                },
                created_at: q.created_at,
                resolved_at: q.resolved_at,
                project_id: Some(p.id),
                project_title: Some(p.title.clone()),
                material_ids: q.material_ids.clone(),
                asked_by: None,
            });
        }
    }
    needs.sort_by_key(|n| {
        (
            n.status != NeedStatus::Open,
            std::cmp::Reverse(n.created_at),
        )
    });
    let materials: Vec<_> = analyses(r.as_mut(), now)
        .await?
        .into_iter()
        .filter(|(m, _, _)| folder_of(m) == Some(target))
        .collect();
    let contents = rows(d, r.as_mut(), mine.clone(), now).await?;
    let analysed = materials
        .iter()
        .filter(|(_, i, _)| i.status == AnalysisStatus::Completed)
        .count();
    let flow = Flow {
        files: count(materials.len()),
        analysed: count(analysed),
        in_queue: count(materials.len() - analysed),
        contents: count(contents.len()),
        in_production: count(
            contents
                .iter()
                .filter(|a| {
                    matches!(
                        a.area.status.state,
                        AreaState::Queued
                            | AreaState::Working
                            | AreaState::WaitingMaterial
                            | AreaState::Held
                    )
                })
                .count(),
        ),
        awaiting_time: count(contents.iter().filter(|a| a.pipeline.awaits_time()).count()),
        awaiting_approval: count(
            contents
                .iter()
                .filter(|a| a.pipeline.awaits_approval())
                .count(),
        ),
        published: count(contents.iter().filter(|a| a.pipeline.published()).count()),
        problems: count(contents.iter().filter(|a| a.pipeline.has_problem()).count()),
    };
    let files = library_reader.then(|| {
        materials
            .into_iter()
            .map(|(material, intelligence, _)| FileRow {
                used_in: mine
                    .iter()
                    .filter(|p| uses(p, material.id))
                    .map(|p| p.id)
                    .collect(),
                material,
                intelligence,
            })
            .collect()
    });
    Ok(OlayViewOut {
        olay: olay.map(|o| OlayOut::of(o, library_reader)),
        flow,
        contents: has_any(ctx, AREA_PERMISSIONS).then_some(contents),
        files,
        needs,
    })
}

/// The input schema of `content.<name>` for the page's reads.
pub fn schema(name: &str) -> serde_json::Value {
    use serde_json::json;
    match name {
        "olay_view" => json!({"type":"object","additionalProperties":false,
            "properties":{"olay_id":{"anyOf":[{"type":"string","format":"uuid"},{"const":"genel"}],
                "description":"The olay's id (jeeta.studio.olays_list), or genel for the materials bound genel and the contents of no olay."}},
            "required":["olay_id"]}),
        _ => panic!("unknown content view schema"),
    }
}
