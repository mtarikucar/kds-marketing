//! An agent's hold on a production area: taking it at its start time, reporting the step it is
//! at, giving it back; a person's "Olmamış"; and the areas the system opens itself.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{TenantRepos, production_projects::*},
    usecases::{
        Deps, hash_token, ledger_entry,
        studio::{files, library, planner, projects},
    },
};
use jt_tenancy::{AgentConnectionId, Permission};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimInput {
    pub project_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgressInput {
    pub project_id: Uuid,
    pub claim_token: String,
    /// The step of the module's workflow the agent is at, 1 to 14.
    pub step: u8,
    pub note: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseInput {
    pub project_id: Uuid,
    pub claim_token: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedoInput {
    pub project_id: Uuid,
    /// The revision of the current package as the person saw it; `None`: no package yet.
    #[serde(default)]
    pub package_revision: Option<u32>,
    pub note: String,
}

#[derive(Debug, Serialize)]
pub struct AreaOut {
    pub project: ProductionProject,
}

/// `content.area_claim`'s answer. The token is shown here once; the area keeps only its hash.
#[derive(Debug, Serialize)]
pub struct ClaimOut {
    pub project: ProductionProject,
    pub claim_token: String,
}

/// The agent connection calling: an area is worked by an agent, never by a person.
pub(crate) fn agent(ctx: &Ctx) -> Result<AgentConnectionId, AppError> {
    ctx.agent_connection_id
        .ok_or_else(|| AppError::forbidden("only an agent can work an area"))
}

/// The area's live claim when `token` is its bearer's and the caller is its agent: not archived,
/// not held, the lease not run out.
pub(crate) fn claim<'a>(
    p: &'a ProductionProject,
    ctx: &Ctx,
    token: &str,
) -> Result<&'a AreaClaim, AppError> {
    let agent = agent(ctx)?;
    p.claim
        .as_ref()
        .filter(|c| {
            !p.archived
                && p.refused < MAX_REFUSALS
                && c.agent == agent
                && c.lease_until > ctx.now
                && c.token_hash == hash_token(token)
        })
        .ok_or_else(|| AppError::conflict("area claim is no longer live"))
}

/// `content.area_claim`: an agent takes an area whose start time has come and that nobody is
/// working. One live claim per area: of two agents asking at once, one is refused.
pub async fn area_claim(d: &Deps, ctx: &Ctx, i: ClaimInput) -> Result<ClaimOut, AppError> {
    ctx.require(Permission::ContentWork)?;
    let agent = agent(ctx)?;
    let mut r = library::open(d, ctx, Permission::ContentWork).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, Some(i.expected_revision), true).await?;
    if !p.needs_agent(ctx.now) {
        return Err(AppError::conflict("area is not ready to claim"));
    }
    let claim_token = d.tokens.token(32);
    p.claim = Some(AreaClaim {
        agent,
        token_hash: hash_token(&claim_token),
        at: ctx.now,
        lease_until: ctx.now + AREA_LEASE,
        redo_seen: p.redo.clone(),
    });
    p.progress = None;
    let project = projects::save(r.as_mut(), ctx, p, "content.area.claimed").await?;
    r.commit().await?;
    Ok(ClaimOut {
        project,
        claim_token,
    })
}

/// `content.area_progress`: the claim's agent says which step it is at; the lease starts again.
pub async fn area_progress(d: &Deps, ctx: &Ctx, i: ProgressInput) -> Result<AreaOut, AppError> {
    ctx.require(Permission::ContentWork)?;
    agent(ctx)?;
    let note = projects::text(&i.note, "note", MAX_GOAL_CHARS, true)?;
    if !(1..=AREA_STEPS).contains(&i.step) {
        return Err(AppError::validation(
            "step must be 1 to 14",
            json!({"field":"step"}),
        ));
    }
    let mut r = library::open(d, ctx, Permission::ContentWork).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, None, true).await?;
    claim(&p, ctx, &i.claim_token)?;
    if let Some(c) = &mut p.claim {
        c.lease_until = ctx.now + AREA_LEASE;
    }
    p.progress = Some(AreaProgress {
        step: i.step,
        note,
        at: ctx.now,
    });
    let project = projects::save(r.as_mut(), ctx, p, "content.area.progress").await?;
    r.commit().await?;
    Ok(AreaOut { project })
}

/// `content.area_release`: the claim's agent gives the area back, because it stops or because it
/// waits for a capture it asked for. The area keeps the step it reached, with the reason as its
/// note, and is queued (or waiting for material) again.
pub async fn area_release(d: &Deps, ctx: &Ctx, i: ReleaseInput) -> Result<AreaOut, AppError> {
    ctx.require(Permission::ContentWork)?;
    agent(ctx)?;
    let reason = projects::text(&i.reason, "reason", MAX_GOAL_CHARS, true)?;
    let mut r = library::open(d, ctx, Permission::ContentWork).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, None, true).await?;
    claim(&p, ctx, &i.claim_token)?;
    p.claim = None;
    p.progress = Some(AreaProgress {
        step: p.progress.as_ref().map_or(1, |g| g.step),
        note: reason,
        at: ctx.now,
    });
    let project = projects::save(r.as_mut(), ctx, p, "content.area.released").await?;
    r.commit().await?;
    Ok(AreaOut { project })
}

/// `content.area_redo`: a person says "Olmamış" with what should change (design B7). Panel-only,
/// and a person's in person: an agent's key does not carry it. The note stands until a delivery
/// answers it; an agent working the area keeps its claim; a held area is released to the agent
/// again. The note is about the package the person saw, so it is refused (`CONFLICT`) once a
/// newer one was delivered; an agent's progress reports in between do not stand in its way.
/// The package's planned posts that have not gone out are cancelled; a published one stays.
pub async fn area_redo(
    d: &Deps,
    ctx: &Ctx,
    i: RedoInput,
) -> Result<projects::ProjectDetail, AppError> {
    ctx.require(Permission::ContentManage)?;
    let by = library::person(ctx).ok_or_else(|| AppError::forbidden("redo requires a human"))?;
    let note = projects::text(&i.note, "note", MAX_GOAL_CHARS, true)?;
    // A version waiting at its platform's scheduler is taken back there first (design §7.3): if
    // the platform does not confirm, nothing changes and the person is told, here and now.
    {
        let mut r = library::open(d, ctx, Permission::ContentManage).await?;
        let p = projects::load(r.as_mut(), i.project_id, None, true).await?;
        if p.packages.last().map(|k| k.revision) != i.package_revision {
            return Err(AppError::conflict("the area's package changed"));
        }
        let slots: Vec<_> = p
            .packages
            .last()
            .map(|k| k.versions.iter().filter_map(|v| v.slot_id).collect())
            .unwrap_or_default();
        drop(r);
        for slot in slots {
            crate::usecases::studio::publish::withdraw_for_person(
                d,
                ctx.workspace_id,
                slot,
                "content_redo",
            )
            .await?;
        }
    }
    let mut r = library::open(d, ctx, Permission::ContentManage).await?;
    r.studio_control().lock_control().await?;
    let mut p = projects::load(r.as_mut(), i.project_id, None, true).await?;
    if p.packages.last().map(|k| k.revision) != i.package_revision {
        return Err(AppError::conflict("the area's package changed"));
    }
    // What has not gone out yet does not go out as it is: its planned posts are taken back.
    crate::usecases::social::schedule::withdraw_planned(r.as_mut(), ctx, &mut p).await?;
    p.redo = Some(RedoRequest {
        note,
        by,
        at: ctx.now,
    });
    // A held area's claim is dead (its agent was told so): the area is free for the next
    // check-in, with the note. Otherwise an agent at work keeps its claim.
    if p.state(ctx.now) == AreaState::Held {
        p.claim = None;
    }
    // The note replaces the refused delivery as the area's open matter.
    p.refused = 0;
    p.refusal = None;
    let p = projects::save(r.as_mut(), ctx, p, "content.area.redo").await?;
    let out = projects::detail(r.as_mut(), p).await?;
    r.commit().await?;
    Ok(out)
}

/// Opens an area for the system (design §6.3) inside the caller's transaction, once per `key`:
/// its id is the workspace's stable id of the key, and a second call answers the area as it is.
/// Answers the area and whether this call opened it.
#[allow(clippy::too_many_arguments)]
pub async fn open_by_system(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    trigger: AreaTrigger,
    key: &str,
    goal: &str,
    sources: &[jt_studio::MaterialId],
    start_at: OffsetDateTime,
    hints: AreaHints,
) -> Result<(ProductionProject, bool), AppError> {
    let goal = projects::text(goal, "brief", MAX_GOAL_CHARS, true)?;
    files::key(key)?;
    r.studio_control().lock_control().await?;
    let id = planner::stable_id(ctx.workspace_id, key);
    if let Some(p) = r.studio_projects().get_project(id).await? {
        return Ok((p.present(ctx.now), false));
    }
    if sources.len() > 100 || start_at > ctx.now + time::Duration::days(365) {
        return Err(AppError::validation(
            "invalid area",
            json!({"field":"sources"}),
        ));
    }
    let mut selected: Vec<ProjectSource> = Vec::new();
    for id in sources {
        if selected.iter().any(|s| s.material_id == *id) {
            continue;
        }
        let m = projects::material(r, *id).await?;
        selected.push(ProjectSource {
            material_id: *id,
            revision: m.revision,
        });
    }
    let p = ProductionProject {
        id,
        workspace_id: ctx.workspace_id,
        title: projects::goal_title(&goal),
        brief: goal,
        revision: 1,
        archived: false,
        sources: selected,
        requests: vec![],
        outputs: vec![],
        production_ids: vec![],
        invalidated_production_ids: vec![],
        created_at: ctx.now,
        updated_at: ctx.now,
        start_at: Some(projects::whole_micros(start_at)),
        opened_by: OpenedBy::System {
            trigger,
            key: key.into(),
        },
        hints,
        claim: None,
        progress: None,
        packages: vec![],
        redo: None,
        refused: 0,
        refusal: None,
        state: None,
    };
    r.studio_projects().save_project(p.clone(), None).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "content.area.opened",
            "production_project",
            id,
            json!({"trigger":trigger}),
        )?)
        .await?;
    Ok((p.present(ctx.now), true))
}
