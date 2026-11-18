//! The content page's read model (design 2026-11-18 §5): one module, the olay at its root. The
//! tree of olays with what waits for a person, the analysis queue, the production line with each
//! area's pipeline, and one olay's view (its flow, contents, files and "Eksikler"), each in one
//! call. Nothing here writes.
use super::pipeline::{self, Accounts, Pipeline, VersionFact};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        materials::{AnalysisStatus, Material, MaterialIntelligence, Olay, OlayStatus},
        production_projects::*,
    },
    usecases::{
        Deps,
        studio::{
            library,
            projects::{self, OlayFilter, ProjectQuery},
        },
    },
};
use jt_ledger::Actor;
use jt_studio::{
    Binding, CalendarEntry, MaterialId, OccasionKind, OlayId, Publication, ShootReason,
    ShootRequestId, ShootStatus, istanbul_day,
};
use jt_tenancy::Permission;
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
/// The most areas the page reads at once.
const MAX_AREAS: usize = 2000;

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
    pub olay: Olay,
    #[serde(flatten)]
    pub folder: Folder,
}

/// A special day of the calendar coming up with no olay yet (design 2026-11-18 §5).
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
/// needs `materials.work`: each is `null` for a caller without its permission.
#[derive(Clone, Debug, Serialize)]
pub struct OlayViewOut {
    /// The olay; `null` for "Genel".
    pub olay: Option<Olay>,
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

/// Every area not archived, newest first, up to [`MAX_AREAS`].
async fn live_areas(r: &mut dyn TenantRepos) -> Result<Vec<ProductionProject>, AppError> {
    let mut out: Vec<ProductionProject> = Vec::new();
    let mut before = None;
    loop {
        let page = r
            .studio_projects()
            .list_projects(false, before, None)
            .await?;
        let more = page.len() > 100;
        out.extend(page.into_iter().take(100));
        if !more || out.len() >= MAX_AREAS {
            return Ok(out);
        }
        before = out.last().map(|p| p.id);
    }
}

/// The areas with their pipelines at `now`.
async fn rows(
    r: &mut dyn TenantRepos,
    areas: Vec<ProductionProject>,
    now: OffsetDateTime,
) -> Result<Vec<AreaRow>, AppError> {
    let publications: Vec<Publication> = if areas.iter().any(|p| p.done_at().is_some()) {
        r.studio().list_publications().await?
    } else {
        Vec::new()
    };
    let mut accounts = Accounts::new();
    let mut out = Vec::with_capacity(areas.len());
    for p in areas {
        let facts: Vec<VersionFact> =
            pipeline::version_facts(r, &p, &publications, &mut accounts).await?;
        let pipeline = pipeline::project(&p, now, &facts);
        out.push(row(p, now, pipeline));
    }
    Ok(out)
}

fn row(p: ProductionProject, now: OffsetDateTime, pipeline: Pipeline) -> AreaRow {
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

/// Why the areas of a folder wait for a person, from their rows.
fn area_waits(rows: &[&AreaRow], waits: &mut BTreeSet<WaitReason>) {
    for row in rows {
        if row.area.open_requests > 0 {
            waits.insert(WaitReason::MaterialRequest);
        }
        if row.pipeline.awaits_approval() {
            waits.insert(WaitReason::ContentApproval);
        }
        if row.pipeline.has_problem() {
            waits.insert(WaitReason::ContentProblem);
        }
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
    let live = live_areas(r.as_mut()).await?;
    let areas = rows(r.as_mut(), live, now).await?;
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
        let mine: Vec<&AreaRow> = areas.iter().filter(|a| a.area.olay_id == olay).collect();
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
        area_waits(&mine, &mut waits);
        Folder {
            files: count(
                materials
                    .iter()
                    .filter(|(m, _, _)| folder_of(m) == Some(olay))
                    .count(),
            ),
            areas: count(mine.len()),
            published: count(mine.iter().filter(|a| a.pipeline.published()).count()),
            waits: waits.into_iter().collect(),
        }
    };
    let olays: Vec<TreeOlay> = lib
        .olays
        .iter()
        .map(|o| TreeOlay {
            olay: o.clone(),
            folder: folder(Some(o.id)),
        })
        .collect();
    let genel = folder(None);
    let policy = r.studio_materials().material_policy().await?;
    let today = istanbul_day(now);
    let mut upcoming: Vec<UpcomingDay> = lib
        .calendar
        .entries
        .iter()
        .filter_map(|e: &CalendarEntry| {
            let (start, end) = e.window()?;
            let covered = lib.olays.iter().any(|o| {
                o.occasion.as_deref() == Some(e.key.as_str()) && season_year(o) == Some(e.year)
            });
            (end >= today && start <= today + Duration::days(UPCOMING_DAYS) && !covered).then(
                || UpcomingDay {
                    key: e.key.clone(),
                    year: e.year,
                    name: e.name.clone(),
                    kind: e.kind,
                    window_start: start,
                    window_end: end,
                    prepares_from: start
                        - Duration::days(i64::from(e.lead_days.unwrap_or(policy.lead_days))),
                },
            )
        })
        .collect();
    upcoming.sort_by_key(|u| (u.window_start, u.key.clone()));
    let open_area_requests: usize = areas.iter().map(|a| a.area.open_requests as usize).sum();
    let waiting = WaitingCounts {
        olay_confirmations: count(
            lib.olays
                .iter()
                .filter(|o| o.status == OlayStatus::Proposed)
                .count(),
        ),
        shoot_requests: count(shoots.len() + open_area_requests),
        content_approvals: count(
            areas
                .iter()
                .flat_map(|a| a.pipeline.stage(pipeline::StageKey::Onay))
                .flat_map(|s| s.approvals.iter())
                .filter(|a| a.waiting)
                .count(),
        ),
        problem_contents: count(areas.iter().filter(|a| a.pipeline.has_problem()).count()),
    };
    Ok(TreeOut {
        olays,
        genel,
        upcoming,
        analysis_queue,
        areas: count(areas.len()),
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
        areas: rows(r.as_mut(), page.projects, ctx.now).await?,
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
    let mine: Vec<ProductionProject> = live_areas(r.as_mut())
        .await?
        .into_iter()
        .filter(|p| p.olay_id == target)
        .collect();
    let recent = |at: Option<OffsetDateTime>| {
        at.is_none_or(|at| at >= now - Duration::days(RESOLVED_NEEDS_DAYS))
    };
    let season_year = |o: &Olay| {
        o.occasion
            .as_deref()
            .and_then(|k| lib.calendar.season_year(k, o.starts_on))
    };
    let mut needs: Vec<Need> = r
        .studio_materials()
        .list_shoot_requests()
        .await?
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
    let contents = rows(r.as_mut(), mine.clone(), now).await?;
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
        awaiting_approval: count(
            contents
                .iter()
                .filter(|a| a.pipeline.awaits_approval())
                .count(),
        ),
        published: count(contents.iter().filter(|a| a.pipeline.published()).count()),
        problems: count(contents.iter().filter(|a| a.pipeline.has_problem()).count()),
    };
    let files = ctx
        .permissions
        .contains(&Permission::MaterialsWork)
        .then(|| {
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
        olay,
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
