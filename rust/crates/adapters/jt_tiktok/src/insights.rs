//! Public counters of posts (`POST /v2/video/query/`,
//! <https://developers.tiktok.com/doc/tiktok-api-v2-video-query>, scope `video.list`) and of the
//! account (`GET /v2/user/info/`, scope `user.info.stats`); see the crate docs, "Counters".

use std::collections::BTreeMap;

use jt_app::ports::connectors::{AccountMetrics, PostMetrics};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};

use crate::TiktokConnector;
use crate::account::user_info;
use crate::client::{Auth, Body, Effect, Endpoint, missing, text};
use crate::credential::{kind_of, token_of};
use crate::publish::video_id;

/// A post's counters, by TikTok's names.
const POST_METRICS: &[&str] = &["like_count", "comment_count", "share_count", "view_count"];

/// The account's counters, by TikTok's names.
const ACCOUNT_METRICS: &[&str] = &[
    "follower_count",
    "following_count",
    "likes_count",
    "video_count",
];

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
