//! An Instagram account's own posts as Instagram published them, whoever posted them and when
//! (before the account was connected included), read on demand and never stored:
//!
//! - the list: `GET /{ig}/media?fields=…&limit&after` ([`MEDIA_FIELDS`], and with the insights
//!   permission [`MEDIA_INSIGHTS`] as a field expansion, so one call reads a page and its
//!   counters);
//! - one post's image: `GET /{media}?fields=media_type,media_url,thumbnail_url,children{…}`, then
//!   the image itself from Meta's media CDN (`*.cdninstagram.com`, `*.fbcdn.net`), without a
//!   token (its addresses are signed and expire, which is why it is read again each time).
//!
//! Instagram goes through the Graph API with a Page token, or `graph.instagram.com` with an
//! Instagram Login token, as every other Instagram read. A Facebook Page (or another kind) lists
//! nothing here (`None`).
//!
//! **Counters.** `like_count` and `comments_count` come with the post (the basic permission);
//! `reach`, `saved`, `shares` and `views` need the insights permission. A page read without it,
//! or whose insights Meta refuses (`Permission`, or `Permanent` for a metric it does not give for
//! these posts, as it does for posts made before the account became a professional one), is read
//! again without them, and the page says which counters it lacks and why
//! ([`OwnPostsPage::unavailable`]): a missing counter is never a zero.

use std::collections::BTreeMap;

use jt_app::ports::connectors::{
    Media, OWN_POST_METRICS, OwnPost, OwnPostKind, OwnPostsPage, OwnPostsQuery, Unavailable,
};
use jt_connector::{ConnectorError, Credential};
use serde_json::Value;
use url::Url;

use crate::MetaConnector;
use crate::comments::graph_time;
use crate::credential::{MetaCred, account_of, kind_of};
use crate::graph::{integer, missing, node, text};
use crate::insights::metrics_of;

/// The fields every listed post is read with.
pub(crate) const MEDIA_FIELDS: &str = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,children{id}";

/// The insights metrics asked for with the list, as a field expansion.
pub(crate) const MEDIA_INSIGHTS: &str = "insights.metric(reach,saved,shares,views)";

/// The same without `views`, which Meta does not give for every post: the second try.
pub(crate) const MEDIA_INSIGHTS_NO_VIEWS: &str = "insights.metric(reach,saved,shares)";

/// The fields one post's image is found with.
pub(crate) const IMAGE_FIELDS: &str =
    "media_type,media_url,thumbnail_url,children{media_type,media_url,thumbnail_url}";

/// The most posts one page asks for (Graph's own maximum for media is higher).
pub const MAX_OWN_POSTS_PAGE: u32 = 50;

/// The insights metrics, by Meta's name, and the port's name for each.
const INSIGHT_NAMES: &[(&str, &str)] = &[
    ("reach", "reach"),
    ("saved", "saves"),
    ("shares", "shares"),
    ("views", "views"),
    ("plays", "views"),
];

/// The port's counters that only the insights read gives.
const INSIGHT_METRICS: &[&str] = &["reach", "saves", "shares", "views"];

/// Where a read goes, with which token.
#[derive(Clone, Copy)]
enum Via<'a> {
    Graph(&'a str),
    Instagram(&'a str),
}

impl Via<'_> {
    async fn get(
        &self,
        connector: &MetaConnector,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        match self {
            Via::Graph(token) => {
                let app = connector.graph_app()?;
                connector.graph_get(&app, token, segments, query).await
            }
            Via::Instagram(token) => connector.instagram_get(token, segments, query).await,
        }
    }
}

/// How an Instagram capability is read; `None` for another kind.
fn via<'a>(cred: &'a Credential, public: &Value) -> Result<Option<Via<'a>>, ConnectorError> {
    if kind_of(public)? != "instagram" {
        return Ok(None);
    }
    match MetaCred::of(cred, "list an account's posts")? {
        MetaCred::Instagram { token } => Ok(Some(Via::Instagram(token))),
        MetaCred::Page { token, .. } | MetaCred::User { token } => Ok(Some(Via::Graph(token))),
        MetaCred::WhatsApp { .. } => Err(ConnectorError::permanent(
            "a WhatsApp credential cannot list an account's posts on Meta",
        )),
    }
}

/// Whether `cursor` is one Graph could have given: 1 to 512 characters of the URL-safe base64
/// alphabet (and `=`), so nothing else ever reaches the query.
fn valid_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 512
        && cursor
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=' | b'.'))
}

/// What a listed post is: a carousel, a reel (a video Instagram shows as a reel), a video or an
/// image; `None` for a kind this port does not name.
fn kind(item: &Value) -> Option<OwnPostKind> {
    match item["media_type"].as_str()? {
        "IMAGE" => Some(OwnPostKind::Image),
        "CAROUSEL_ALBUM" => Some(OwnPostKind::Carousel),
        "VIDEO" if item["media_product_type"].as_str() == Some("REELS") => Some(OwnPostKind::Reel),
        "VIDEO" => Some(OwnPostKind::Video),
        _ => None,
    }
}

/// One listed post, or `None` without an id or a known kind.
fn post(item: &Value) -> Option<OwnPost> {
    let id = text(&item["id"]).filter(|id| node(id).is_ok())?;
    let kind = kind(item)?;
    let mut metrics = BTreeMap::new();
    for (field, name) in [("like_count", "likes"), ("comments_count", "comments")] {
        if let Some(value) = integer(&item[field]) {
            metrics.insert(name.to_owned(), value);
        }
    }
    if let Some(insights) = item.get("insights") {
        for (meta, value) in metrics_of(insights).metrics {
            if let Some((_, name)) = INSIGHT_NAMES.iter().find(|(m, _)| *m == meta) {
                metrics.entry((*name).to_owned()).or_insert(value);
            }
        }
    }
    Some(OwnPost {
        id,
        permalink: item["permalink"]
            .as_str()
            .and_then(|p| Url::parse(p).ok())
            .filter(|u| u.scheme() == "https"),
        kind,
        caption: item["caption"]
            .as_str()
            .filter(|c| !c.trim().is_empty())
            .map(str::to_owned),
        published_at: graph_time(&item["timestamp"]),
        items: (kind == OwnPostKind::Carousel)
            .then(|| item["children"]["data"].as_array().map(|c| c.len() as u32))
            .flatten(),
        metrics,
    })
}

/// One page of the account's own posts (see the module docs); `None` for a kind that is not
/// Instagram.
pub(crate) async fn own_posts(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    query: &OwnPostsQuery,
) -> Result<Option<OwnPostsPage>, ConnectorError> {
    let Some(via) = via(cred, public)? else {
        return Ok(None);
    };
    let account = node(account_of(public).unwrap_or("me"))?;
    let limit = query.limit.clamp(1, MAX_OWN_POSTS_PAGE).to_string();
    if let Some(cursor) = &query.cursor
        && !valid_cursor(cursor)
    {
        return Err(ConnectorError::permanent("not a valid page cursor"));
    }
    // The tries, best first: with every counter, without views, without insights.
    let tries: &[Option<&str>] = if query.insights {
        &[Some(MEDIA_INSIGHTS), Some(MEDIA_INSIGHTS_NO_VIEWS), None]
    } else {
        &[None]
    };
    // Whether Meta refused the insights for the permission (then no other insights read is
    // tried), rather than for a metric.
    let mut refused_by = None;
    let mut last_error = None;
    for expansion in tries {
        if expansion.is_some() && refused_by == Some(true) {
            continue;
        }
        let fields = match expansion {
            Some(insights) => format!("{MEDIA_FIELDS},{insights}"),
            None => MEDIA_FIELDS.to_owned(),
        };
        let mut params: Vec<(&str, &str)> = vec![("fields", &fields), ("limit", &limit)];
        if let Some(cursor) = &query.cursor {
            params.push(("after", cursor));
        }
        let answer = match via.get(connector, &[account, "media"], &params).await {
            Ok(answer) => answer,
            Err(e @ (ConnectorError::Permission { .. } | ConnectorError::Permanent { .. }))
                if expansion.is_some() =>
            {
                let permission = matches!(e, ConnectorError::Permission { .. });
                refused_by = Some(refused_by == Some(true) || permission);
                last_error = Some(e);
                continue;
            }
            Err(e) => return Err(e),
        };
        let data = answer["data"]
            .as_array()
            .ok_or_else(|| missing("media list"))?;
        let posts: Vec<OwnPost> = data.iter().filter_map(post).collect();
        let next_cursor = answer["paging"]["next"]
            .as_str()
            .and_then(|_| text(&answer["paging"]["cursors"]["after"]))
            .filter(|c| valid_cursor(c));
        let insights_reason = match (query.insights, expansion, refused_by) {
            (false, _, _) => Some(Unavailable::PermissionNotGranted),
            (true, None, Some(true)) => Some(Unavailable::PermissionNotGranted),
            (true, None, _) => Some(Unavailable::NotGiven),
            (true, Some(_), _) => None,
        };
        let mut unavailable = BTreeMap::new();
        for name in OWN_POST_METRICS {
            let insight = INSIGHT_METRICS.contains(name);
            if insight && let Some(reason) = insights_reason {
                unavailable.insert((*name).to_owned(), reason);
            } else if !posts.is_empty() && posts.iter().all(|p| !p.metrics.contains_key(*name)) {
                unavailable.insert((*name).to_owned(), Unavailable::NotGiven);
            }
        }
        return Ok(Some(OwnPostsPage {
            posts,
            next_cursor,
            unavailable,
        }));
    }
    Err(last_error.unwrap_or_else(|| missing("media list")))
}

/// The address of the image of `item` (a post or a carousel's item): an image's own, a video's
/// cover. Where it may lead is the egress allowlist's to say (`https` to Meta's hosts only).
fn image_url(item: &Value) -> Option<Url> {
    let field = match item["media_type"].as_str()? {
        "IMAGE" => "media_url",
        "VIDEO" => "thumbnail_url",
        _ => return None,
    };
    item[field].as_str().and_then(|u| Url::parse(u).ok())
}

/// Whether `data` starts as a JPEG, PNG, WebP or GIF does, and its type.
pub(crate) fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

/// The image of post `post_id` (of a carousel, item `index`), read now (see the module docs);
/// `None` for a kind that is not Instagram.
pub(crate) async fn own_post_image(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    post_id: &str,
    index: u32,
    max_bytes: usize,
) -> Result<Option<Media>, ConnectorError> {
    let Some(via) = via(cred, public)? else {
        return Ok(None);
    };
    let answer = via
        .get(connector, &[node(post_id)?], &[("fields", IMAGE_FIELDS)])
        .await?;
    let item = if answer["media_type"].as_str() == Some("CAROUSEL_ALBUM") {
        answer["children"]["data"]
            .as_array()
            .and_then(|children| children.get(index as usize))
            .ok_or_else(|| ConnectorError::permanent("the carousel has no item of that index"))?
    } else if index == 0 {
        &answer
    } else {
        return Err(ConnectorError::permanent(
            "only a carousel has items past the first",
        ));
    };
    let url = image_url(item).ok_or_else(|| ConnectorError::permanent("the post has no image"))?;
    let (_, data) = connector.download(url, None, max_bytes).await?;
    let mime = sniff_image(&data)
        .ok_or_else(|| ConnectorError::permanent("the post's image is not an image"))?;
    Ok(Some(Media {
        mime: mime.to_owned(),
        data,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cursors_are_graph_shaped_or_refused() {
        assert!(valid_cursor("QVFIUmFh-_b3c="));
        for bad in ["", "a b", "a&b=c", "a/b", &"x".repeat(513)] {
            assert!(!valid_cursor(bad), "{bad:?}");
        }
    }

    #[test]
    fn kinds_follow_media_type_and_product() {
        let k = |t: &str, p: &str| kind(&json!({"media_type": t, "media_product_type": p}));
        assert_eq!(k("IMAGE", "FEED"), Some(OwnPostKind::Image));
        assert_eq!(k("CAROUSEL_ALBUM", "FEED"), Some(OwnPostKind::Carousel));
        assert_eq!(k("VIDEO", "REELS"), Some(OwnPostKind::Reel));
        assert_eq!(k("VIDEO", "FEED"), Some(OwnPostKind::Video));
        assert_eq!(k("STORY", "STORY"), None);
    }

    #[test]
    fn images_are_sniffed_by_their_bytes() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<html>"), None);
    }
}
