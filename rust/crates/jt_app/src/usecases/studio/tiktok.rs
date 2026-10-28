//! The TikTok posting screen. TikTok's Content Sharing Guidelines
//! (<https://developers.tiktok.com/doc/content-sharing-guidelines>) ask that a post reach TikTok
//! only after a human chose its settings against the account's latest `creator_info` and
//! expressly consented; so a TikTok piece is published only with an approval carrying that
//! choice, whatever the lane's approval policy (`jt_studio::requires_posting_screen`), and
//! `control::approve` refuses it.
//!
//! [`tiktok_posting`] is the screen: the account as TikTok describes it now (read fresh every
//! time), the drafted caption and a preview of the media. [`tiktok_post`] is its publish button:
//! it reads the account fresh again, checks the choice against it (and a video's length against
//! the account's limit, read from the file), then records the approval with the choice. Nothing
//! is sent to TikTok by either: the slot is published when it is due, as chosen
//! (`publish::publish_due`), and its status then reads on the slot (`work::slot_get`). Both are
//! panel-only: the screen is the panel's, and only an owner or manager in person passes it.
//!
//! The screen also shows the account as it stands, read with it and best effort (a read TikTok
//! refuses leaves it out; the screen still works): its counters (`user.info.stats`) and its
//! latest public videos with their counters (`video.list`). Once a slot is published,
//! [`tiktok_metrics`] reads its post's counters live, or, when TikTok cannot be asked, takes the
//! latest measurement's.
use super::{
    chain::{HistoricalTarget, active, capability_access, refuse},
    control::{ApprovalOut, human_approver, hypothesis_live},
    files, measure,
    publish::content,
    work::gated,
};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        connectors::{
            MediaUpload, PublishReceipt, RecentPost, TiktokCreator, TiktokMedia, TiktokPost,
            TiktokPostRefusal,
        },
        studio::{
            ApprovalReceipt, ApprovalTarget, MeasurementStatus, MediaAsset, Piece, Slot, SlotId,
            SlotState,
        },
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure::failure_reason,
        ledger_entry,
    },
};
use jt_capability::Capability;
use jt_connector::{Credential, provider_for_kind};
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use time::{Duration, OffsetDateTime};
use url::Url;

/// One medium of the post, as the screen previews it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreviewMedia {
    /// Where the browser loads it: a stored file's signed URL (the 24-hour URL a provider is
    /// given), or the hosted URL as it is.
    pub url: Url,
    pub mime: String,
}

/// What the posting screen shows.
#[derive(Clone, Debug, Serialize)]
pub struct TiktokPostingOut {
    /// The slot posted, at the revision a choice approves.
    pub slot: Slot,
    /// The account, read from TikTok for this answer.
    pub creator: TiktokCreator,
    /// The drafted caption (the text, then the link after a blank line), for the human to edit.
    pub title: String,
    /// What the post carries. A video's length is not read here: the screen measures it where
    /// it plays, and [`tiktok_post`] from the file.
    pub media: TiktokMedia,
    /// The longest caption it takes, in UTF-16 units.
    pub max_title_units: usize,
    pub previews: Vec<PreviewMedia>,
    /// The approval with the screen's choice, once one was made for this revision.
    pub approval: Option<ApprovalReceipt>,
    /// The account's counters by TikTok's names (`follower_count`, `following_count`,
    /// `likes_count`, `video_count`), read for this answer; `None` when TikTok did not give them.
    pub account_metrics: Option<BTreeMap<String, i64>>,
    /// The account's latest public videos, newest first, at most [`RECENT_POSTS`], with their
    /// counters, read for this answer; `None` when TikTok did not list them.
    pub recent_posts: Option<Vec<RecentPost>>,
}

/// Where a published post's counters came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricsSource {
    /// Read from TikTok for this answer.
    Live,
    /// The latest complete measurement of the post (TikTok could not be asked).
    Measurement,
}

/// A TikTok slot's published post and its counters ([`tiktok_metrics`]).
#[derive(Clone, Debug, Serialize)]
pub struct TiktokMetricsOut {
    /// The post TikTok published for the slot (its id and page); `None` until it is published.
    pub post: Option<PublishReceipt>,
    /// Its counters by TikTok's names (`view_count`, `like_count`, `comment_count`,
    /// `share_count`; a measurement adds the Studio's `impressions` and `engagements`); `None`
    /// when neither TikTok nor a measurement has any (TikTok names no public id, so no counters,
    /// for a post only its creator may see).
    pub metrics: Option<BTreeMap<String, i64>>,
    pub source: Option<MetricsSource>,
    /// When they were read: now, or the measurement's time.
    #[serde(with = "time::serde::rfc3339::option")]
    pub read_at: Option<OffsetDateTime>,
}

/// How many of the account's latest videos the screen lists.
pub const RECENT_POSTS: u32 = 10;

/// The posting screen's publish button: the human's `post` for the slot at `expected_revision`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TiktokPostInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
    pub post: TiktokPost,
}

/// The most photos one TikTok post carries
/// (<https://developers.tiktok.com/doc/content-posting-api-reference-photo-post>).
const MAX_PHOTOS: usize = 35;

/// A TikTok slot as the screen needs it.
struct Screen {
    slot: Slot,
    piece: Piece,
    capability: Capability,
    credential: Credential,
}

/// Slot `id`'s screen: refused unless it is a TikTok slot (`not_a_tiktok_slot`), Ready (at
/// `expected`, when named), and its capability can publish now; its credential opened. The tenant
/// transaction is released before any provider is called.
async fn screen(
    d: &Deps,
    ctx: &Ctx,
    id: SlotId,
    expected: Option<u64>,
) -> Result<Screen, AppError> {
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(r.as_mut(), ctx).await?;
    let slot = r
        .studio()
        .get_slot(id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    let capability = r
        .capabilities()
        .find(slot.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if !jt_studio::requires_posting_screen(&capability.kind_key) {
        return Err(refuse("not_a_tiktok_slot"));
    }
    if slot.state != SlotState::Ready || expected.is_some_and(|e| e != slot.revision) {
        return Err(AppError::conflict("slot revision changed"));
    }
    capability_access(&capability, d.clock.now(), true)?;
    let piece = r
        .studio()
        .get_piece(id, slot.revision)
        .await?
        .ok_or_else(|| AppError::not_found("piece"))?;
    let sealed = r
        .capabilities()
        .read_sealed(capability.id)
        .await?
        .ok_or_else(|| refuse("capability_unavailable"))?;
    let credential = open_credential(d, ctx.workspace_id, &sealed)?;
    Ok(Screen {
        slot,
        piece,
        capability,
        credential,
    })
}

/// The account as TikTok describes it now; `tiktok_creator_info_unavailable` with the provider's
/// failure line when it could not be read.
async fn creator(d: &Deps, s: &Screen) -> Result<TiktokCreator, AppError> {
    let provider = provider_for_kind(&s.capability.kind_key);
    let publisher = provider
        .and_then(|p| d.connectors.publisher(p))
        .ok_or_else(|| refuse("connector_unavailable"))?;
    match publisher
        .creator_info(&s.credential, &adapter_public(&s.capability))
        .await
    {
        Ok(Some(creator)) => Ok(creator),
        Ok(None) => Err(refuse("connector_unavailable")),
        Err(e) => {
            let mut error = refuse("tiktok_creator_info_unavailable");
            error.details["provider_reason"] = json!(failure_reason(provider, &e));
            Err(error)
        }
    }
}

/// The account's counters and its latest videos, each best effort: a read TikTok refuses is left
/// out (and logged by its kind only).
async fn account(d: &Deps, s: &Screen) -> (Option<BTreeMap<String, i64>>, Option<Vec<RecentPost>>) {
    let Some(reader) =
        provider_for_kind(&s.capability.kind_key).and_then(|p| d.connectors.insights(p))
    else {
        return (None, None);
    };
    let public = adapter_public(&s.capability);
    let metrics = match reader.account_metrics(&s.credential, &public).await {
        Ok(m) => Some(m.metrics),
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the TikTok account's counters were not read"
            );
            None
        }
    };
    let posts = match reader
        .recent_posts(&s.credential, &public, RECENT_POSTS)
        .await
    {
        Ok(posts) => posts,
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the TikTok account's videos were not listed"
            );
            None
        }
    };
    (metrics, posts)
}

/// The drafted caption: the text when it has any, and the link on a line of its own after a
/// blank line.
fn caption(text: &str, link: Option<&Url>) -> String {
    match (Some(text).filter(|t| !t.trim().is_empty()), link) {
        (Some(text), Some(link)) => format!("{text}\n\n{link}"),
        (Some(text), None) => text.to_owned(),
        (None, Some(link)) => link.to_string(),
        (None, None) => String::new(),
    }
}

/// Where the browser previews each of `media`, and its type.
async fn previews(
    d: &Deps,
    ws: WorkspaceId,
    media: &[MediaAsset],
) -> Result<Vec<PreviewMedia>, AppError> {
    let mut out = Vec::with_capacity(media.len());
    for m in media {
        out.push(match m {
            MediaAsset::File { id } => {
                let mut r = d.uow.tenant(ws).await?;
                let f = r
                    .studio()
                    .get_file(*id)
                    .await?
                    .filter(|f| f.deleted_at.is_none())
                    .ok_or_else(|| AppError::not_found("file"))?;
                drop(r);
                PreviewMedia {
                    url: d
                        .files
                        .provider_url(ws, *id, d.clock.now() + Duration::hours(24))
                        .await?,
                    mime: f.mime,
                }
            }
            MediaAsset::HostedUrl { url, mime, .. } => PreviewMedia {
                url: url.clone(),
                mime: mime.clone(),
            },
            MediaAsset::Bytes { .. } => return Err(files::invalid()),
        });
    }
    Ok(out)
}

/// What a post of `previews` carries: one MP4 video, or 1 to [`MAX_PHOTOS`] images; else
/// `tiktok_media_unsupported` (TikTok takes nothing else, text alone included).
fn kind(previews: &[PreviewMedia]) -> Result<TiktokMedia, AppError> {
    let video = |m: &PreviewMedia| m.mime.trim().eq_ignore_ascii_case("video/mp4");
    match previews {
        [one] if video(one) => Ok(TiktokMedia::Video { duration_ms: None }),
        photos
            if (1..=MAX_PHOTOS).contains(&photos.len())
                && photos.iter().all(|m| m.mime.trim().starts_with("image/")) =>
        {
            Ok(TiktokMedia::Photos)
        }
        _ => Err(AppError::validation(
            "a TikTok post is one MP4 video or 1 to 35 photos",
            json!({"field":"media","reason":"tiktok_media_unsupported"}),
        )),
    }
}

/// A refused choice: `CONFLICT` for an account that may not post at this moment (try again
/// later), else `VALIDATION`; the stable reason in `details.reason`.
fn refused(e: TiktokPostRefusal) -> AppError {
    let reason = e.reason();
    match e {
        TiktokPostRefusal::CannotPostNow => AppError {
            code: ErrorCode::Conflict,
            message: "the TikTok account cannot post at this moment; try again later".into(),
            details: json!({"reason":reason}),
        },
        _ => AppError::validation(
            format!("the TikTok post cannot be accepted: {reason}"),
            json!({"field":"post","reason":reason}),
        ),
    }
}

/// The posting screen of slot `slot_id` (see the module docs). Requires `studio.manage`.
pub async fn tiktok_posting(
    d: &Deps,
    ctx: &Ctx,
    slot_id: SlotId,
) -> Result<TiktokPostingOut, AppError> {
    ctx.require(Permission::StudioManage)?;
    let s = screen(d, ctx, slot_id, None).await?;
    let (text, media, link, _) = content(&s.piece, &s.capability);
    let previews = previews(d, ctx.workspace_id, media).await?;
    let media = kind(&previews)?;
    let creator = creator(d, &s).await?;
    let (account_metrics, recent_posts) = account(d, &s).await;
    let approval = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        r.studio()
            .get_approval(ApprovalTarget::Slot(s.slot.id), s.slot.revision)
            .await?
            .filter(|a| a.tiktok.is_some())
    };
    Ok(TiktokPostingOut {
        title: caption(text, link),
        max_title_units: media.max_title_units(),
        media,
        previews,
        creator,
        approval,
        account_metrics,
        recent_posts,
        slot: s.slot,
    })
}

/// The counters of TikTok slot `slot_id`'s published post (see the module docs): read live with
/// the post's historical read authority, else the latest complete measurement's; nothing before
/// the slot is published. Requires `studio.work`. A read: it publishes nothing.
pub async fn tiktok_metrics(
    d: &Deps,
    ctx: &Ctx,
    slot_id: SlotId,
) -> Result<TiktokMetricsOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    let none = TiktokMetricsOut {
        post: None,
        metrics: None,
        source: None,
        read_at: None,
    };
    let (publication, measured, access) = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        gated(r.as_mut(), ctx).await?;
        let slot = r
            .studio()
            .get_slot(slot_id)
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        let capability = r
            .capabilities()
            .find(slot.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        if !jt_studio::requires_posting_screen(&capability.kind_key) {
            return Err(refuse("not_a_tiktok_slot"));
        }
        let Some(publication) = r
            .studio()
            .list_publications()
            .await?
            .into_iter()
            .filter(|p| p.slot_id == slot.id)
            .max_by_key(|p| p.published_at)
        else {
            return Ok(none);
        };
        let measured = r
            .studio()
            .list_measurements()
            .await?
            .into_iter()
            .filter(|m| {
                m.publication_id == Some(publication.id) && m.status == MeasurementStatus::Complete
            })
            .max_by_key(|m| m.measured_at);
        // The post's own read authority, as the measurement job reads it; without it (the
        // account changed or lost access) only a measurement can stand in.
        let access = measure::access(d, r.as_mut(), HistoricalTarget::Publication(publication.id))
            .await
            .ok();
        (publication, measured, access)
    };
    let post = PublishReceipt {
        external_id: publication.external_id.clone(),
        url: publication.url.clone(),
    };
    if let Some((capability, credential)) = access
        && let Some(reader) =
            provider_for_kind(&capability.kind_key).and_then(|p| d.connectors.insights(p))
    {
        match reader
            .post_metrics(&credential, &adapter_public(&capability), &post.external_id)
            .await
        {
            Ok(live) if !live.metrics.is_empty() => {
                return Ok(TiktokMetricsOut {
                    post: Some(post),
                    metrics: Some(live.metrics),
                    source: Some(MetricsSource::Live),
                    read_at: Some(d.clock.now()),
                });
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    error_kind = e.kind(),
                    "a TikTok post's counters were not read"
                );
            }
        }
    }
    let Some(m) = measured else {
        return Ok(TiktokMetricsOut {
            post: Some(post),
            ..none
        });
    };
    let metrics: BTreeMap<String, i64> = m
        .raw_metrics
        .into_iter()
        .filter_map(|(k, v)| v.map(|v| (k, v)))
        .collect();
    Ok(TiktokMetricsOut {
        post: Some(post),
        source: (!metrics.is_empty()).then_some(MetricsSource::Measurement),
        read_at: (!metrics.is_empty()).then_some(m.measured_at),
        metrics: (!metrics.is_empty()).then_some(metrics),
    })
}

/// The posting screen's publish button (see the module docs): an owner or manager in person, for
/// a Ready TikTok slot at `expected_revision`. Passing the screen again replaces the choice.
pub async fn tiktok_post(
    d: &Deps,
    ctx: &Ctx,
    input: TiktokPostInput,
) -> Result<ApprovalOut, AppError> {
    let user_id = human_approver(ctx)?;
    let s = screen(d, ctx, input.slot_id, Some(input.expected_revision)).await?;
    let (_, media, _, _) = content(&s.piece, &s.capability);
    let mut kind = kind(&previews(d, ctx.workspace_id, media).await?)?;
    if let TiktokMedia::Video { duration_ms } = &mut kind {
        let (_, bytes) =
            files::resolve_media(d, ctx.workspace_id, media, &s.capability.kind_key).await?;
        *duration_ms = bytes.first().and_then(MediaUpload::video_duration_ms);
    }
    let creator = creator(d, &s).await?;
    input.post.check(&creator, &kind).map_err(refused)?;

    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = r
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(AppError::strategy_required)?;
    active(r.as_mut()).await?;
    r.studio_control().lock_control().await?;
    let slot = r
        .studio()
        .get_slot(input.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    let capability = r
        .capabilities()
        .find(slot.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    if slot.chain != s.slot.chain
        || capability.kind_key != s.capability.kind_key
        || capability.external_id != s.capability.external_id
    {
        return Err(refuse("capability_changed"));
    }
    hypothesis_live(r.as_mut(), frame.id, &slot.chain).await?;
    let receipt = ApprovalReceipt {
        revision: input.expected_revision,
        by: user_id,
        at: ctx.now,
        tiktok: Some(input.post.clone()),
    };
    if !receipt.approves(input.expected_revision) {
        return Err(refuse("invalid_approval_revision"));
    }
    // Ready at the expected revision, checked again under the control lock.
    r.studio()
        .approve_target(ApprovalTarget::Slot(slot.id), receipt.clone())
        .await?;
    let out = ApprovalOut {
        target: ApprovalTarget::Slot(slot.id),
        revision: input.expected_revision,
        approval: receipt,
    };
    let post = &input.post;
    let mut e = ledger_entry(
        ctx,
        "studio.tiktok_post",
        "studio_approval",
        slot.chain.arm_id,
        json!({
            "target": out.target,
            "revision": out.revision,
            "born_version_id": slot.chain.born_version_id,
            "executed_version_id": frame.id,
            "takeover": true,
            "tiktok": {
                "privacy_level": post.privacy_level,
                "allow_comment": post.allow_comment,
                "allow_duet": post.allow_duet,
                "allow_stitch": post.allow_stitch,
                "disclose_commercial": post.disclose_commercial,
                "your_brand": post.your_brand,
                "branded_content": post.branded_content,
            },
        }),
    )?;
    e.strategy_version_id = Some(frame.id.0);
    r.ledger().append(e).await?;
    r.commit().await?;
    Ok(out)
}
