//! From a content package to planned posts (design 2026-11-10 §7.2): the versions that wait for
//! a time, and the one use case that gives a version its time. Planning the post and storing the
//! version as its slot's piece happen in one transaction, so a version is either scheduled and
//! ready to go out or untouched.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        materials::MaterialRelease,
        production_projects::{PackageVersion, ProductionProject},
    },
    usecases::{
        Deps, content, hash_token, ledger_entry,
        studio::{
            chain,
            files::{decode, encode, key},
            materials,
            pieces::{PieceContent, store_piece},
            planner::stable_id,
            posts::{
                PackageProposalInput, PostOut, ProposedPost, channels, content_types, group_ids,
                post_out, postable, posts_propose_locked, retire_post_of, selected,
            },
            projects,
            work::{EmptyInput, gated},
        },
    },
};
use jt_capability::CapabilityId;
use jt_studio::{
    ChannelContent, MaterialId, MediaAsset, PackageHints, PackageRequest, PackageRequestId,
    PackageStatus, PackageTrigger, PostFormat, RetirementReason, SlotId, SlotState,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

const ACTION: &str = "social.version_schedule";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionScheduleInput {
    pub project_id: Uuid,
    pub version_id: Uuid,
    /// The account it goes out on: the version's own when it names one.
    pub capability_id: CapabilityId,
    #[serde(with = "time::serde::rfc3339")]
    pub publish_at: OffsetDateTime,
    pub request_key: String,
}

/// The area with the version's planned post named in it, and that post with its slot.
#[derive(Clone, Debug, Serialize)]
pub struct VersionScheduleOut {
    pub project: ProductionProject,
    pub publication: PostOut,
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field":field,"reason":reason}))
}

/// The text that goes out for a version: its text, then its tags as hashtags on a line of their
/// own. A version's title is not part of a post's text.
pub(crate) fn caption(v: &PackageVersion) -> String {
    let tags: Vec<String> = v
        .tags
        .iter()
        .map(|t| t.trim().trim_start_matches('#'))
        .filter(|t| !t.is_empty())
        .map(|t| format!("#{t}"))
        .collect();
    match (v.text.is_empty(), tags.is_empty()) {
        (_, true) => v.text.clone(),
        (true, false) => tags.join(" "),
        (false, false) => format!("{}\n\n{}", v.text, tags.join(" ")),
    }
}

/// The answer for the version whose planned post is `slot`, read as things are now.
async fn answer(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    project_id: Uuid,
    slot: SlotId,
) -> Result<VersionScheduleOut, AppError> {
    let project = projects::load(r, project_id, None, false).await?;
    let post = r
        .studio_posts()
        .get_post(slot)
        .await?
        .ok_or_else(|| AppError::not_found("planned post"))?;
    let slot = r
        .studio()
        .get_slot(slot)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    Ok(VersionScheduleOut {
        project: project.present(ctx.now),
        publication: post_out(post, slot, ctx.now),
    })
}

/// `social.version_schedule`: gives a platform version of an area's current package its account
/// and time. The post is planned by the posting engine under every rule it has (the channel and
/// its formats, the hypothesis, lead, horizon, quiet hours, daily caps, spacing, the material
/// gate), and in the same transaction the version's text and materials become the slot's piece,
/// so the slot is ready at once. A refusal of the engine answers as `studio.posts_propose`
/// answers it, and stores nothing. One planned post per version: a second call for the same
/// version is refused (`version_already_scheduled`), the same call replays by `request_key`.
pub async fn version_schedule(
    d: &Deps,
    ctx: &Ctx,
    i: VersionScheduleInput,
) -> Result<VersionScheduleOut, AppError> {
    ctx.require(Permission::SocialWork)?;
    key(&i.request_key)?;
    let payload = json!(hash_token(&encode(&i)?.to_string()));
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(r.as_mut(), ctx, &[Permission::SocialWork]).await?;
    r.studio_control().lock_control().await?;
    if let Some(saved) = r
        .studio()
        .request_replay(ACTION, &i.request_key, &payload)
        .await?
    {
        let slot: SlotId = decode(saved)?;
        return answer(r.as_mut(), ctx, i.project_id, slot).await;
    }
    let mut project = projects::load(r.as_mut(), i.project_id, None, true).await?;
    // A person asked for a change: what is there now is not what should go out.
    if project.redo.is_some() {
        return Err(chain::refuse("area_redo_open"));
    }
    let package = project
        .packages
        .last()
        .ok_or_else(|| AppError::not_found("content package"))?;
    let released = package.released.clone();
    let index = package
        .versions
        .iter()
        .position(|v| v.id == i.version_id)
        .ok_or_else(|| AppError::not_found("package version"))?;
    let version = package.versions[index].clone();
    if version.slot_id.is_some() {
        return Err(chain::refuse("version_already_scheduled"));
    }
    if version.capability_id.is_some_and(|c| c != i.capability_id) {
        return Err(invalid("capability_id", "version_made_for_another_account"));
    }
    let mut shown = Vec::new();
    for id in &version.material_ids {
        shown.push(projects::material(r.as_mut(), *id).await?);
    }
    let subject = content::delivery::subject_of(&shown);
    // The content type a version carries is its maker's label. It steers the post only when the
    // strategy names it for the version's hypothesis on this kind of account; any other label
    // leaves the choice to the engine (the hypothesis's first type), so that a label the
    // strategy does not know never leaves a finished version without a way out.
    let content_type = match (
        &version.content_type,
        r.capabilities().find(i.capability_id).await?,
    ) {
        (Some(named), Some(account)) => r
            .hypotheses()
            .list(frame.id)
            .await?
            .iter()
            .find(|h| h.id == version.hypothesis_id)
            .is_some_and(|h| content_types(h, &account.kind_key).contains(named))
            .then(|| named.clone()),
        _ => None,
    };

    // The engine plans one post for a request: the version's own, keyed by the version. A
    // version whose planned post was taken back or moved has no post now (checked above, under
    // the control lock) and is planned again under the next key of its own (`…:2`, `…:3`).
    let base_key = format!("project:{}:version:{}", project.id, version.id);
    let mut request = None;
    for round in 1..=MAX_ROUNDS {
        let package_key = if round == 1 {
            base_key.clone()
        } else {
            format!("{base_key}:{round}")
        };
        let candidate = PackageRequest {
            id: PackageRequestId(stable_id(ctx.workspace_id, &package_key)),
            workspace_id: ctx.workspace_id,
            key: package_key,
            trigger: PackageTrigger::Project,
            status: PackageStatus::Open,
            olay_id: None,
            occasion: None,
            year: None,
            capability_id: Some(i.capability_id),
            material_ids: version.material_ids.clone(),
            best_formats: vec![],
            hints: PackageHints {
                max_posts: Some(1),
                subject: Some(subject),
                hypothesis_id: Some(version.hypothesis_id),
                content_type: content_type.clone(),
                ..Default::default()
            },
            created_at: ctx.now,
            answered_at: None,
            closed_at: None,
        };
        candidate
            .validate()
            .map_err(|e| AppError::internal(format!("version package: {e}")))?;
        if r.studio_posts()
            .insert_package_request(candidate.clone())
            .await?
        {
            request = Some(candidate);
            break;
        }
    }
    let Some(request) = request else {
        return Err(chain::refuse("version_already_scheduled"));
    };
    let package_key = request.key.clone();
    let planned = posts_propose_locked(
        d,
        ctx,
        r.as_mut(),
        &frame,
        PackageProposalInput {
            request_id: request.id,
            request_key: package_key.clone(),
            posts: vec![ProposedPost {
                format: version.format,
                capability_id: i.capability_id,
                publish_at: i.publish_at,
                material_ids: version.material_ids.clone(),
                subject,
                hypothesis_id: version.hypothesis_id,
                content_type,
            }],
        },
    )
    .await?
    .posts
    .into_iter()
    .next()
    .ok_or_else(|| AppError::internal("version scheduling returned no post"))?;

    // The version as the slot's piece: its text with its tags, its materials' files in order,
    // and its link on the account it goes out on.
    let text = caption(&version);
    let media: Vec<MediaAsset> = shown
        .iter()
        .map(|m| MediaAsset::File { id: m.file_id })
        .collect();
    let mut adaptations = BTreeMap::new();
    if let Some(link) = &version.link {
        let account = r
            .capabilities()
            .find(i.capability_id)
            .await?
            .and_then(|c| c.external_id)
            .ok_or_else(|| invalid("capability_id", "account_has_no_provider_id"))?;
        adaptations.insert(
            account,
            ChannelContent {
                text: text.clone(),
                media: media.clone(),
                link: Some(url::Url::parse(link).map_err(|_| invalid("link", "invalid_link"))?),
                privacy: None,
            },
        );
    }
    let slot = planned.slot;
    let piece = store_piece(
        d,
        ctx,
        r.as_mut(),
        &frame,
        &slot,
        slot.revision,
        subject,
        PieceContent {
            text,
            media,
            adaptations,
        },
        &package_key,
    )
    .await?;
    // A person accepted this package although the text check held it (design B45): what that
    // check finds in the piece is released on their word, or the publisher would hold the post.
    if let Some(release) = released
        && let Some(check) =
            materials::material_check(r.as_mut(), slot.id, &piece, ctx.now.max(slot.scheduled_at))
                .await?
        && !check.findings.is_empty()
    {
        r.studio_materials()
            .save_release(MaterialRelease {
                slot_id: slot.id,
                revision: piece.revision,
                digest: check.digest,
                by: release.by,
                at: ctx.now,
            })
            .await?;
    }
    if let Some(package) = project.packages.last_mut() {
        package.versions[index].slot_id = Some(slot.id);
    }
    projects::save(r.as_mut(), ctx, project, "social.version.scheduled").await?;
    r.studio()
        .request_receipt(ACTION, &i.request_key, &payload, &json!(slot.id))
        .await?;
    let out = answer(r.as_mut(), ctx, i.project_id, slot.id).await?;
    r.commit().await?;
    Ok(out)
}

/// Takes back the planned posts of the area's current package that have not gone out, because a
/// person asked for the content to change (design B7): each such post is cancelled with the
/// reason `content_redo` and its version is free again. A version that was published keeps its
/// post, and so does one a provider may be taking at this moment: neither can be taken back.
/// Answers how many posts were cancelled.
pub(crate) async fn withdraw_planned(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    project: &mut ProductionProject,
) -> Result<usize, AppError> {
    let Some(package) = project.packages.last_mut() else {
        return Ok(0);
    };
    let frame = r.strategy().current_approved().await?.map(|v| v.id);
    let mut cancelled = 0;
    for version in &mut package.versions {
        let Some(slot_id) = version.slot_id else {
            continue;
        };
        let Some(slot) = r.studio().get_slot(slot_id).await? else {
            continue;
        };
        let queued = matches!(slot.state, SlotState::Planned | SlotState::Ready);
        let in_flight = r.studio().slot_evidence(slot.id).await?.0.iter().any(|a| {
            matches!(
                a.state(),
                jt_studio::PublishState::Sending | jt_studio::PublishState::Unknown
            )
        });
        if !queued || in_flight {
            continue;
        }
        let retired = r
            .studio()
            .retire_slot(slot.id, slot.revision, "cancelled")
            .await?;
        retire_post_of(r, retired.id, RetirementReason::Cancelled, ctx.now).await?;
        let mut entry = ledger_entry(
            ctx,
            "studio.slot_cancel",
            "studio_slot",
            retired.id,
            json!({"reason":"content_redo","born_version_id":retired.chain.born_version_id,
                   "executed_version_id":frame,"revision":retired.revision}),
        )?;
        entry.strategy_version_id = frame.map(|id| id.0);
        r.ledger().append(entry).await?;
        version.slot_id = None;
        cancelled += 1;
    }
    Ok(cancelled)
}

/// How many times one version can be planned (each planning after a post was taken back or
/// moved takes the next key).
const MAX_ROUNDS: u32 = 50;

/// Frees the content version whose planned post was `slot`, when the post was a version's
/// (its package request is keyed `project:<area>:version:<version>`, with `:<round>` after it
/// from its second planning on): the version waits for a time again. Nothing for any other post.
pub(crate) async fn free_version_of(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    slot: jt_studio::SlotId,
) -> Result<(), AppError> {
    let Some(post) = r.studio_posts().get_post(slot).await? else {
        return Ok(());
    };
    let Some(request) = r
        .studio_posts()
        .get_package_request(post.package_request_id)
        .await?
    else {
        return Ok(());
    };
    let mut parts = request.key.split(':');
    let (Some("project"), Some(project), Some("version"), Some(_)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(());
    };
    // Nothing after the version, or its planning round and nothing after that.
    if parts
        .next()
        .is_some_and(|round| round.parse::<u32>().is_err())
        || parts.next().is_some()
    {
        return Ok(());
    }
    let Ok(project) = Uuid::parse_str(project) else {
        return Ok(());
    };
    let Some(mut p) = r.studio_projects().get_project(project).await? else {
        return Ok(());
    };
    let mut freed = false;
    if let Some(package) = p.packages.last_mut() {
        for version in &mut package.versions {
            if version.slot_id == Some(slot) {
                version.slot_id = None;
                freed = true;
            }
        }
    }
    if freed {
        crate::usecases::studio::projects::save(r, ctx, p, "social.version.released").await?;
    }
    Ok(())
}

/// A finished package with versions that wait for a time.
#[derive(Clone, Debug, Serialize)]
pub struct WaitingPackage {
    pub project_id: Uuid,
    /// The area's goal sentence.
    pub goal: String,
    pub summary: String,
    #[serde(with = "jt_studio::time_compat")]
    pub delivered_at: OffsetDateTime,
    pub versions: Vec<WaitingVersion>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WaitingVersion {
    pub version_id: Uuid,
    pub format: PostFormat,
    pub text: String,
    pub material_ids: Vec<MaterialId>,
    /// The accounts it could go out on now: the version's own when it names one, else every
    /// live social account of the strategy that takes its format for its hypothesis.
    pub accounts: Vec<CapabilityId>,
    /// Why no account can take it now, when none can: `no_approved_strategy`,
    /// `no_connected_account`, `account_paused`, `its_account_unavailable` (the account the
    /// version was made for), `format_not_supported`, `channel_not_in_strategy`,
    /// `hypothesis_does_not_post` (its hypothesis has no organic cadence for these accounts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<&'static str>,
}

/// Why none of the workspace's social accounts can take version `v` at `now`, the first reason
/// that holds, in the order a person would fix them.
async fn why_blocked(
    d: &Deps,
    r: &mut dyn TenantRepos,
    frame: Option<&jt_strategy::StrategyVersion>,
    v: &PackageVersion,
    now: OffsetDateTime,
) -> Result<&'static str, AppError> {
    let Some(frame) = frame else {
        return Ok("no_approved_strategy");
    };
    let paused = r
        .studio_posts()
        .posting_settings()
        .await?
        .paused_capability_ids;
    let connected: Vec<_> = r
        .capabilities()
        .list(Default::default())
        .await?
        .into_iter()
        .filter(|c| postable(d, c, now))
        .collect();
    if connected.is_empty() {
        return Ok("no_connected_account");
    }
    let open: Vec<_> = connected
        .into_iter()
        .filter(|c| !paused.contains(&c.id))
        .collect();
    if open.is_empty() {
        return Ok("account_paused");
    }
    let own: Vec<_> = open
        .into_iter()
        .filter(|c| v.capability_id.is_none_or(|id| id == c.id))
        .collect();
    if own.is_empty() {
        return Ok("its_account_unavailable");
    }
    let fitting: Vec<_> = own
        .into_iter()
        .filter(|c| jt_studio::supported_formats(&c.kind_key).contains(&v.format))
        .collect();
    if fitting.is_empty() {
        return Ok("format_not_supported");
    }
    let mut chosen = Vec::new();
    for c in fitting {
        if selected(frame, &c.kind_key, &group_ids(r, c.id).await?) {
            chosen.push(c);
        }
    }
    if chosen.is_empty() {
        return Ok("channel_not_in_strategy");
    }
    Ok("hypothesis_does_not_post")
}

/// `social.versions_waiting`: the versions of finished packages that no planned post was made
/// of, oldest delivery first, each with the accounts that could take it. With no approved
/// strategy nothing can be posted, and every version lists no account.
pub async fn versions_waiting(
    d: &Deps,
    ctx: &Ctx,
    _: EmptyInput,
) -> Result<Vec<WaitingPackage>, AppError> {
    ctx.require(Permission::SocialWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    waiting(d, r.as_mut(), ctx.now).await
}

/// See [`versions_waiting`]; `work.pending` lists the same versions.
pub(crate) async fn waiting(
    d: &Deps,
    r: &mut dyn TenantRepos,
    now: OffsetDateTime,
) -> Result<Vec<WaitingPackage>, AppError> {
    let frame = r.strategy().current_approved().await?;
    let live = match &frame {
        Some(frame) => channels(d, r, frame, now).await?,
        None => Vec::new(),
    };
    let mut out = Vec::new();
    for area in r.studio_projects().list_areas_waiting().await? {
        let Some(package) = area.packages.last() else {
            continue;
        };
        let mut versions = Vec::new();
        for v in area.waiting_versions() {
            let accounts: Vec<CapabilityId> = live
                .iter()
                .filter(|ch| {
                    v.capability_id.is_none_or(|c| c == ch.capability.id)
                        && jt_studio::supported_formats(&ch.capability.kind_key).contains(&v.format)
                        && ch
                            .options
                            .iter()
                            .any(|o| o.hypothesis_id == v.hypothesis_id)
                })
                .map(|ch| ch.capability.id)
                .collect();
            let blocked = if accounts.is_empty() {
                Some(why_blocked(d, r, frame.as_ref(), v, now).await?)
            } else {
                None
            };
            versions.push(WaitingVersion {
                version_id: v.id,
                format: v.format,
                text: v.text.clone(),
                material_ids: v.material_ids.clone(),
                accounts,
                blocked,
            });
        }
        out.push(WaitingPackage {
            project_id: area.id,
            goal: area.brief.clone(),
            summary: package.summary.clone(),
            delivered_at: package.delivered_at,
            versions,
        });
    }
    Ok(out)
}
