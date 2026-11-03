//! Lead distribution (spec 2026-10-30-leads-pool-outreach-design.md §3.9, §7.1): who owns a new
//! journey. The workspace's ordered rules, then the implicit default rule (unless the mode is
//! `manual`), pick among the eligible members (`jt_inbox::choose`); every decision is a row of
//! the assignment log written with the journey's owner in one transaction, so **no open journey
//! is ever ownerless without a recorded decision**, and every ownerless one is counted in the
//! `ownerless_journeys` work item.
//!
//! When it runs: inline at promotion, and in the one-minute `lead_distribution` job for every
//! open journey without an owner that no decision has settled (consumer, lead ads, forms, people
//! created by hand, reopened journeys, a departed owner's journeys). A v1-imported journey gets
//! an `import` decision and waits for a manager's `distribution.backfill`. An assignment past its
//! SLA (counted in its owner's working hours) moves to the next eligible member of its rule,
//! excluding the journey's earlier owners, at most `max_reassignments` times; then it is stalled
//! and counted in `assignment_stalled`. The owner acts when they reply, report a journey event,
//! add a note, complete a task or place a call ([`touch`]).
//!
//! Every decision runs under the inbox workspace lock; the job takes one transaction per
//! journey. Ledger payloads carry ids, causes and counts only.

use std::collections::{BTreeMap, BTreeSet};

use jt_capability::Hours;
use jt_inbox::{
    AssignmentId, Candidate, Cause, Choice, DefaultRule, Journey, JourneyId, LeadFacts, Match,
    MemberPool, Method, RepProfile, Rule, RuleId, Source, choose, source_kind,
};
use jt_ledger::Actor;
use jt_tenancy::{MembershipStatus, Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::distribution::{
    AssignmentCursor, AssignmentQuery, AssignmentRow, MAX_ASSIGNMENT_PAGE, MAX_RULES, Ownerless,
    OwnerlessScope,
};
use crate::ports::{DistributionMode, TenantRepos};
use crate::usecases::{Deps, hours, invalid};

/// The most journeys one `distribution.backfill` assigns, and the most decisions of each kind one
/// job run makes in a workspace.
pub const BATCH: u32 = 200;

/// The most entries a rule's or a profile's list holds.
const MAX_LIST: usize = 20;

/// The most members a rule's pool names.
const MAX_POOL: usize = 100;

/// The bounds of a rule's SLA, in minutes.
const SLA_MINUTES: std::ops::RangeInclusive<u32> = 5..=10_080;

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// One rule of `distribution.rules_set`. A rule named by an id it already has keeps its round
/// robin cursor; any other gets a new id.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleInput {
    #[serde(default)]
    pub id: Option<RuleId>,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub when: Match,
    pub to: MemberPool,
    pub method: Method,
    /// `5..=10080` minutes inside the owner's working hours.
    #[serde(default)]
    pub sla_minutes: Option<u32>,
}

fn yes() -> bool {
    true
}

/// `distribution.rules_set`: the whole ordered rule set, and optionally the mode and the
/// reassignment limit.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulesSetInput {
    pub rules: Vec<RuleInput>,
    #[serde(default)]
    pub mode: Option<DistributionMode>,
    /// `0..=10`.
    #[serde(default)]
    pub max_reassignments: Option<u8>,
}

/// `distribution.rep_set`: a member's profile, replaced whole (a field left out takes its
/// default: accepting, no limit, no filters, no hours, not away).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RepSetInput {
    #[serde(default = "yes")]
    pub accepting: bool,
    /// `1..=10000` open journeys.
    #[serde(default)]
    pub max_open: Option<u16>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub cities: Vec<String>,
    #[serde(default)]
    pub sectors: Vec<String>,
    #[serde(default)]
    pub hours: Option<Hours>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub away_until: Option<OffsetDateTime>,
}

/// One member as distribution sees them now.
#[derive(Clone, Debug, Serialize)]
pub struct RepOut {
    pub user_id: UserId,
    pub display_name: Option<String>,
    pub role_key: String,
    pub profile: RepProfile,
    pub open_owned: u32,
    pub on_shift: bool,
    /// Takes a new journey now (accepting, not away, under the limit).
    pub eligible: bool,
}

/// `distribution.get`.
#[derive(Clone, Debug, Serialize)]
pub struct DistributionOut {
    pub mode: DistributionMode,
    pub max_reassignments: u8,
    pub rules: Vec<Rule>,
    /// The active members who hold `inbox.work`.
    pub reps: Vec<RepOut>,
    pub ownerless: Ownerless,
    pub stalled: u32,
}

/// `distribution.assignments_list`'s filters and page.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssignmentsListInput {
    #[serde(default)]
    pub journey_id: Option<JourneyId>,
    #[serde(default)]
    pub user_id: Option<UserId>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub before_at: Option<OffsetDateTime>,
    #[serde(default)]
    pub before_id: Option<AssignmentId>,
}

/// A page of the assignment log, newest first.
#[derive(Clone, Debug, Serialize)]
pub struct AssignmentsOut {
    pub items: Vec<AssignmentRow>,
    pub next: Option<AssignmentCursor>,
}

/// `distribution.backfill`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackfillInput {
    /// `1..=200`, default 200.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// What a backfill or a job run decided.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Distributed {
    /// Journeys given an owner.
    pub assigned: u32,
    /// Journeys nobody was eligible for (recorded, counted as ownerless).
    pub no_eligible: u32,
    /// v1-imported journeys recorded as waiting for a backfill.
    pub imported: u32,
    /// Assignments past their SLA moved to another member.
    pub reassigned: u32,
    /// Assignments past their SLA kept by their owner (nobody else eligible).
    pub kept: u32,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// `jeeta.distribution.get`: the mode, the rules, each member's profile and load, and the
/// ownerless and stalled counts.
pub async fn get(deps: &Deps, ctx: &Ctx) -> Result<DistributionOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let policy = r.workspace_policy().read().await?.leads.distribution;
    let team = team(r.as_mut()).await?;
    let reps = team
        .into_iter()
        .map(|m| RepOut {
            eligible: m.profile.takes_new(ctx.now, m.open_owned),
            on_shift: on_shift(m.profile.hours.as_ref(), ctx.now),
            user_id: m.user_id,
            display_name: m.display_name,
            role_key: m.role_key,
            open_owned: m.open_owned,
            profile: m.profile,
        })
        .collect();
    Ok(DistributionOut {
        mode: policy.mode,
        max_reassignments: policy.max_reassignments,
        rules: r.distribution_rules().list().await?,
        reps,
        ownerless: r.assignments().count_ownerless().await?,
        stalled: r
            .assignments()
            .count_stalled(ctx.now, u32::from(policy.max_reassignments))
            .await?,
    })
}

/// `jeeta.distribution.rules_set`: replaces the ordered rules (a rule keeping its id keeps its
/// round robin cursor), and sets the mode and the reassignment limit when given. Every member a
/// pool names must be an active member who holds `inbox.work`.
pub async fn rules_set(
    deps: &Deps,
    ctx: &Ctx,
    input: RulesSetInput,
) -> Result<DistributionOut, AppError> {
    ctx.require(Permission::InboxManage)?;
    if input.rules.len() > MAX_RULES {
        return Err(invalid("rules", &format!("at most {MAX_RULES} rules")));
    }
    if input.max_reassignments.is_some_and(|n| n > 10) {
        return Err(invalid("max_reassignments", "0 to 10"));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let members: BTreeSet<UserId> = team(r.as_mut())
        .await?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    let current: BTreeMap<RuleId, Rule> = r
        .distribution_rules()
        .list()
        .await?
        .into_iter()
        .map(|rule| (rule.id, rule))
        .collect();
    let mut seen = BTreeSet::new();
    let mut rules = Vec::with_capacity(input.rules.len());
    for (i, rule) in input.rules.into_iter().enumerate() {
        let field = |f: &str| format!("rules[{i}].{f}");
        let name = rule.name.trim().to_owned();
        if !(1..=80).contains(&name.chars().count()) {
            return Err(invalid(&field("name"), "1 to 80 characters"));
        }
        if rule.sla_minutes.is_some_and(|m| !SLA_MINUTES.contains(&m)) {
            return Err(invalid(&field("sla_minutes"), "5 to 10080 minutes"));
        }
        check_match(&rule.when, &field("when"))?;
        if let MemberPool::Members { user_ids } = &rule.to {
            if user_ids.is_empty() || user_ids.len() > MAX_POOL {
                return Err(invalid(&field("to"), "1 to 100 members"));
            }
            if user_ids.iter().any(|u| !members.contains(u)) {
                return Err(invalid(
                    &field("to"),
                    "every member must be active and hold inbox.work",
                ));
            }
        }
        let kept = rule.id.and_then(|id| current.get(&id));
        let id = match kept {
            Some(k) if seen.insert(k.id) => k.id,
            _ => RuleId::from(deps.ids.uuid()),
        };
        rules.push(Rule {
            id,
            name,
            enabled: rule.enabled,
            when: rule.when,
            to: rule.to,
            method: rule.method,
            sla_minutes: rule.sla_minutes,
            cursor: kept.and_then(|k| k.cursor).filter(|u| members.contains(u)),
        });
    }
    r.distribution_rules().replace_all(&rules, ctx.now).await?;
    let mut patch = serde_json::Map::new();
    if let Some(mode) = input.mode {
        patch.insert(
            "mode".into(),
            serde_json::to_value(mode).unwrap_or(Value::Null),
        );
    }
    if let Some(n) = input.max_reassignments {
        patch.insert("max_reassignments".into(), n.into());
    }
    if !patch.is_empty() {
        r.workspace_policy()
            .patch_leads(json!({ "distribution": patch }), ctx.now)
            .await?;
    }
    record(
        r.as_mut(),
        ctx,
        "distribution.rules_set",
        "distribution",
        ctx.workspace_id,
        json!({
            "rules": rules.len(),
            "mode": input.mode,
            "max_reassignments": input.max_reassignments,
        }),
    )
    .await?;
    r.commit().await?;
    get(deps, ctx).await
}

/// `jeeta.distribution.rep_set`: replaces member `user`'s profile. A member sets their own with
/// `inbox.work`; another's needs `inbox.manage`. The member must be active and hold `inbox.work`.
pub async fn rep_set(
    deps: &Deps,
    ctx: &Ctx,
    user: UserId,
    input: RepSetInput,
) -> Result<RepOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let own = matches!(ctx.actor, Actor::Human { user_id } if user_id == user);
    if !own {
        ctx.require(Permission::InboxManage)?;
    }
    if input.max_open.is_some_and(|m| m == 0 || m > 10_000) {
        return Err(invalid("max_open", "1 to 10000"));
    }
    for (name, list) in [
        ("languages", &input.languages),
        ("cities", &input.cities),
        ("sectors", &input.sectors),
    ] {
        check_list(list, name)?;
    }
    if let Some(h) = &input.hours {
        check_hours(h)?;
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let member = team(r.as_mut())
        .await?
        .into_iter()
        .find(|m| m.user_id == user)
        .ok_or_else(|| AppError::not_found("no active member who holds inbox.work"))?;
    let profile = RepProfile {
        user_id: user,
        accepting: input.accepting,
        max_open: input.max_open,
        languages: trimmed(input.languages),
        cities: trimmed(input.cities),
        sectors: trimmed(input.sectors),
        hours: input.hours,
        away_until: input.away_until,
        updated_at: ctx.now,
    };
    r.rep_profiles().set(&profile).await?;
    record(
        r.as_mut(),
        ctx,
        "distribution.rep_set",
        "user",
        user,
        json!({ "user_id": user, "accepting": profile.accepting, "away": profile.away_until.is_some() }),
    )
    .await?;
    r.commit().await?;
    Ok(RepOut {
        eligible: profile.takes_new(ctx.now, member.open_owned),
        on_shift: on_shift(profile.hours.as_ref(), ctx.now),
        user_id: user,
        display_name: member.display_name,
        role_key: member.role_key,
        open_owned: member.open_owned,
        profile,
    })
}

/// `jeeta.distribution.assignments_list`: the assignment log, newest first.
pub async fn assignments_list(
    deps: &Deps,
    ctx: &Ctx,
    input: AssignmentsListInput,
) -> Result<AssignmentsOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let before = match (input.before_at, input.before_id) {
        (Some(assigned_at), Some(id)) => Some(AssignmentCursor { assigned_at, id }),
        (None, None) => None,
        _ => return Err(invalid("before_at", "before_at and before_id go together")),
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let page = r
        .assignments()
        .list(&AssignmentQuery {
            journey_id: input.journey_id,
            user_id: input.user_id,
            limit: input.limit.unwrap_or(50).clamp(1, MAX_ASSIGNMENT_PAGE),
            before,
        })
        .await?;
    Ok(AssignmentsOut {
        items: page.items,
        next: page.next,
    })
}

/// `jeeta.distribution.backfill`: distributes up to `limit` open journeys that have no owner,
/// whatever their decision (an import's, nobody eligible, a manager's unassignment), longest open
/// first: the manager's way to hand out imported journeys without flooding anyone.
pub async fn backfill(
    deps: &Deps,
    ctx: &Ctx,
    input: BackfillInput,
) -> Result<Distributed, AppError> {
    ctx.require(Permission::InboxManage)?;
    let limit = input.limit.unwrap_or(BATCH);
    if !(1..=BATCH).contains(&limit) {
        return Err(invalid("limit", "1 to 200"));
    }
    let ids = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.assignments()
            .ownerless_open(OwnerlessScope::All, limit)
            .await?
    };
    let mut out = Distributed::default();
    for id in ids {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.people().lock_workspace().await?;
        r.people().set_write_time(ctx.now).await?;
        if let Some(row) = assign_in(deps, ctx, r.as_mut(), id, false).await? {
            count(&mut out, &row);
        }
        r.commit().await?;
    }
    record_backfill(deps, ctx, &out).await?;
    Ok(out)
}

async fn record_backfill(deps: &Deps, ctx: &Ctx, out: &Distributed) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    record(
        r.as_mut(),
        ctx,
        "distribution.backfilled",
        "distribution",
        ctx.workspace_id,
        json!({ "assigned": out.assigned, "no_eligible": out.no_eligible }),
    )
    .await?;
    r.commit().await
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/// Assigns journey `id` an owner in `r`, which holds the inbox lock: the rules, then the default
/// rule unless the mode is manual; a recorded `no_eligible` decision when nobody is eligible. A
/// journey that is closed or already owned is left alone (`None`). With `import_waits`, a
/// v1-imported journey gets an `import` decision instead and waits for a backfill.
pub(crate) async fn assign_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: JourneyId,
    import_waits: bool,
) -> Result<Option<AssignmentRow>, AppError> {
    let Some(journey) = r.journeys().lock(id).await? else {
        return Ok(None);
    };
    if journey.closed_at.is_some() || journey.owner.is_some() {
        return Ok(None);
    }
    if import_waits && matches!(journey.source, Source::V1Import { .. }) {
        let row = write(
            deps,
            ctx,
            r,
            &journey,
            Decided {
                user_id: None,
                cause: Cause::Import,
                rule_id: None,
                sla_due_at: None,
            },
        )
        .await?;
        return Ok(Some(row));
    }
    let policy = r.workspace_policy().read().await?.leads.distribution;
    let facts = facts(r, &journey).await?;
    let team = team(r).await?;
    let rules = r.distribution_rules().list().await?;
    let default = match policy.mode {
        DistributionMode::Manual => DefaultRule::Off,
        DistributionMode::Auto => DefaultRule::On {
            cursor: r.assignments().default_cursor().await?,
        },
    };
    let choice = choose(&rules, default, &facts, &candidates(&team, ctx.now), &[]);
    let decided = decided(&team, &choice, choice.cause, ctx.now);
    Ok(Some(write(deps, ctx, r, &journey, decided).await?))
}

/// Reassigns the journey of `due`, an assignment past its SLA, in `r` (holding the inbox lock):
/// the next eligible member of its rule, the journey's earlier owners excluded; when nobody else
/// is eligible the owner keeps it with a new due time. `None` when the assignment is no longer
/// the live, unacted one of an open journey.
async fn reassign_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    due: &AssignmentRow,
) -> Result<Option<AssignmentRow>, AppError> {
    let Some(journey) = r.journeys().lock(due.journey_id).await? else {
        return Ok(None);
    };
    let live = r.assignments().live(due.journey_id).await?;
    if journey.closed_at.is_some()
        || live
            .as_ref()
            .is_none_or(|l| l.id != due.id || l.acted_at.is_some())
    {
        return Ok(None);
    }
    let rule = r
        .distribution_rules()
        .list()
        .await?
        .into_iter()
        .find(|rule| Some(rule.id) == due.rule_id);
    let facts = facts(r, &journey).await?;
    let team = team(r).await?;
    let exclude = r.assignments().previous_assignees(journey.id).await?;
    // The same rule's members (whatever its `when` now: the journey matched it); a rule since
    // removed leaves its journeys to the default rule's members.
    let rules: Vec<Rule> = rule
        .clone()
        .map(|mut rule| {
            rule.enabled = true;
            rule.when = Match::default();
            rule
        })
        .into_iter()
        .collect();
    let default = if rules.is_empty() {
        DefaultRule::On { cursor: None }
    } else {
        DefaultRule::Off
    };
    let choice = choose(
        &rules,
        default,
        &facts,
        &candidates(&team, ctx.now),
        &exclude,
    );
    let sla = rule.as_ref().and_then(|rule| rule.sla_minutes);
    let decided = match choice.user_id {
        Some(user) => Decided {
            user_id: Some(user),
            cause: Cause::SlaReassign,
            rule_id: due.rule_id,
            sla_due_at: sla.map(|m| due_at(&team, user, ctx.now, m)),
        },
        None => Decided {
            user_id: due.user_id,
            cause: Cause::SlaReassign,
            rule_id: due.rule_id,
            sla_due_at: match (due.user_id, sla) {
                (Some(user), Some(m)) => Some(due_at(&team, user, ctx.now, m)),
                _ => None,
            },
        },
    };
    Ok(Some(write(deps, ctx, r, &journey, decided).await?))
}

/// A decision about to be written.
struct Decided {
    user_id: Option<UserId>,
    cause: Cause,
    rule_id: Option<RuleId>,
    sla_due_at: Option<OffsetDateTime>,
}

/// The decision `choice` makes, its due time counted in the chosen member's working hours.
fn decided(team: &[Member], choice: &Choice, cause: Cause, now: OffsetDateTime) -> Decided {
    Decided {
        user_id: choice.user_id,
        cause,
        rule_id: choice.rule_id,
        sla_due_at: match (choice.user_id, choice.sla_minutes) {
            (Some(user), Some(m)) => Some(due_at(team, user, now, m)),
            _ => None,
        },
    }
}

/// `minutes` working minutes of `user` after `now` (wall-clock minutes without hours).
fn due_at(team: &[Member], user: UserId, now: OffsetDateTime, minutes: u32) -> OffsetDateTime {
    let hours = team
        .iter()
        .find(|m| m.user_id == user)
        .and_then(|m| m.profile.hours.as_ref());
    hours::add_working_minutes(hours, now, minutes)
}

/// Supersedes the journey's live decision with `d`, sets the journey's owner to `d`'s member,
/// moves the rule's cursor, and writes the ledger entry.
async fn write(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: &Journey,
    d: Decided,
) -> Result<AssignmentRow, AppError> {
    let previous = r.assignments().live(journey.id).await?;
    let row = AssignmentRow {
        id: AssignmentId::from(deps.ids.uuid()),
        journey_id: journey.id,
        user_id: d.user_id,
        cause: d.cause,
        rule_id: d.rule_id,
        assigned_at: ctx.now,
        sla_due_at: d.sla_due_at,
        acted_at: None,
        superseded_at: None,
        by: ctx.actor.clone(),
    };
    r.assignments().supersede(journey.id, ctx.now).await?;
    r.assignments().insert(&row).await?;
    if journey.owner != row.user_id {
        r.journeys().assign_owner(journey.id, row.user_id).await?;
    }
    if let (Some(rule), Some(user), Cause::Rule) = (row.rule_id, row.user_id, row.cause) {
        r.distribution_rules().set_cursor(rule, user).await?;
    }
    let (action, payload) = match row.cause {
        Cause::NoEligible => (
            "distribution.no_eligible",
            json!({ "journey_id": journey.id }),
        ),
        Cause::SlaReassign => (
            "distribution.reassigned",
            json!({
                "journey_id": journey.id,
                "user_id": row.user_id,
                "from_user_id": previous.and_then(|p| p.user_id),
                "rule_id": row.rule_id,
            }),
        ),
        _ => (
            "distribution.assigned",
            json!({
                "journey_id": journey.id,
                "user_id": row.user_id,
                "cause": row.cause.key(),
                "rule_id": row.rule_id,
            }),
        ),
    };
    record(r, ctx, action, "journey", journey.id, payload).await?;
    Ok(row)
}

/// Records a manager's assignment of `journey` to `user` (or to nobody) as a `manual` decision
/// superseding the live one; no SLA. In `inbox.journeys.assign_owner`'s transaction, after the
/// owner is written.
pub(crate) async fn record_manual(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: JourneyId,
    user: Option<UserId>,
) -> Result<(), AppError> {
    append_quietly(deps, ctx, r, journey, user, Cause::Manual).await
}

/// Records that `journey`'s owner left the workspace (`member_left`, nobody named): the job then
/// distributes it again. In the membership-removal transaction, after the owner is cleared.
pub(crate) async fn record_member_left(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: JourneyId,
) -> Result<(), AppError> {
    append_quietly(deps, ctx, r, journey, None, Cause::MemberLeft).await
}

/// Supersedes the live decision with one of `cause`, without its own ledger entry (the caller's
/// entry records the change).
async fn append_quietly(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    journey: JourneyId,
    user: Option<UserId>,
    cause: Cause,
) -> Result<(), AppError> {
    r.assignments().supersede(journey, ctx.now).await?;
    r.assignments()
        .insert(&AssignmentRow {
            id: AssignmentId::from(deps.ids.uuid()),
            journey_id: journey,
            user_id: user,
            cause,
            rule_id: None,
            assigned_at: ctx.now,
            sla_due_at: None,
            acted_at: None,
            superseded_at: None,
            by: ctx.actor.clone(),
        })
        .await
}

/// Marks the journey's live assignment acted on when a person who owns it acts now (a reply, a
/// journey event, a note, a completed task, a call). An agent's act does not count: the SLA asks
/// for the owner.
pub(crate) async fn touch(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    journey: JourneyId,
) -> Result<(), AppError> {
    if let Actor::Human { user_id } = ctx.actor {
        r.assignments().touch(journey, user_id, ctx.now).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/// The `lead_distribution` job's body for one workspace: up to [`BATCH`] undecided ownerless
/// open journeys assigned (a v1 import recorded as waiting), then up to [`BATCH`] assignments
/// past their SLA reassigned; one transaction per journey under the inbox lock, so a long run
/// never holds a connection across decisions.
pub async fn run(deps: &Deps, ctx: &Ctx) -> Result<Distributed, AppError> {
    let (ids, due) = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let max = r
            .workspace_policy()
            .read()
            .await?
            .leads
            .distribution
            .max_reassignments;
        (
            r.assignments()
                .ownerless_open(OwnerlessScope::Undecided, BATCH)
                .await?,
            r.assignments()
                .due_sla(ctx.now, u32::from(max), BATCH)
                .await?,
        )
    };
    let mut out = Distributed::default();
    for id in ids {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.people().lock_workspace().await?;
        r.people().set_write_time(ctx.now).await?;
        if let Some(row) = assign_in(deps, ctx, r.as_mut(), id, true).await? {
            count(&mut out, &row);
        }
        r.commit().await?;
    }
    for row in due {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.people().lock_workspace().await?;
        r.people().set_write_time(ctx.now).await?;
        if let Some(new) = reassign_in(deps, ctx, r.as_mut(), &row).await? {
            if new.user_id == row.user_id {
                out.kept += 1;
            } else {
                out.reassigned += 1;
            }
        }
        r.commit().await?;
    }
    Ok(out)
}

fn count(out: &mut Distributed, row: &AssignmentRow) {
    match row.cause {
        Cause::NoEligible => out.no_eligible += 1,
        Cause::Import => out.imported += 1,
        _ => out.assigned += 1,
    }
}

// ---------------------------------------------------------------------------------------------
// Facts and members
// ---------------------------------------------------------------------------------------------

/// What distribution knows about `journey`'s lead: its source, and the facts of the prospect its
/// person was promoted from.
async fn facts(r: &mut dyn TenantRepos, journey: &Journey) -> Result<LeadFacts, AppError> {
    let mut facts = LeadFacts::source_only(source_kind(&journey.source));
    if let Some(p) = r.prospects().by_person(journey.person_id).await? {
        facts.city = p.city;
        facts.sector = p.sector;
        facts.segment = p.segment_key;
        facts.language = p.language;
        facts.score = p.latest_score.map(|s| s.score);
    }
    Ok(facts)
}

/// An active member who holds `inbox.work`, with their profile and load.
struct Member {
    user_id: UserId,
    display_name: Option<String>,
    role_key: String,
    profile: RepProfile,
    open_owned: u32,
}

/// The workspace's active members whose role holds `inbox.work`, by user id.
async fn team(r: &mut dyn TenantRepos) -> Result<Vec<Member>, AppError> {
    let roles: BTreeMap<String, bool> = r
        .roles()
        .list()
        .await?
        .into_iter()
        .map(|role| {
            let works = role.permissions.contains(&Permission::InboxWork);
            (role.key, works)
        })
        .collect();
    let owned: BTreeMap<UserId, u32> = r.assignments().open_owned().await?.into_iter().collect();
    let mut out = Vec::new();
    for m in r.memberships().list().await? {
        let Some(user) = m.user_id else { continue };
        if m.status != MembershipStatus::Active || roles.get(&m.role_key) != Some(&true) {
            continue;
        }
        out.push(Member {
            user_id: user,
            display_name: m.display_name,
            role_key: m.role_key,
            profile: r.rep_profiles().get(user).await?,
            open_owned: owned.get(&user).copied().unwrap_or(0),
        });
    }
    out.sort_by_key(|m| m.user_id);
    Ok(out)
}

/// The members as `choose` takes them.
fn candidates(team: &[Member], now: OffsetDateTime) -> Vec<Candidate> {
    team.iter()
        .map(|m| Candidate {
            user_id: m.user_id,
            eligible: m.profile.takes_new(now, m.open_owned),
            on_shift: on_shift(m.profile.hours.as_ref(), now),
            open_owned: m.open_owned,
            languages: m.profile.languages.clone(),
            cities: m.profile.cities.clone(),
            sectors: m.profile.sectors.clone(),
        })
        .collect()
}

/// Whether a member with `hours` is on shift at `now` (no hours, or hours this build cannot
/// read: always).
fn on_shift(hours: Option<&Hours>, now: OffsetDateTime) -> bool {
    hours.is_none_or(|h| hours::within(h, now).unwrap_or(true))
}

// ---------------------------------------------------------------------------------------------
// Validation and the ledger
// ---------------------------------------------------------------------------------------------

fn check_list(list: &[String], field: &str) -> Result<(), AppError> {
    if list.len() > MAX_LIST {
        return Err(invalid(field, "at most 20 entries"));
    }
    if list
        .iter()
        .any(|v| !(1..=80).contains(&v.trim().chars().count()))
    {
        return Err(invalid(field, "each entry 1 to 80 characters"));
    }
    Ok(())
}

fn check_match(m: &Match, field: &str) -> Result<(), AppError> {
    for (name, list) in [
        ("cities", &m.cities),
        ("sectors", &m.sectors),
        ("languages", &m.languages),
        ("segments", &m.segments),
    ] {
        check_list(list, &format!("{field}.{name}"))?;
    }
    if m.min_score.is_some_and(|s| s > 100) {
        return Err(invalid(&format!("{field}.min_score"), "0 to 100"));
    }
    Ok(())
}

fn check_hours(h: &Hours) -> Result<(), AppError> {
    if !hours::known_time_zone(&h.tz) {
        return Err(invalid("hours.tz", "an IANA time zone"));
    }
    if h.from > 23 || !(1..=24).contains(&h.to) || h.from >= h.to {
        return Err(invalid("hours.from", "from 0..=23 before to 1..=24"));
    }
    let days: BTreeSet<u8> = h.days.iter().copied().collect();
    if h.days.is_empty()
        || days.len() != h.days.len()
        || h.days.iter().any(|d| !(1..=7).contains(d))
    {
        return Err(invalid(
            "hours.days",
            "ISO weekdays 1..=7, each once, at least one",
        ));
    }
    Ok(())
}

fn trimmed(list: Vec<String>) -> Vec<String> {
    list.into_iter().map(|v| v.trim().to_owned()).collect()
}

async fn record(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    kind: &str,
    id: impl std::fmt::Display,
    payload: Value,
) -> Result<(), AppError> {
    let version = super::capabilities::version_in_force(r).await?;
    super::capabilities::append(r, ctx, action, kind, id, version, payload).await
}
