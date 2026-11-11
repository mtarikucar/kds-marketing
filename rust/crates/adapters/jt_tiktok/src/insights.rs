//! Public counters of posts (`POST /v2/video/query/`,
//! <https://developers.tiktok.com/doc/tiktok-api-v2-video-query>, scope `video.list`), of the
//! account (`GET /v2/user/info/`, scope `user.info.stats`), and the account's recent public
//! videos (`POST /v2/video/list/`, <https://developers.tiktok.com/doc/tiktok-api-v2-video-list>,
//! scope `video.list`); see the crate docs, "Counters".

use std::collections::BTreeMap;

use jt_app::ports::connectors::{AccountMetrics, PostMetrics, RecentPost};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::OffsetDateTime;
use url::Url;

use crate::account::user_info;
use crate::client::{Auth, Body, Effect, Endpoint, missing, text, words};
use crate::credential::{kind_of, token_of};
use crate::publish::video_id;
use crate::{MAX_LISTED_VIDEOS, TiktokConnector};

/// A post's counters, by TikTok's names.
const POST_METRICS: &[&str] = &["like_count", "comment_count", "share_count", "view_count"];

/// The account's counters, by TikTok's names.
const ACCOUNT_METRICS: &[&str] = &[
    "follower_count",
    "following_count",
    "likes_count",
    "video_count",
];

/// The fields a listed video is read with, before its counters: its id, title and description
/// (the title when it has none), cover, page and posting time
/// (<https://developers.tiktok.com/doc/tiktok-api-v2-video-object>).
const LISTED_FIELDS: &[&str] = &[
    "id",
    "title",
    "video_description",
    "cover_image_url",
    "share_url",
    "create_time",
];

/// The longest title kept, in characters (TikTok's are at most 150).
const MAX_LISTED_TITLE_CHARS: usize = 150;

/// The whole-number fields `names` of `object`; `Permanent` (`what`) when it has none of them.
fn counters(
    object: &Value,
    names: &[&str],
    what: &str,
) -> Result<BTreeMap<String, i64>, ConnectorError> {
    let metrics: BTreeMap<String, i64> = names
        .iter()
        .filter_map(|name| object[*name].as_i64().map(|v| ((*name).to_owned(), v)))
        .collect();
    if metrics.is_empty() {
        return Err(missing(what));
    }
    Ok(metrics)
}

/// The counters of the video `post` (its id): the one of `data.videos` with that id.
pub(crate) async fn post_metrics(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    post: &str,
) -> Result<PostMetrics, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read counters")?;
    let id = video_id(post.trim())?;
    let fields = format!("id,{}", POST_METRICS.join(","));
    let url = connector.api_url(&["v2", "video", "query", ""], &[("fields", &fields)]);
    // A query: it changes nothing, so it is a read.
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(json!({ "filters": { "video_ids": [id] } })),
            Endpoint::Api,
            Effect::Read,
        )
        .await?;
    let video = answer["data"]["videos"]
        .as_array()
        .and_then(|videos| {
            videos
                .iter()
                .find(|v| text(&v["id"]).as_deref() == Some(id))
        })
        .ok_or_else(|| {
            ConnectorError::permanent("TikTok names no video of this account with that id")
        })?;
    Ok(PostMetrics {
        metrics: counters(video, POST_METRICS, "video counters")?,
    })
}

/// An https URL of `value`, for the browser (an image's or a page's); `None` for another.
fn https(value: &Value) -> Option<Url> {
    words(value)
        .and_then(|u| Url::parse(u).ok())
        .filter(|u| u.scheme() == "https")
}

/// One listed video, or `None` without a video id.
fn listed(video: &Value) -> Option<RecentPost> {
    let id = text(&video["id"]).filter(|id| video_id(id).is_ok())?;
    let title = words(&video["title"])
        .or_else(|| words(&video["video_description"]))
        .map(|t| t.chars().take(MAX_LISTED_TITLE_CHARS).collect());
    Some(RecentPost {
        id,
        title,
        cover_image_url: https(&video["cover_image_url"]),
        share_url: https(&video["share_url"]),
        created_at: video["create_time"]
            .as_i64()
            .and_then(|s| OffsetDateTime::from_unix_timestamp(s).ok()),
        metrics: POST_METRICS
            .iter()
            .filter_map(|name| video[*name].as_i64().map(|v| ((*name).to_owned(), v)))
            .collect(),
    })
}

/// The account's most recent public videos, newest first: one page of
/// `POST /v2/video/list/ {max_count}`, `limit` kept within 1 to [`MAX_LISTED_VIDEOS`]; a query, so
/// a read. A video without a video id is left out.
pub(crate) async fn recent_posts(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    limit: u32,
) -> Result<Vec<RecentPost>, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "list videos")?;
    let fields = [LISTED_FIELDS, POST_METRICS].concat().join(",");
    let url = connector.api_url(&["v2", "video", "list", ""], &[("fields", &fields)]);
    let max_count = limit.clamp(1, MAX_LISTED_VIDEOS);
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(json!({ "max_count": max_count })),
            Endpoint::Api,
            Effect::Read,
        )
        .await?;
    let videos = answer["data"]["videos"]
        .as_array()
        .ok_or_else(|| missing("video list"))?;
    Ok(videos.iter().filter_map(listed).collect())
}

/// The counters of the account itself.
pub(crate) async fn account_metrics(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AccountMetrics, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read counters")?;
    let user = user_info(connector, token, &ACCOUNT_METRICS.join(",")).await?;
    Ok(AccountMetrics {
        metrics: counters(&user, ACCOUNT_METRICS, "account counters")?,
    })
}
