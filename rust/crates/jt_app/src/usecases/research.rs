//! Research tasks (spec 2026-10-30-leads-pool-outreach-design.md §3.7; §7.1 `research.*`; the
//! `research_plan` job): the briefs agents fill the prospect pool from, with their caps and an
//! advisory claim. Jeeta never researches: a task tells a connected agent what to look for, and
//! the agent records what it finds with `jeeta.prospects.create`.
//!
//! - **Standing tasks**: one open task per ICP entry of the approved strategy version, kept by
//!   the planner ([`plan_in`]: the hourly job, and `strategy.approve` in its own transaction),
//!   recorded by `Recorder::System { job: "research_plan" }`. A newer version supersedes the open
//!   standing tasks of the older ones; nobody closes a standing task by hand (its ICP entry is
//!   the strategy's, spec D38).
//! - **Ad-hoc tasks** (`research.tasks_create`): a person's or an agent's brief and target,
//!   while prospecting is on; done by themselves once `target_count` prospects are recorded
//!   (`prospects.create` checks it), or closed by hand. A newer strategy version leaves them
//!   open.
//! - **Remaining today**: `jt_prospects::remaining_today` over the workspace's local day.
//!
//! None of these takes the pool lock; the leads policy is read without a lock. A request key
//! stores `{task_id}` only. Ledger entries (`research.task_created | task_claimed | task_closed`)
//! carry ids, kinds, outcomes and ICP keys, never a brief's text.

use jt_ledger::Actor;
use jt_prospects::{
    Brief, CLAIM_LEASE, Capacity, Claim, ResearchTask, ResearchTaskId, TaskKind, TaskStatus,
    remaining_today, standing_brief, validate_ad_hoc, validate_brief,
};
use jt_strategy::StrategyVersion;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::prospects::pool::NextPage;
use super::prospects::{invalid_from, leads_policy, recorder, refused, rubric_digest};
use super::{Deps, hours, invalid, keyset_cursor};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::prospects::{
    ListCursor, MAX_PROSPECT_PAGE, ProspectQuery, ProspectRow, ResearchTaskQuery,
};

/// The prefix that keeps a task creation's request keys apart from every other operation's.
pub const REQUEST_KEY_PREFIX: &str = "research.tasks_create:";

/// The job that keeps the standing tasks, and records them.
pub const PLANNER: &str = "research_plan";

/// The newest prospects `research.tasks_get` answers with.
const TASK_PROSPECTS: u32 = 20;

/// The longest note a task is closed with, in characters.
const MAX_CLOSE_NOTE_CHARS: usize = 1_000;

/// A task and what it may still record today.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskOut {
    pub task: ResearchTask,
    pub remaining_today: u32,
}

/// The approved strategy version in force, with prospecting on (ICP entries and a rubric), if
/// any.
pub(crate) async fn prospecting_version(
    r: &mut dyn TenantRepos,
) -> Result<Option<StrategyVersion>, AppError> {
    Ok(r.strategy()
        .current_approved()
        .await?
        .filter(prospecting_on))
}

/// Whether `v` has prospecting on: ICP entries (an empty ICP is the off switch) and a rubric.
pub(crate) fn prospecting_on(v: &StrategyVersion) -> bool {
    let p = &v.sections.prospecting;
    !p.icp.is_empty() && !p.rubric.criteria.is_empty()
}

/// `CONFLICT {reason: prospecting_off}`.
pub(crate) fn prospecting_off() -> AppError {
    refused(
        ErrorCode::Conflict,
        "prospecting_off",
        "the approved strategy has no prospecting (no ICP entry)",
        json!({}),
    )
}

/// What `task` may still record today at `now` in time zone `tz`, under `version` (the approved
/// one, for a standing task's ICP entry and its backlog target). Zero for a closed task.
pub(crate) async fn remaining(
    r: &mut dyn TenantRepos,
    tz: &str,
    task: &ResearchTask,
    version: Option<&StrategyVersion>,
    now: OffsetDateTime,
) -> Result<u32, AppError> {
    if task.status != TaskStatus::Open {
        return Ok(0);
    }
    let (from, to) = hours::local_day(tz, now)?;
    let recorded_today = r
        .prospects()
        .created_between(Some(task.id), from, to)
        .await?;
    let workspace_today = r.prospects().created_between(None, from, to).await?;
    let (target_left, backlog) = match &task.kind {
        TaskKind::AdHoc { target_count } => {
            let found = r.prospects().count_for_task(task.id).await?;
            (Some(u32::from(*target_count).saturating_sub(found)), None)
        }
        TaskKind::Standing { icp_key } => {
            let entry = version
                .filter(|v| v.id == task.strategy_version_id)
                .and_then(|v| {
                    v.sections
                        .prospecting
                        .icp
                        .iter()
                        .find(|e| &e.key == icp_key)
                        .cloned()
                });
            match entry {
                Some(e) if e.backlog_target > 0 => (
                    None,
                    Some((
                        r.prospects().backlog(&e.segment_key).await?,
                        e.backlog_target,
                    )),
                ),
                _ => (None, None),
            }
        }
    };
    Ok(remaining_today(&Capacity {
        daily_cap: task.daily_cap,
        recorded_today,
        workspace_today,
        target_left,
        backlog,
    }))
}

/// Every open task, newest first.
pub(crate) async fn open_tasks(r: &mut dyn TenantRepos) -> Result<Vec<ResearchTask>, AppError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let page = r
            .research_tasks()
            .list(&ResearchTaskQuery {
                status: Some(TaskStatus::Open),
                limit: MAX_PROSPECT_PAGE,
                after,
            })
            .await?;
        out.extend(page.items);
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Ok(out)
}

/// The context the planner records under: the system, as [`PLANNER`], in `ctx`'s workspace at
/// `ctx`'s time.
fn planner_ctx(ctx: &Ctx) -> Ctx {
    Ctx {
        actor: Actor::System {
            component: PLANNER.into(),
        },
        ..ctx.clone()
    }
}

async fn record(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    id: ResearchTaskId,
    payload: Value,
) -> Result<(), AppError> {
    let version = super::capabilities::version_in_force(r).await?;
    super::capabilities::append(r, ctx, action, "research_task", id, version, payload).await
}

/// What one planning did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Planned {
    /// Standing tasks created for ICP entries without an open one.
    pub created: u32,
    /// Open standing tasks of other versions superseded.
    pub superseded: u32,
}

/// The planner, inside the caller's bundle (the `research_plan` job's, or `strategy.approve`'s):
/// supersedes the open standing tasks of versions other than `version`, then gives each of
/// `version`'s ICP entries an open standing task if it has none (a concurrent planner's insert
/// meets the one-standing-task index and does nothing). Nothing is created while prospecting
/// is off. Ad-hoc tasks are left as they are.
pub async fn plan_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    version: &StrategyVersion,
) -> Result<Planned, AppError> {
    let ctx = planner_ctx(ctx);
    let mut out = Planned::default();
    for t in open_tasks(r).await? {
        if matches!(t.kind, TaskKind::Standing { .. }) && t.strategy_version_id != version.id {
            r.research_tasks()
                .set_status(t.id, TaskStatus::Superseded, ctx.now, "")
                .await?;
            record(
                r,
                &ctx,
                "research.task_closed",
                t.id,
                json!({ "task_id": t.id, "outcome": TaskStatus::Superseded.key() }),
            )
            .await?;
            out.superseded += 1;
        }
    }
    if !prospecting_on(version) {
        return Ok(out);
    }
    let prospecting = &version.sections.prospecting;
    let digest = rubric_digest(&prospecting.rubric);
    let open: Vec<String> = r
        .research_tasks()
        .open_standing(version.id)
        .await?
        .into_iter()
        .filter_map(|t| match t.kind {
            TaskKind::Standing { icp_key } => Some(icp_key),
            TaskKind::AdHoc { .. } => None,
        })
        .collect();
    for entry in prospecting.icp.iter().filter(|e| !open.contains(&e.key)) {
        let task = ResearchTask {
            id: ResearchTaskId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            kind: TaskKind::Standing {
                icp_key: entry.key.clone(),
            },
            strategy_version_id: version.id,
            brief: standing_brief(entry),
            rubric_digest: digest.clone(),
            daily_cap: entry.daily_cap,
            status: TaskStatus::Open,
            claim: None,
            created_by: jt_prospects::Recorder::System {
                job: PLANNER.into(),
            },
            created_at: ctx.now,
            closed_at: None,
            close_note: String::new(),
        };
        if r.research_tasks().insert(&task).await? {
            record(
                r,
                &ctx,
                "research.task_created",
                task.id,
                json!({ "task_id": task.id, "kind": "standing", "icp_key": entry.key }),
            )
            .await?;
            out.created += 1;
        }
    }
    Ok(out)
}

/// The `research_plan` job's body for one workspace: [`plan_in`] under the approved version,
/// in a bundle of its own; nothing without an approved version (`None`).
pub async fn plan(deps: &Deps, ctx: &Ctx) -> Result<Option<Planned>, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(version) = r.strategy().current_approved().await? else {
        return Ok(None);
    };
    let out = plan_in(deps, ctx, r.as_mut(), &version).await?;
    if out != Planned::default() {
        r.commit().await?;
    }
    Ok(Some(out))
}

/// `jeeta.research.tasks_list`'s input.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    pub status: Option<TaskStatus>,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<Uuid>,
}

/// A page of tasks, newest first, each with what it may still record today.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ListOut {
    pub items: Vec<TaskOut>,
    pub next: Option<NextPage>,
}

/// `jeeta.research.tasks_list`.
pub async fn tasks_list(deps: &Deps, ctx: &Ctx, input: ListInput) -> Result<ListOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=MAX_PROSPECT_PAGE).contains(&limit) {
        return Err(invalid("limit", "limit is 1..=200"));
    }
    let after = keyset_cursor(input.before_at.as_deref(), input.before_id)?
        .map(|(created_at, id)| ListCursor { created_at, id });
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = leads_policy(r.as_mut()).await?;
    let version = r.strategy().current_approved().await?;
    let page = r
        .research_tasks()
        .list(&ResearchTaskQuery {
            status: input.status,
            limit,
            after,
        })
        .await?;
    let mut items = Vec::with_capacity(page.items.len());
    for task in page.items {
        let remaining_today = remaining(
            r.as_mut(),
            &policy.timezone,
            &task,
            version.as_ref(),
            ctx.now,
        )
        .await?;
        items.push(TaskOut {
            task,
            remaining_today,
        });
    }
    Ok(ListOut {
        items,
        next: page.next.map(|c| NextPage {
            before_at: c.created_at.format(&Rfc3339).unwrap_or_default(),
            before_id: c.id,
        }),
    })
}

/// What `research.tasks_get` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GetOut {
    pub task: ResearchTask,
    pub remaining_today: u32,
    /// Prospects recorded for it.
    pub found: u32,
    /// Its newest prospects (rows: no contact values).
    pub prospects: Vec<ProspectRow>,
}

fn no_such_task() -> AppError {
    AppError::not_found("no such research task")
}

/// `jeeta.research.tasks_get`: the task, what it may still record today, how many it found and
/// its 20 newest prospects.
pub async fn tasks_get(deps: &Deps, ctx: &Ctx, id: ResearchTaskId) -> Result<GetOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    get_in(r.as_mut(), ctx, id).await
}

async fn get_in(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    id: ResearchTaskId,
) -> Result<GetOut, AppError> {
    let task = r.research_tasks().get(id).await?.ok_or_else(no_such_task)?;
    let policy = leads_policy(r).await?;
    let version = r.strategy().current_approved().await?;
    let remaining_today = remaining(r, &policy.timezone, &task, version.as_ref(), ctx.now).await?;
    let found = r.prospects().count_for_task(id).await?;
    let mut prospects = r
        .prospects()
        .list(&ProspectQuery {
            research_task_id: Some(id),
            limit: TASK_PROSPECTS,
            ..ProspectQuery::default()
        })
        .await?
        .items;
    for row in &mut prospects {
        row.purge_after = jt_prospects::purge_after(
            &policy.prospects,
            row.status,
            row.decided_at,
            row.updated_at,
        );
    }
    Ok(GetOut {
        task,
        remaining_today,
        found,
        prospects,
    })
}

/// `jeeta.research.tasks_create`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub brief: Brief,
    /// `1..=500` prospects to find.
    pub target_count: u16,
    /// `1..=500` prospects a local day.
    pub daily_cap: u16,
    #[serde(default)]
    pub request_key: Option<String>,
}

/// The longest request key, in characters.
const MAX_REQUEST_KEY_CHARS: usize = 128;

/// `jeeta.research.tasks_create`: an ad-hoc task under the approved strategy's rubric, while
/// prospecting is on (`CONFLICT prospecting_off` else); a brief's segment must be one of the
/// strategy's audience. A request key replays the task it created, read again, for 24 hours.
pub async fn tasks_create(deps: &Deps, ctx: &Ctx, input: CreateInput) -> Result<TaskOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    let brief = input.brief.normalised();
    validate_brief(&brief).map_err(invalid_from)?;
    validate_ad_hoc(input.target_count, input.daily_cap).map_err(invalid_from)?;
    if let Some(k) = &input.request_key
        && !(1..=MAX_REQUEST_KEY_CHARS).contains(&k.trim().chars().count())
    {
        return Err(invalid_from(jt_prospects::ProspectError::Invalid {
            field: "request_key",
            reason: "length",
        }));
    }
    let key = input
        .request_key
        .as_deref()
        .map(|k| format!("{REQUEST_KEY_PREFIX}{}", k.trim()));
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if let Some(key) = &key
        && let Some(out) = replay(r.as_mut(), ctx, key).await?
    {
        return Ok(out);
    }
    let version = prospecting_version(r.as_mut())
        .await?
        .ok_or_else(prospecting_off)?;
    if let Some(segment) = &brief.segment_key
        && !version.sections.audience.iter().any(|s| &s.key == segment)
    {
        return Err(invalid_from(jt_prospects::ProspectError::Invalid {
            field: "segment_key",
            reason: "unknown_segment",
        }));
    }
    let task = ResearchTask {
        id: ResearchTaskId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        kind: TaskKind::AdHoc {
            target_count: input.target_count,
        },
        strategy_version_id: version.id,
        brief,
        rubric_digest: rubric_digest(&version.sections.prospecting.rubric),
        daily_cap: input.daily_cap,
        status: TaskStatus::Open,
        claim: None,
        created_by: recorder,
        created_at: ctx.now,
        closed_at: None,
        close_note: String::new(),
    };
    r.research_tasks().insert(&task).await?;
    record(
        r.as_mut(),
        ctx,
        "research.task_created",
        task.id,
        json!({ "task_id": task.id, "kind": "ad_hoc", "target_count": input.target_count }),
    )
    .await?;
    // The request key holds the id only.
    if let Some(key) = &key
        && !r
            .request_keys()
            .store(key, json!({ "task_id": task.id }), ctx.now)
            .await?
    {
        return Err(AppError::conflict("request key changed while recording"));
    }
    let policy = leads_policy(r.as_mut()).await?;
    let remaining_today =
        remaining(r.as_mut(), &policy.timezone, &task, Some(&version), ctx.now).await?;
    r.commit().await?;
    Ok(TaskOut {
        task,
        remaining_today,
    })
}

/// The task a creation's request key recorded, read again now; `None` when the key is not live.
async fn replay(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    key: &str,
) -> Result<Option<TaskOut>, AppError> {
    let Some(stored) = r.request_keys().get(key, ctx.now).await? else {
        return Ok(None);
    };
    let id: ResearchTaskId = stored
        .get("task_id")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| AppError::conflict("request key belongs to another operation"))?;
    let out = get_in(r, ctx, id).await?;
    Ok(Some(TaskOut {
        task: out.task,
        remaining_today: out.remaining_today,
    }))
}

/// What `research.tasks_claim` answers. The claim is advisory: another recorder's live claim is
/// answered (`held_by_other`) and left in place, and anyone may still record for the task.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClaimOut {
    pub task_id: ResearchTaskId,
    /// Whether the caller holds the claim now.
    pub claimed: bool,
    /// The task's claim now: the caller's, or another recorder's.
    pub claim: Claim,
    /// Another recorder holds a live claim (the caller does not).
    pub held_by_other: bool,
}

/// `CONFLICT {reason: task_closed}` for a task that is not open.
fn task_closed(task: &ResearchTask) -> AppError {
    refused(
        ErrorCode::Conflict,
        "task_closed",
        "the research task is closed",
        json!({ "task_id": task.id, "status": task.status.key() }),
    )
}

/// `jeeta.research.tasks_claim`: claims an open task for the caller for two hours
/// (`CLAIM_LEASE`), or renews the caller's claim. Another recorder's live claim stays: the
/// answer says so, with `200`.
pub async fn tasks_claim(deps: &Deps, ctx: &Ctx, id: ResearchTaskId) -> Result<ClaimOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let task = r
        .research_tasks()
        .lock(id)
        .await?
        .ok_or_else(no_such_task)?;
    if task.status != TaskStatus::Open {
        return Err(task_closed(&task));
    }
    if let Some(other) = task
        .claim
        .as_ref()
        .filter(|c| c.until > ctx.now && c.by != recorder)
    {
        return Ok(ClaimOut {
            task_id: id,
            claimed: false,
            claim: other.clone(),
            held_by_other: true,
        });
    }
    let claim = Claim {
        by: recorder,
        until: ctx.now + CLAIM_LEASE,
    };
    r.research_tasks().set_claim(id, Some(&claim)).await?;
    record(
        r.as_mut(),
        ctx,
        "research.task_claimed",
        id,
        json!({ "task_id": id, "until": claim.until.format(&Rfc3339).unwrap_or_default() }),
    )
    .await?;
    r.commit().await?;
    Ok(ClaimOut {
        task_id: id,
        claimed: true,
        claim,
        held_by_other: false,
    })
}

/// How a task is closed by hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseOutcome {
    Done,
    Canceled,
}

/// `jeeta.research.tasks_close`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseInput {
    pub outcome: CloseOutcome,
    /// At most 1000 characters.
    #[serde(default)]
    pub note: Option<String>,
}

/// `jeeta.research.tasks_close`: closes an open ad-hoc task as done or canceled. A standing
/// task is the strategy's (`CONFLICT standing_task`: change the ICP entry instead).
pub async fn tasks_close(
    deps: &Deps,
    ctx: &Ctx,
    id: ResearchTaskId,
    input: CloseInput,
) -> Result<TaskOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    recorder(ctx)?;
    let note = input.note.as_deref().unwrap_or_default().trim().to_owned();
    if note.chars().count() > MAX_CLOSE_NOTE_CHARS {
        return Err(invalid("note", "a note is at most 1000 characters"));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let task = r
        .research_tasks()
        .lock(id)
        .await?
        .ok_or_else(no_such_task)?;
    if matches!(task.kind, TaskKind::Standing { .. }) {
        return Err(refused(
            ErrorCode::Conflict,
            "standing_task",
            "a standing task follows its ICP entry: change the strategy's ICP instead",
            json!({ "task_id": id }),
        ));
    }
    if task.status != TaskStatus::Open {
        return Err(task_closed(&task));
    }
    let status = match input.outcome {
        CloseOutcome::Done => TaskStatus::Done,
        CloseOutcome::Canceled => TaskStatus::Canceled,
    };
    r.research_tasks()
        .set_status(id, status, ctx.now, &note)
        .await?;
    record(
        r.as_mut(),
        ctx,
        "research.task_closed",
        id,
        json!({ "task_id": id, "outcome": status.key() }),
    )
    .await?;
    let task = r.research_tasks().get(id).await?.ok_or_else(no_such_task)?;
    r.commit().await?;
    Ok(TaskOut {
        task,
        remaining_today: 0,
    })
}

/// Closes ad-hoc task `task` as done when the prospects recorded for it reach its target: the
/// last step of a `prospects.create` for it, in its transaction. `true` when it closed.
pub(crate) async fn close_if_found(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    task: &ResearchTask,
) -> Result<bool, AppError> {
    let TaskKind::AdHoc { target_count } = task.kind else {
        return Ok(false);
    };
    if task.status != TaskStatus::Open
        || r.prospects().count_for_task(task.id).await? < u32::from(target_count)
    {
        return Ok(false);
    }
    r.research_tasks()
        .set_status(task.id, TaskStatus::Done, ctx.now, "target reached")
        .await?;
    record(
        r,
        &planner_ctx(ctx),
        "research.task_closed",
        task.id,
        json!({ "task_id": task.id, "outcome": TaskStatus::Done.key(), "auto": true }),
    )
    .await?;
    Ok(true)
}
