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
        production_projects::{PackageVersion, ProductionProject, VersionCancel},
    },
    usecases::{
        Deps, content, hash_token, ledger_entry,
        studio::{
            chain,
            files::{decode, encode, key},
            materials, owner_request,
            pieces::{PieceContent, store_piece},
            planner::stable_id,
            posts::{
                Channel, PackageProposalInput, PostOut, ProposedPost, content_types, open_channels,
                post_out, postable, posts_propose_locked, retire_post_of,
            },
            projects,
            work::{EmptyInput, gated},
        },
    },
};
use jt_capability::CapabilityId;
use jt_strategy::{Hypothesis, HypothesisId};
use jt_studio::{
    ChannelContent, MaterialId, MediaAsset, PackageHints, PackageRequest, PackageRequestId,
    PackageStatus, PackageTrigger, PostFormat, RetirementReason, SlotId, SlotState,
};
use jt_tenancy::{Permission, UserId};
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
/// version is refused (`version_already_scheduled`), the same call replays by `request_key`; a
/// version whose post a person cancelled is never planned again (`version_cancelled`).
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
    if version.cancelled.is_some() {
        return Err(chain::refuse("version_cancelled"));
    }
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
    // The version's hypothesis is a preference (design 2026-11-19 F1): on an account where it
    // does not post, the post goes out under the one [`VersionAccounts::pick`] settles on, as
    // `social.versions_waiting` offered it. An account nothing settles for is refused by the
    // engine below with its reason, as before.
    let reader = VersionAccounts::load(d, r.as_mut(), ctx.now).await?;
    let settled = reader
        .channel(i.capability_id)
        .and_then(|ch| reader.pick(ch, &project, &version));
    let hypothesis_id = settled.map_or(version.hypothesis_id, |(h, _)| h);
    if let Some((h, Attribution::OwnerRequest)) = settled {
        owner_request::ensure(r.as_mut(), ctx.workspace_id, frame.id, false).await?;
        debug_assert!(owner_request::is(ctx.workspace_id, h));
    }
    // The content type a version carries is its maker's label. It steers the post only when the
    // strategy names it for the post's hypothesis on this kind of account; any other label
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
            .find(|h| h.id == hypothesis_id)
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
                hypothesis_id: Some(hypothesis_id),
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
                hypothesis_id,
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
    // What the post was attributed to, when it is not the version's own hypothesis: the
    // measurement reads the slot's chain, the ledger says why it is that one.
    if let Some((h, attribution)) = settled.filter(|(_, a)| *a != Attribution::Version) {
        r.ledger()
            .append(ledger_entry(
                ctx,
                "social.version.attributed",
                "studio_slot",
                slot.id,
                json!({"project_id":project.id,"version_id":version.id,
                       "version_hypothesis_id":version.hypothesis_id,"hypothesis_id":h,
                       "attribution":attribution,"born_version_id":frame.id}),
            )?)
            .await?;
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
/// Answers the posts it cancelled.
pub(crate) async fn withdraw_planned(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    project: &mut ProductionProject,
) -> Result<Vec<SlotId>, AppError> {
    let Some(package) = project.packages.last_mut() else {
        return Ok(Vec::new());
    };
    let frame = r.strategy().current_approved().await?.map(|v| v.id);
    let mut cancelled = Vec::new();
    for version in &mut package.versions {
        let Some(slot_id) = version.slot_id else {
            continue;
        };
        let Some(slot) = r.studio().get_slot(slot_id).await? else {
            continue;
        };
        if !withdrawable(&slot, &r.studio().slot_evidence(slot.id).await?.0) {
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
        cancelled.push(retired.id);
    }
    Ok(cancelled)
}

/// Whether a redo takes back the planned post `slot` with its `attempts` ([`withdraw_planned`]):
/// still planned or ready, and no provider may be taking it at this moment.
pub(crate) fn withdrawable(slot: &jt_studio::Slot, attempts: &[jt_studio::PublishAttempt]) -> bool {
    matches!(slot.state, SlotState::Planned | SlotState::Ready)
        && !attempts.iter().any(|a| {
            matches!(
                a.state(),
                jt_studio::PublishState::Sending | jt_studio::PublishState::Unknown
            )
        })
}

/// The area whose content version the planned post `slot` was made of: its package request is
/// keyed `project:<area>:version:<version>`, with `:<round>` after it from its second planning
/// on. `None` for any other post (one an agent proposed directly, a weekly quota's).
pub(crate) async fn area_of(
    r: &mut dyn TenantRepos,
    slot: jt_studio::SlotId,
) -> Result<Option<Uuid>, AppError> {
    let Some(post) = r.studio_posts().get_post(slot).await? else {
        return Ok(None);
    };
    let Some(request) = r
        .studio_posts()
        .get_package_request(post.package_request_id)
        .await?
    else {
        return Ok(None);
    };
    Ok(area_key(&request.key))
}

/// The area a package request key names, when it is a content version's
/// (`project:<area>:version:<version>`, with `:<round>` after it from its second planning on);
/// `None` for any other key.
pub(crate) fn area_key(key: &str) -> Option<Uuid> {
    let mut parts = key.split(':');
    let (Some("project"), Some(project), Some("version"), Some(_)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    // Nothing after the version, or its planning round and nothing after that.
    if parts
        .next()
        .is_some_and(|round| round.parse::<u32>().is_err())
        || parts.next().is_some()
    {
        return None;
    }
    Uuid::parse_str(project).ok()
}

/// How many times one version can be planned (each planning after a post was taken back or
/// moved takes the next key).
const MAX_ROUNDS: u32 = 50;

/// Frees the content version whose planned post was `slot`, when the post was a version's
/// (its package request is keyed `project:<area>:version:<version>`, with `:<round>` after it
/// from its second planning on): the version waits for a time again. Nothing for any other post,
/// nor for a version a person cancelled ([`VersionCancel`]): it keeps its post and stays ended.
pub(crate) async fn free_version_of(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    slot: jt_studio::SlotId,
) -> Result<(), AppError> {
    let Some(project) = area_of(r, slot).await? else {
        return Ok(());
    };
    let Some(mut p) = r.studio_projects().get_project(project).await? else {
        return Ok(());
    };
    let mut freed = false;
    if let Some(package) = p.packages.last_mut() {
        for version in &mut package.versions {
            if version.slot_id == Some(slot) && version.cancelled.is_none() {
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

/// Whether a person's cancel of the planned post `slot` leaves nothing of area `p` to go out, so
/// that the area is archived with it: `slot` is the post of a version of the current package of
/// an area not archived, every other version of that package was cancelled by a person, and no
/// post of the area (of any package) went out.
pub(crate) async fn cancel_archives(
    r: &mut dyn TenantRepos,
    p: &ProductionProject,
    slot: SlotId,
) -> Result<bool, AppError> {
    let Some(package) = p.packages.last().filter(|_| !p.archived) else {
        return Ok(false);
    };
    if !package.versions.iter().any(|v| v.slot_id == Some(slot))
        || package
            .versions
            .iter()
            .any(|v| v.slot_id != Some(slot) && v.cancelled.is_none())
    {
        return Ok(false);
    }
    let slots: Vec<SlotId> = p.posts().iter().map(|x| x.slot_id).collect();
    Ok(r.studio().publications_of(&slots).await?.is_empty())
}

/// A person's cancel of the planned post `slot` ("İptal et", `studio.slot_cancel` in person) when
/// it was made of a version of an area's current package: the version is marked cancelled with
/// the person's `reason` ([`VersionCancel`]) and keeps its retired post, so it is never planned
/// again; the content's other versions stay as they are. Once every version of the package is
/// cancelled and nothing of the area went out ([`cancel_archives`]), the area is archived with it.
/// Answers whether it archived the area. Nothing for any other post.
pub(crate) async fn cancel_version_of(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    slot: SlotId,
    by: UserId,
    reason: &str,
) -> Result<bool, AppError> {
    let Some(id) = area_of(r, slot).await? else {
        return Ok(false);
    };
    let Some(mut p) = r.studio_projects().get_project(id).await? else {
        return Ok(false);
    };
    if p.archived {
        return Ok(false);
    }
    let archive = cancel_archives(r, &p, slot).await?;
    let Some(version) = p
        .packages
        .last_mut()
        .and_then(|k| k.versions.iter_mut().find(|v| v.slot_id == Some(slot)))
    else {
        return Ok(false);
    };
    version.cancelled = Some(VersionCancel {
        by,
        at: ctx.now,
        reason: reason.to_owned(),
        slot_id: Some(slot),
    });
    if archive {
        projects::invalidate(r, ctx, &mut p, None, "project_archived", false).await?;
        p.archived = true;
    }
    let p = projects::save(r, ctx, p, "content.version.cancelled").await?;
    if archive {
        r.ledger()
            .append(ledger_entry(
                ctx,
                "content.area.archived",
                "production_project",
                p.id,
                json!({"reason":"every_version_cancelled","slot_id":slot,"revision":p.revision}),
            )?)
            .await?;
    }
    Ok(archive)
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
    /// live social account of the strategy that takes its format and its materials, and that a
    /// hypothesis of the strategy posts on (or, for a content a person asked for naming the
    /// account, the owner's request).
    pub accounts: Vec<CapabilityId>,
    /// The same accounts, each with what stands between a time and the post going out there.
    pub choices: Vec<AccountChoice>,
    /// Why no account can take it now, when none can: `material_removed` (a material it shows was
    /// deleted: only a revision helps), `braked` (posting is stopped for every account: the
    /// organic brake), `knowledge_empty` (no frame yet: the knowledge base has no card text),
    /// `no_connected_account`, `account_paused`, `its_account_unavailable` (the account the
    /// version was made for), `format_not_supported`, `media_not_accepted` (its materials are
    /// not what the account's platform takes in this format, say an image for TikTok),
    /// `hypothesis_does_not_post` (no topic of the frame posts
    /// on the accounts' channel). Each is read from the facts now: it goes the moment its cause
    /// does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<&'static str>,
}

/// One account a waiting version could go out on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AccountChoice {
    pub capability_id: CapabilityId,
    /// Who must act after the post has its time, before it goes out: a person's approval (the
    /// account's policy), the platform's own posting screen a person fills (TikTok, every post),
    /// or nobody.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_gate: Option<HumanGate>,
    /// Which hypothesis the post is attributed to there ([`Attribution`]).
    pub attribution: Attribution,
}

/// A person's step between a planned post and its publication.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HumanGate {
    /// The account asks for a person's approval of every post (`requires_human_approval`).
    Approval,
    /// The platform's posting screen, which a person fills for every post (TikTok).
    PostingScreen,
}

/// How the hypothesis of a post made of a version is settled on an account (design 2026-11-19
/// F1): the version's own hypothesis is a preference, chosen when the agent delivered it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Attribution {
    /// The version's own hypothesis posts there.
    Version,
    /// Another hypothesis of the same segment posts there.
    Segment,
    /// Another hypothesis of the strategy posts there.
    Channel,
    /// None does, and a person asked for this content naming the account: the owner's request
    /// (`owner_request`), rule R3.
    OwnerRequest,
}

/// Why none of the workspace's social accounts can take version `v` (with materials of `mimes`)
/// at `now`, the first reason that holds, in the order a person would fix them.
async fn why_blocked(
    d: &Deps,
    r: &mut dyn TenantRepos,
    frame: Option<&jt_strategy::StrategyVersion>,
    braked: bool,
    v: &PackageVersion,
    mimes: &[String],
    now: OffsetDateTime,
) -> Result<&'static str, AppError> {
    // Posting is stopped for every account: nothing is offered until a person resumes it.
    if braked {
        return Ok("braked");
    }
    // No frame: the knowledge base has no card text yet (design §4.5.1).
    if frame.is_none() {
        return Ok("knowledge_empty");
    }
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
    // The version's own account first: its pause is the cause, not another account's state.
    let own: Vec<_> = connected
        .into_iter()
        .filter(|c| v.capability_id.is_none_or(|id| id == c.id))
        .collect();
    if own.is_empty() {
        return Ok("its_account_unavailable");
    }
    let open: Vec<_> = own
        .into_iter()
        .filter(|c| !paused.contains(&c.id))
        .collect();
    if open.is_empty() {
        return Ok("account_paused");
    }
    let fitting: Vec<_> = open
        .into_iter()
        .filter(|c| jt_studio::supported_formats(&c.kind_key).contains(&v.format))
        .collect();
    if fitting.is_empty() {
        return Ok("format_not_supported");
    }
    let taking: Vec<_> = fitting
        .into_iter()
        .filter(|c| takes_media(v, &c.kind_key, mimes))
        .collect();
    if taking.is_empty() {
        return Ok("media_not_accepted");
    }
    // Every frame carries `channels = [any]` (K6): the defensive fall-through, which a
    // normalised frame never reaches (`knowledge_settle` gives a live topic its cadence).
    Ok("hypothesis_does_not_post")
}

/// Whether a platform of `kind` takes version `v`'s materials, of `mimes`, in its format.
fn takes_media(v: &PackageVersion, kind: &str, mimes: &[String]) -> bool {
    let mimes: Vec<&str> = mimes.iter().map(String::as_str).collect();
    jt_studio::media_types_ok(v.format, kind, &mimes)
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

/// What decides which accounts can take a waiting version now: the approved strategy, its
/// hypotheses and the accounts a post may go out on, read once for any number of versions.
pub(crate) struct VersionAccounts {
    frame: Option<jt_strategy::StrategyVersion>,
    hypotheses: Vec<Hypothesis>,
    open: Vec<Channel>,
    /// The knowledge base's rules, for the effective post gate (none before seeding).
    knowledge: Option<jt_knowledge::KnowledgeSettings>,
    /// The organic brake: while it is on, no account is offered.
    braked: bool,
}

impl VersionAccounts {
    pub(crate) async fn load(
        d: &Deps,
        r: &mut dyn TenantRepos,
        now: OffsetDateTime,
    ) -> Result<Self, AppError> {
        let frame = r.strategy().current_approved().await?;
        let (hypotheses, open) = match &frame {
            Some(frame) => (
                r.hypotheses().list(frame.id).await?,
                open_channels(d, r, frame, now).await?,
            ),
            None => (Vec::new(), Vec::new()),
        };
        let knowledge = super::approval::rules(r).await?;
        let braked = r
            .studio_control()
            .lock_control()
            .await?
            .is_braked(jt_strategy::LaneKind::Organic);
        Ok(Self {
            frame,
            hypotheses,
            open,
            knowledge,
            braked,
        })
    }

    /// The account `id`, when a post may go out on it now.
    pub(crate) fn channel(&self, id: CapabilityId) -> Option<&Channel> {
        self.open.iter().find(|ch| ch.capability.id == id)
    }

    /// The hypothesis a post made of version `v` of area `p` goes out under on channel `ch`, and
    /// why that one (design 2026-11-19 F1): the version's own when it posts there; else the first
    /// of the same segment that does; else the first that does; else, when `p` is a person's
    /// request naming the account, the owner's request; else none.
    pub(crate) fn pick(
        &self,
        ch: &Channel,
        p: &ProductionProject,
        v: &PackageVersion,
    ) -> Option<(HypothesisId, Attribution)> {
        if ch
            .options
            .iter()
            .any(|o| o.hypothesis_id == v.hypothesis_id)
        {
            return Some((v.hypothesis_id, Attribution::Version));
        }
        let segment = self
            .hypotheses
            .iter()
            .find(|h| h.id == v.hypothesis_id)
            .map(|h| h.segment_key.as_str());
        if let Some(o) = segment.and_then(|s| ch.options.iter().find(|o| o.segment_key == s)) {
            return Some((o.hypothesis_id, Attribution::Segment));
        }
        if let Some(o) = ch.options.first() {
            return Some((o.hypothesis_id, Attribution::Channel));
        }
        owner_request::names(p, &ch.capability).then(|| {
            (
                owner_request::id(ch.capability.workspace_id),
                Attribution::OwnerRequest,
            )
        })
    }

    /// The accounts version `v` of area `p` could go out on now, each with its person's step and
    /// attribution, and, when none can, why ([`WaitingVersion::blocked`]).
    pub(crate) async fn of(
        &self,
        d: &Deps,
        r: &mut dyn TenantRepos,
        p: &ProductionProject,
        v: &PackageVersion,
        now: OffsetDateTime,
    ) -> Result<(Vec<AccountChoice>, Option<&'static str>), AppError> {
        // Posting is stopped, the first reason: the social agent schedules nothing into a
        // stopped lane, so no freed post loops (design §3.10.2).
        if self.braked {
            return Ok((Vec::new(), Some("braked")));
        }
        let mut mimes = Vec::new();
        let mut removed = false;
        for id in &v.material_ids {
            match r.studio_materials().get_material(*id).await? {
                Some(m) if m.erased_at.is_none() => mimes.push(m.mime),
                _ => removed = true,
            }
        }
        // A version showing a material that was deleted cannot go out as it is: only a revision
        // (a new delivery without it) helps.
        if removed {
            return Ok((Vec::new(), Some("material_removed")));
        }
        let choices: Vec<AccountChoice> = self
            .open
            .iter()
            .filter(|ch| {
                v.capability_id.is_none_or(|c| c == ch.capability.id)
                    && jt_studio::supported_formats(&ch.capability.kind_key).contains(&v.format)
                    && takes_media(v, &ch.capability.kind_key, &mimes)
            })
            .filter_map(|ch| {
                self.pick(ch, p, v).map(|(_, attribution)| AccountChoice {
                    capability_id: ch.capability.id,
                    human_gate: super::approval::post_gate(&ch.capability, self.knowledge.as_ref()),
                    attribution,
                })
            })
            .collect();
        let blocked = if choices.is_empty() {
            Some(why_blocked(d, r, self.frame.as_ref(), self.braked, v, &mimes, now).await?)
        } else {
            None
        };
        Ok((choices, blocked))
    }
}

/// See [`versions_waiting`]; `work.pending` lists the same versions.
pub(crate) async fn waiting(
    d: &Deps,
    r: &mut dyn TenantRepos,
    now: OffsetDateTime,
) -> Result<Vec<WaitingPackage>, AppError> {
    let reader = VersionAccounts::load(d, r, now).await?;
    let mut out = Vec::new();
    for area in r.studio_projects().list_areas_waiting().await? {
        let Some(package) = area.packages.last() else {
            continue;
        };
        let mut versions = Vec::new();
        for v in area.waiting_versions() {
            let (choices, blocked) = reader.of(d, r, &area, v, now).await?;
            versions.push(WaitingVersion {
                version_id: v.id,
                format: v.format,
                text: v.text.clone(),
                material_ids: v.material_ids.clone(),
                accounts: choices.iter().map(|c| c.capability_id).collect(),
                choices,
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
