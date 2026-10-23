//! Organic counters of posts and accounts.
//!
//! - Facebook post: `GET /{post}/insights?metric=…` ([`FACEBOOK_POST_METRICS`]);
//! - Facebook Page: `GET /{page}?fields=followers_count,fan_count`;
//! - Instagram media: `GET /{media}/insights?metric=…` ([`INSTAGRAM_MEDIA_METRICS`]);
//! - Instagram account: `GET /{ig}?fields=followers_count,follows_count,media_count`.
//!
//! Instagram goes through the Graph API with a Page token, or `graph.instagram.com` with an
//! Instagram Login token. Counters are kept under the provider's own names; a metric whose value
//! is not a whole number (Meta answers some with objects) is left out. Meta retires metrics from
//! time to time (2025-04, 2025-11 and 2026-06 so far): the lists below are where to follow it.

use std::fmt;

use jt_app::ports::connectors::{AccountMetrics, PostMetrics};
use jt_connector::{ConnectorError, Credential};
use serde_json::Value;

use crate::credential::{MetaCred, account_of, kind_of};
use crate::graph::{integer, node};
use crate::{Masked, MetaConnector};

/// The metrics read for a Facebook post.
pub(crate) const FACEBOOK_POST_METRICS: &str =
    "post_impressions_unique,post_reactions_like_total,post_clicks";

/// The metrics read for an Instagram media.
pub(crate) const INSTAGRAM_MEDIA_METRICS: &str =
    "reach,likes,comments,saved,shares,total_interactions";

/// The fields read for a Facebook Page.
const FACEBOOK_PAGE_FIELDS: &str = "followers_count,fan_count";

/// The fields read for an Instagram account.
const INSTAGRAM_ACCOUNT_FIELDS: &str = "followers_count,follows_count,media_count";

/// Where a read goes, with which token. `Debug` masks the token.
enum Reader<'a> {
    Graph(&'a str),
    Instagram(&'a str),
}

impl fmt::Debug for Reader<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reader::Graph(_) => f.debug_tuple("Graph").field(&Masked).finish(),
            Reader::Instagram(_) => f.debug_tuple("Instagram").field(&Masked).finish(),
        }
    }
}

impl Reader<'_> {
    async fn get(
        &self,
        connector: &MetaConnector,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        match self {
            Reader::Graph(token) => {
                let app = connector.graph_app()?;
                connector.graph_get(&app, token, segments, query).await
            }
            Reader::Instagram(token) => connector.instagram_get(token, segments, query).await,
        }
    }
}

/// Whether the capability is an Instagram one, and how to read it: by its kind (never guessed:
/// without a Meta kind, `Permanent` "kind_key missing").
fn reader<'a>(cred: &MetaCred<'a>, public: &Value) -> Result<(bool, Reader<'a>), ConnectorError> {
    match (kind_of(public)?, *cred) {
        ("instagram", MetaCred::Instagram { token }) => Ok((true, Reader::Instagram(token))),
        ("instagram", MetaCred::Page { token, .. } | MetaCred::User { token }) => {
            Ok((true, Reader::Graph(token)))
        }
        ("facebook_page", MetaCred::Page { token, .. } | MetaCred::User { token }) => {
            Ok((false, Reader::Graph(token)))
        }
        _ => Err(ConnectorError::permanent(
            "this capability has no post or account counters",
        )),
    }
}

/// `{name: value}` of an insights answer's `data` (each metric's last whole-number value).
fn metrics_of(answer: &Value) -> PostMetrics {
    let mut out = PostMetrics::default();
    for row in answer["data"].as_array().into_iter().flatten() {
        let Some(name) = row["name"].as_str() else {
            continue;
        };
        let value = row["values"]
            .as_array()
            .and_then(|values| values.last())
            .map(|v| &v["value"])
            .or_else(|| row.get("total_value").map(|t| &t["value"]));
        if let Some(value) = value.and_then(integer) {
            out.metrics.insert(name.to_owned(), value);
        }
    }
    out
}

/// The counters of post `post_id`.
pub(crate) async fn post_metrics(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    post_id: &str,
) -> Result<PostMetrics, ConnectorError> {
    let cred = MetaCred::of(cred, "read counters")?;
    let (instagram, reader) = reader(&cred, public)?;
    let metrics = if instagram {
        INSTAGRAM_MEDIA_METRICS
    } else {
        FACEBOOK_POST_METRICS
    };
    let answer = reader
        .get(
            connector,
            &[node(post_id)?, "insights"],
            &[("metric", metrics)],
        )
        .await?;
    Ok(metrics_of(&answer))
}

/// The counters of the account itself.
pub(crate) async fn account_metrics(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AccountMetrics, ConnectorError> {
    let meta = MetaCred::of(cred, "read counters")?;
    let (instagram, reader) = reader(&meta, public)?;
    let (account, fields) = if instagram {
        (account_of(public).unwrap_or("me"), INSTAGRAM_ACCOUNT_FIELDS)
    } else {
        let page = match meta {
            MetaCred::Page { page_id, .. } => page_id,
            _ => "me",
        };
        (page, FACEBOOK_PAGE_FIELDS)
    };
    let answer = reader
        .get(connector, &[node(account)?], &[("fields", fields)])
        .await?;
    let mut out = AccountMetrics::default();
    for field in fields.split(',') {
        if let Some(value) = integer(&answer[field]) {
            out.metrics.insert(field.to_owned(), value);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_masks_the_token() {
        for reader in [
            Reader::Graph("EAAB-SECRET"),
            Reader::Instagram("IGAA-SECRET"),
        ] {
            let printed = format!("{reader:?}");
            assert!(!printed.contains("SECRET"), "{printed}");
            assert!(printed.contains("***"), "{printed}");
        }
    }
}
