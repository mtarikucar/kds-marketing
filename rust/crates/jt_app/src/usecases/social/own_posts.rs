//! A connected social account's own posts as its platform published them, whoever posted them
//! and whenever (before the account was connected to Jeeta included): what a content agent
//! learns the account's voice and look from (the brand scan, `docs/operations/brand-scan.md`).
//!
//! - `social.own_posts` (`jeeta.social.own_posts`): one page, newest first, of at most
//!   [`MAX_OWN_POSTS`] posts ([`DEFAULT_OWN_POSTS`] when not asked), each with its platform id,
//!   permalink, kind, caption, time and the counters its platform gives; the page names every
//!   counter it lacks and why, never a zero for one. Instagram and TikTok list; another kind is
//!   `CONFLICT` `own_posts_not_supported`.
//! - `social.own_post_image` (`jeeta.social.own_post_image`): the image of one of those posts
//!   (a carousel's item by `index`, a video's cover), read from the platform now, so an agent can
//!   look at it: a platform's own image address expires, so none is handed out to be kept.
//!   Instagram only; TikTok is `CONFLICT` `own_post_image_not_supported`. A post the adapter finds
//!   is not the connected account's (its owner is none of the account's ids, nor its username the
//!   account's) is `CONFLICT` `post_not_the_accounts`, details saying what was compared, no id.
//!
//! Both read on demand and store nothing: no caption, image or counter is kept, ledgered or
//! logged. The account is checked as every connector read is (`chain::capability_access`): a
//! capability that is not verified, needs reconnecting or whose access expired is refused
//! (`CONFLICT` with the reason); a grant without the read scope still lists, without the
//! counters that need it (`unavailable` says `permission_not_granted`). A provider's refusal is
//! the connector's error mapping (`connector::provider_error`): a dead login is `VALIDATION`
//! with `provider_error: auth`, a throttle `UPSTREAM_UNAVAILABLE` with `retry_after_s`.

use std::collections::BTreeMap;

use base64::Engine as _;
use jt_capability::{Capability, CapabilityId, StoredStatus};
use jt_connector::provider_for_kind;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use url::Url;

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::connectors::{
    InsightsReader, OwnPost, OwnPostKind, OwnPostsQuery, PostImage, Unavailable,
};
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::connector::{adapter_public, open_credential, provider_error};
use crate::usecases::studio::chain::{self, ORGANIC_KINDS, SCOPE_MISSING, refuse};

/// The posts one page holds when none is asked for.
pub const DEFAULT_OWN_POSTS: u32 = 30;
/// The most posts one page holds.
pub const MAX_OWN_POSTS: u32 = 50;
/// The longest cursor taken, in characters.
pub const MAX_CURSOR_CHARS: usize = 512;
/// The largest image read, in bytes (an Instagram image is well under it).
pub const MAX_OWN_POST_IMAGE_BYTES: usize = 5 << 20;
/// The longest caption returned, in characters (Instagram's own limit is 2,200); a longer one is
/// cut on a character boundary and says so (`caption_truncated`).
pub const MAX_CAPTION_CHARS: usize = 2_200;
/// The last item index of a carousel (Instagram holds at most 20).
pub const MAX_ITEM_INDEX: u32 = 19;

/// Who may read an account's own posts: `social.work`, as every other `social.*` read (the
/// accounts are listed with `jeeta.social.accounts_list`, which needs it too).
pub const OWN_POSTS_PERMISSIONS: &[Permission] = &[Permission::SocialWork];

/// `social.own_posts`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnPostsInput {
    pub capability_id: CapabilityId,
    /// 1 to [`MAX_OWN_POSTS`]; [`DEFAULT_OWN_POSTS`] when left out.
    #[serde(default)]
    pub limit: Option<u32>,
    /// A page's `next_cursor`, for the page after it.
    #[serde(default)]
    pub cursor: Option<String>,
}

/// A post's counters; one its platform does not give is `null`, never zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct OwnPostNumbers {
    pub likes: Option<i64>,
    pub comments: Option<i64>,
    pub reach: Option<i64>,
    pub saves: Option<i64>,
    pub shares: Option<i64>,
    /// Plays of a video.
    pub views: Option<i64>,
}

/// One of the account's own posts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OwnPostOut {
    /// The platform's id: `post_id` of `social.own_post_image`.
    pub post_id: String,
    /// Its public page; quote it as the post's source.
    pub permalink: Option<Url>,
    pub kind: OwnPostKind,
    pub caption: Option<String>,
    /// Whether `caption` was cut at [`MAX_CAPTION_CHARS`].
    pub caption_truncated: bool,
    #[serde(with = "jt_studio::time_compat::option")]
    pub published_at: Option<OffsetDateTime>,
    /// A carousel's number of images or videos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<u32>,
    pub numbers: OwnPostNumbers,
}

/// One page of the account's own posts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OwnPostsOut {
    pub capability_id: CapabilityId,
    /// The account's kind, e.g. `instagram`.
    pub kind: String,
    pub posts: Vec<OwnPostOut>,
    /// The `cursor` of the next page; `null` on the last.
    pub next_cursor: Option<String>,
    /// Each counter no post of the page carries, and why: `permission_not_granted` (the grant
    /// lacks the permission that reads it; a reconnection asks for it) or `not_given` (the
    /// platform gives none for these posts).
    pub unavailable: BTreeMap<String, Unavailable>,
}

/// `social.own_post_image`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnPostImageInput {
    pub capability_id: CapabilityId,
    /// A `post_id` of `social.own_posts`.
    pub post_id: String,
    /// A carousel's item, from 0; 0 (the post itself) when left out.
    #[serde(default)]
    pub index: u32,
}

/// The image of one of the account's own posts, in memory.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct OwnPostImage {
    pub capability_id: CapabilityId,
    pub post_id: String,
    pub index: u32,
    /// `image/jpeg`, `image/png`, `image/webp` or `image/gif`.
    pub mime_type: String,
    pub bytes: usize,
    /// The image, base64 (standard alphabet, padded). The MCP tool hands it over as image
    /// content instead.
    pub data: String,
}

impl std::fmt::Debug for OwnPostImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnPostImage")
            .field("capability_id", &self.capability_id)
            .field("post_id", &self.post_id)
            .field("index", &self.index)
            .field("mime_type", &self.mime_type)
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field": field, "reason": reason}))
}

/// What a read needs, gathered with the tenant's transaction closed before the provider is
/// called: the account, its reader, its credential, and whether its grant reads insights.
struct Account {
    capability: Capability,
    reader: std::sync::Arc<dyn InsightsReader>,
    credential: jt_connector::Credential,
    insights: bool,
}

/// The workspace's social account `id` (see the module docs), refused as the connector's other
/// reads refuse it.
async fn account(
    d: &Deps,
    ctx: &Ctx,
    id: CapabilityId,
    refusal: &str,
) -> Result<Account, AppError> {
    ctx.require_any(OWN_POSTS_PERMISSIONS)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    let capability = social_account(r.as_mut(), id).await?;
    let reader = provider_for_kind(&capability.kind_key)
        .and_then(|p| d.connectors.insights(p))
        .ok_or_else(|| refuse(refusal))?;
    let insights = match chain::capability_access(&capability, ctx.now, false) {
        Ok(()) => true,
        Err(e) if e.details["reason"] == SCOPE_MISSING => false,
        Err(e) => return Err(e),
    };
    let sealed = r
        .capabilities()
        .read_sealed(capability.id)
        .await?
        .ok_or_else(|| refuse("capability_unavailable"))?;
    drop(r);
    let credential = open_credential(d, ctx.workspace_id, &sealed)?;
    Ok(Account {
        capability,
        reader,
        credential,
        insights,
    })
}

/// The live social account `id` of the workspace: a capability of a kind posts go out on, not
/// retired; `NOT_FOUND` otherwise.
async fn social_account(r: &mut dyn TenantRepos, id: CapabilityId) -> Result<Capability, AppError> {
    r.capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .find(|c| {
            c.id == id
                && ORGANIC_KINDS.contains(&c.kind_key.as_str())
                && c.status != StoredStatus::Retired
        })
        .ok_or_else(|| AppError::not_found("social account"))
}

fn numbers(post: &OwnPost) -> OwnPostNumbers {
    let n = |name: &str| post.metrics.get(name).copied();
    OwnPostNumbers {
        likes: n("likes"),
        comments: n("comments"),
        reach: n("reach"),
        saves: n("saves"),
        shares: n("shares"),
        views: n("views"),
    }
}

/// `social.own_posts`: one page of the account's own posts (see the module docs).
pub async fn own_posts(d: &Deps, ctx: &Ctx, i: OwnPostsInput) -> Result<OwnPostsOut, AppError> {
    ctx.require_any(OWN_POSTS_PERMISSIONS)?;
    let limit = i.limit.unwrap_or(DEFAULT_OWN_POSTS);
    if !(1..=MAX_OWN_POSTS).contains(&limit) {
        return Err(invalid("limit", "limit_1_to_50"));
    }
    if let Some(cursor) = &i.cursor
        && (cursor.is_empty() || cursor.chars().count() > MAX_CURSOR_CHARS)
    {
        return Err(invalid("cursor", "not_a_cursor"));
    }
    let a = account(d, ctx, i.capability_id, "own_posts_not_supported").await?;
    let provider = provider_for_kind(&a.capability.kind_key);
    let query = OwnPostsQuery {
        limit,
        cursor: i.cursor,
        insights: a.insights,
    };
    let page = a
        .reader
        .own_posts(&a.credential, &adapter_public(&a.capability), &query)
        .await
        .map_err(|e| match provider {
            Some(p) => provider_error(p, e),
            None => AppError::internal("a reader without a provider"),
        })?
        .ok_or_else(|| refuse("own_posts_not_supported"))?;
    Ok(OwnPostsOut {
        capability_id: a.capability.id,
        kind: a.capability.kind_key.clone(),
        posts: page
            .posts
            .iter()
            .map(|p| OwnPostOut {
                post_id: p.id.clone(),
                permalink: p.permalink.clone(),
                kind: p.kind,
                caption: p
                    .caption
                    .as_deref()
                    .map(|c| c.chars().take(MAX_CAPTION_CHARS).collect()),
                caption_truncated: p
                    .caption
                    .as_deref()
                    .is_some_and(|c| c.chars().count() > MAX_CAPTION_CHARS),
                published_at: p.published_at,
                items: p.items,
                numbers: numbers(p),
            })
            .collect(),
        next_cursor: page.next_cursor,
        unavailable: page.unavailable,
    })
}

/// `social.own_post_image`: the image of one of the account's own posts (see the module docs).
pub async fn own_post_image(
    d: &Deps,
    ctx: &Ctx,
    i: OwnPostImageInput,
) -> Result<OwnPostImage, AppError> {
    ctx.require_any(OWN_POSTS_PERMISSIONS)?;
    let post_id = i.post_id.trim();
    if post_id.is_empty()
        || post_id.len() > 128
        || !post_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid("post_id", "not_a_post_id"));
    }
    if i.index > MAX_ITEM_INDEX {
        return Err(invalid("index", "index_0_to_19"));
    }
    let a = account(d, ctx, i.capability_id, "own_post_image_not_supported").await?;
    let provider = provider_for_kind(&a.capability.kind_key);
    let media = a
        .reader
        .own_post_image(
            &a.credential,
            &adapter_public(&a.capability),
            post_id,
            i.index,
            MAX_OWN_POST_IMAGE_BYTES,
        )
        .await
        .map_err(|e| match provider {
            Some(p) => provider_error(p, e),
            None => AppError::internal("a reader without a provider"),
        })?
        .ok_or_else(|| refuse("own_post_image_not_supported"))?;
    let media = match media {
        PostImage::Image(media) => media,
        // Jeeta's own check refused it, not the platform: say what was compared, never an id.
        PostImage::NotTheAccounts(check) => {
            return Err(AppError {
                code: ErrorCode::Conflict,
                message: "the post is not the connected account's own".into(),
                details: json!({
                    "reason": "post_not_the_accounts",
                    "matched": "none",
                    "owner_id_present": check.owner_id_present,
                    "username_present": check.username_present,
                    "account_ids_compared": check.account_ids,
                    "account_username_present": check.account_username_present,
                    "identity_read": check.identity_read,
                }),
            });
        }
    };
    if !matches!(
        media.mime.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return Err(refuse("not_an_image"));
    }
    Ok(OwnPostImage {
        capability_id: a.capability.id,
        post_id: post_id.to_owned(),
        index: i.index,
        bytes: media.data.len(),
        data: base64::engine::general_purpose::STANDARD.encode(&media.data),
        mime_type: media.mime,
    })
}
