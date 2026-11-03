//! The agents' prospecting playbook (spec §3.8, Appendix A; §7.1 `prospects.playbook`) and the
//! pool's pending work (spec §3.17: `research_due`, `prospects_to_score`).

use jt_prospects::{KeyKind, ResearchTaskId, TaskKind};
use jt_strategy::{IcpEntry, Rubric, StrategyVersion};
use jt_tenancy::Permission;
use serde::Serialize;
use time::format_description::well_known::Rfc3339;

use super::{leads_policy, rubric_digest};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::usecases::research::{open_tasks, prospecting_on, remaining};
use crate::usecases::{Deps, hours};

/// The workspace's daily numbers, in its local day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Caps {
    /// The IANA time zone the day counts in.
    pub timezone: String,
    /// The most prospects the workspace records a local day.
    pub daily_prospects: u32,
    /// Prospects recorded today.
    pub recorded_today: u32,
    /// The most prospects promoted a local day.
    pub max_promotions_per_day: u16,
    /// When the day's counts start again.
    pub resets_at: String,
}

/// What an open task may still record today.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TaskRemaining {
    pub task_id: ResearchTaskId,
    /// The ICP entry of a standing task.
    pub icp_key: Option<String>,
    pub remaining: u32,
}

/// The pool's retention, in days.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Retention {
    pub rejected: u16,
    pub unpromoted: u16,
    pub rejected_memory: u16,
}

/// Which values the do-not-contact list holds and which only flag (spec D28).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlocklistRules {
    /// Hashed onto the list; a hit refuses a write.
    pub listed: Vec<KeyKind>,
    /// Never listed; a match with a live prospect is a flag, never a refusal.
    pub flagged: Vec<KeyKind>,
}

/// The playbook's workspace section.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlaybookWorkspace {
    /// Whether the approved strategy has ICP entries (an empty ICP is the off switch).
    pub prospecting_on: bool,
    pub icp: Vec<IcpEntry>,
    pub rubric: Rubric,
    /// The digest scores are sent with; `None` while prospecting is off.
    pub rubric_digest: Option<String>,
    pub caps: Caps,
    pub remaining_today: Vec<TaskRemaining>,
    pub retention_days: Retention,
    pub blocklist_rules: BlocklistRules,
}

/// What `prospects.playbook` answers (spec §3.8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlaybookOut {
    pub version: u32,
    pub text: &'static str,
    pub workspace: PlaybookWorkspace,
}

/// `jeeta.prospects.playbook`: the playbook's text (Appendix A, versioned) and the workspace's
/// section: the approved ICP and rubric with its digest, today's caps and every open task's
/// remaining count, the retention and the blocklist's rules.
pub async fn playbook(deps: &Deps, ctx: &Ctx) -> Result<PlaybookOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = leads_policy(r.as_mut()).await?;
    let version = r.strategy().current_approved().await?;
    let on = version.as_ref().is_some_and(prospecting_on);
    let (from, to) = hours::local_day(&policy.timezone, ctx.now)?;
    let recorded_today = r.prospects().created_between(None, from, to).await?;
    let mut tasks = Vec::new();
    for t in open_tasks(r.as_mut()).await? {
        let left = remaining(r.as_mut(), &policy.timezone, &t, version.as_ref(), ctx.now).await?;
        tasks.push(TaskRemaining {
            task_id: t.id,
            icp_key: match &t.kind {
                TaskKind::Standing { icp_key } => Some(icp_key.clone()),
                TaskKind::AdHoc { .. } => None,
            },
            remaining: left,
        });
    }
    let prospecting = version.map(|v| v.sections.prospecting).unwrap_or_default();
    let p = &policy.prospects;
    Ok(PlaybookOut {
        version: jt_prospects::playbook::PLAYBOOK_VERSION,
        text: jt_prospects::playbook::TEXT,
        workspace: PlaybookWorkspace {
            prospecting_on: on,
            rubric_digest: on.then(|| rubric_digest(&prospecting.rubric)),
            icp: prospecting.icp,
            rubric: prospecting.rubric,
            caps: Caps {
                timezone: policy.timezone.clone(),
                daily_prospects: jt_prospects::MAX_DAILY_PROSPECTS,
                recorded_today,
                max_promotions_per_day: p.max_promotions_per_day,
                resets_at: to.format(&Rfc3339).unwrap_or_default(),
            },
            remaining_today: tasks,
            retention_days: Retention {
                rejected: p.rejected_retention_days,
                unpromoted: p.unpromoted_retention_days,
                rejected_memory: p.rejected_memory_days,
            },
            blocklist_rules: BlocklistRules {
                listed: KeyKind::ALL.iter().copied().filter(|k| k.hard()).collect(),
                flagged: KeyKind::ALL.iter().copied().filter(|k| !k.hard()).collect(),
            },
        },
    })
}

/// The pool's pending work for a caller holding `prospects.work`, under the approved `version`
/// with prospecting on (nothing else): each open task that may still record today, and how many
/// `new` prospects have no score under the current rubric.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PoolPending {
    pub research_due: Vec<(ResearchTaskId, u32)>,
    pub to_score: u32,
}

/// [`PoolPending`] in the caller's bundle; empty while prospecting is off.
pub async fn pending_in(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    version: &StrategyVersion,
) -> Result<PoolPending, AppError> {
    if !prospecting_on(version) {
        return Ok(PoolPending::default());
    }
    let policy = leads_policy(r).await?;
    let mut research_due = Vec::new();
    for t in open_tasks(r).await? {
        let left = remaining(r, &policy.timezone, &t, Some(version), ctx.now).await?;
        if left > 0 {
            research_due.push((t.id, left));
        }
    }
    let digest = rubric_digest(&version.sections.prospecting.rubric);
    Ok(PoolPending {
        research_due,
        to_score: r.prospects().count_unscored(&digest).await?,
    })
}
