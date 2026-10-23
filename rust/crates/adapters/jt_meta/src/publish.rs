//! Publishing: Facebook Page posts and Instagram media.
//!
//! - **Facebook** (`facebook_page`, with a Page token): text (and link) only →
//!   `POST /{page}/feed {message, link}`; one image → `POST /{page}/photos {url, caption}`; 2 to
//!   10 images → each `POST /{page}/photos {url, published: false}`, then
//!   `POST /{page}/feed {message, attached_media: [{media_fbid}]}`; one video →
//!   `POST /{page}/videos {file_url, description}` (Meta fetches the file; no resumable upload in
//!   M1b). A video goes alone. With media, a link is appended to the text.
//! - **Instagram** (`instagram`): a container per post (`POST /{ig}/media`: an image
//!   `{image_url, caption}`, a video as a reel `{media_type: REELS, video_url, caption}`, or 2 to
//!   10 items as a carousel of child containers), read until its `status_code` is `FINISHED`
//!   ([`crate::ContainerPoll`], by default 30 reads 3 s apart; `ERROR` or `EXPIRED` is
//!   `Permanent`, never finishing `Transient`), then `POST /{ig}/media_publish {creation_id}`.
//!   With a Page token on the Graph API (the Instagram account is `public["external_id"]`, else
//!   the page's linked account); with an Instagram Login token on `graph.instagram.com`, without
//!   `appsecret_proof` (the account is `public["external_id"]`, else `me`). A link is appended to
//!   the caption (Instagram does not link captions).
//!
//! The kind is `public["kind_key"]`, never guessed: without a Meta kind the post is refused
//! (`Permanent`, "kind_key missing") before anything is sent, so a Page token of an Instagram
//! capability can never post to the Page by default.
//!
//! Media are public URLs handed to Meta as they are (M3 supplies them); nothing is fetched here,
//! and the request's `media` (file bytes, for providers that take uploads only) is ignored.
//! A URL is a video when its path ends in `.mp4`, `.mov`, `.m4v`, `.webm` or `.avi`, an image
//! otherwise.

use std::fmt;

use jt_app::ports::connectors::{PublishReceipt, PublishRequest};
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};
use url::Url;

use crate::credential::{MetaCred, account_of, kind_of};
use crate::graph::{GraphApp, join, missing, node, strip_secrets, text};
use crate::{Masked, MetaConnector};

/// The most media one post carries.
const MAX_MEDIA: usize = 10;

/// The path endings of a video URL.
const VIDEO_ENDINGS: &[&str] = &[".mp4", ".mov", ".m4v", ".webm", ".avi"];

/// Whether `url` is a video (by its path's ending).
fn is_video(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    VIDEO_ENDINGS.iter().any(|ending| path.ends_with(ending))
}

/// `text`, and `link` on a line of its own after it when given.
fn with_link(text: &str, link: Option<&Url>) -> String {
    match link {
        Some(link) if text.trim().is_empty() => link.to_string(),
        Some(link) => format!("{text}\n\n{link}"),
        None => text.to_owned(),
    }
}

/// Publishes `request` for the capability `public` describes (see the module docs).
pub(crate) async fn publish(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    let kind = kind_of(public)?;
    if request.media_urls.len() > MAX_MEDIA {
        return Err(ConnectorError::permanent(format!(
            "a post carries at most {MAX_MEDIA} media"
        )));
    }
    let cred = MetaCred::of(cred, "publish")?;
    match (kind, cred) {
        ("instagram", MetaCred::Instagram { token }) => {
            let account = account_of(public).unwrap_or("me");
            instagram(connector, &Ig::Login { token }, node(account)?, request).await
        }
        ("instagram", MetaCred::Page { token, .. } | MetaCred::User { token }) => {
            let app = connector.graph_app()?;
            let account = match account_of(public) {
                Some(account) => account.to_owned(),
                None => linked_instagram(connector, &app, token).await?,
            };
            let ig = Ig::Graph { app: &app, token };
            instagram(connector, &ig, node(&account)?, request).await
        }
        ("facebook_page", MetaCred::Page { page_id, token }) => {
            facebook(connector, node(page_id)?, token, request).await
        }
        ("facebook_page", MetaCred::User { token }) => {
            facebook(connector, "me", token, request).await
        }
        _ => Err(ConnectorError::permanent(
            "this capability does not publish posts",
        )),
    }
}

/// The Instagram account linked to the page behind `token`.
async fn linked_instagram(
    connector: &MetaConnector,
    app: &GraphApp,
    token: &str,
) -> Result<String, ConnectorError> {
    let me = connector
        .graph_get(
            app,
            token,
            &["me"],
            &[("fields", "instagram_business_account")],
        )
        .await?;
    text(&me["instagram_business_account"]["id"])
        .ok_or_else(|| ConnectorError::permanent("no Instagram account is linked to the page"))
}

// ---------------------------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------------------------

/// A post on `page` (an id, or `me`).
async fn facebook(
    connector: &MetaConnector,
    page: &str,
    token: &str,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    let app = connector.graph_app()?;
    let media = &request.media_urls;
    let videos = media.iter().filter(|m| is_video(m)).count();
    let answer = match (media.len(), videos) {
        (0, _) => {
            let mut body = json!({ "message": request.text });
            if let Some(link) = &request.link {
                body["link"] = json!(link.as_str());
            }
            connector
                .graph_post(&app, token, &[page, "feed"], &[], body)
                .await?
        }
        (1, 1) => {
            let body = json!({
                "file_url": media[0].as_str(),
                "description": with_link(&request.text, request.link.as_ref()),
            });
            connector
                .graph_post(&app, token, &[page, "videos"], &[], body)
                .await?
        }
        (_, 0) if media.len() == 1 => {
            let body = json!({
                "url": media[0].as_str(),
                "caption": with_link(&request.text, request.link.as_ref()),
            });
            connector
                .graph_post(&app, token, &[page, "photos"], &[], body)
                .await?
        }
        (_, 0) => {
            let mut attached = Vec::with_capacity(media.len());
            for url in media {
                let photo = connector
                    .graph_post(
                        &app,
                        token,
                        &[page, "photos"],
                        &[],
                        json!({ "url": url.as_str(), "published": false }),
                    )
                    .await?;
                let id = text(&photo["id"]).ok_or_else(|| missing("photo id"))?;
                attached.push(json!({ "media_fbid": id }));
            }
            let body = json!({
                "message": with_link(&request.text, request.link.as_ref()),
                "attached_media": attached,
            });
            connector
                .graph_post(&app, token, &[page, "feed"], &[], body)
                .await?
        }
        _ => {
            return Err(ConnectorError::permanent(
                "a Facebook post carries one video, alone",
            ));
        }
    };
    let id = text(&answer["post_id"])
        .or_else(|| text(&answer["id"]))
        .ok_or_else(|| missing("post id"))?;
    let url = node(&id)
        .ok()
        .map(|id| join(&connector.bases().facebook_dialog, &[id], &[]));
    Ok(PublishReceipt {
        external_id: id,
        url,
    })
}

// ---------------------------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------------------------

/// Where Instagram calls go: the Graph API with a Page token (and the proof), or the Instagram
/// Graph API with an Instagram Login token (no proof). `Debug` masks the token.
enum Ig<'a> {
    Graph { app: &'a GraphApp, token: &'a str },
    Login { token: &'a str },
}

impl fmt::Debug for Ig<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Ig::Graph { app, .. } => f
                .debug_struct("Graph")
                .field("app", app)
                .field("token", &Masked)
                .finish(),
            Ig::Login { .. } => f.debug_struct("Login").field("token", &Masked).finish(),
        }
    }
}

impl Ig<'_> {
    /// The secrets its calls carry: the token, and on the Graph API the app secret.
    fn secrets(&self) -> Vec<String> {
        match self {
            Ig::Graph { app, token } => vec![(*token).to_owned(), app.secret.clone()],
            Ig::Login { token } => vec![(*token).to_owned()],
        }
    }

    async fn get(
        &self,
        connector: &MetaConnector,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        match self {
            Ig::Graph { app, token } => connector.graph_get(app, token, segments, query).await,
            Ig::Login { token } => connector.instagram_get(token, segments, query).await,
        }
    }

    async fn post(
        &self,
        connector: &MetaConnector,
        segments: &[&str],
        body: Value,
    ) -> Result<Value, ConnectorError> {
        match self {
            Ig::Graph { app, token } => connector.graph_post(app, token, segments, &[], body).await,
            Ig::Login { token } => connector.instagram_post(token, segments, body).await,
        }
    }
}

/// A post on the Instagram account `account`.
async fn instagram(
    connector: &MetaConnector,
    ig: &Ig<'_>,
    account: &str,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    let media = &request.media_urls;
    let caption = with_link(&request.text, request.link.as_ref());
    let container = match media.as_slice() {
        [] => {
            return Err(ConnectorError::permanent(
                "an Instagram post needs an image or a video",
            ));
        }
        [only] => {
            let body = if is_video(only) {
                json!({ "media_type": "REELS", "video_url": only.as_str(), "caption": caption })
            } else {
                json!({ "image_url": only.as_str(), "caption": caption })
            };
            create(connector, ig, account, body).await?
        }
        items => {
            let mut children = Vec::with_capacity(items.len());
            for item in items {
                let body = if is_video(item) {
                    json!({ "media_type": "VIDEO", "video_url": item.as_str(), "is_carousel_item": true })
                } else {
                    json!({ "image_url": item.as_str(), "is_carousel_item": true })
                };
                let child = create(connector, ig, account, body).await?;
                wait_finished(connector, ig, &child).await?;
                children.push(child);
            }
            let body = json!({
                "media_type": "CAROUSEL",
                "children": children.join(","),
                "caption": caption,
            });
            create(connector, ig, account, body).await?
        }
    };
    wait_finished(connector, ig, &container).await?;
    let published = ig
        .post(
            connector,
            &[account, "media_publish"],
            json!({ "creation_id": container }),
        )
        .await?;
    let id = text(&published["id"]).ok_or_else(|| missing("media id"))?;
    // The permalink, best effort: the post stands without it.
    let url = match ig
        .get(connector, &[node(&id)?], &[("fields", "permalink")])
        .await
    {
        Ok(media) => media["permalink"].as_str().and_then(|p| Url::parse(p).ok()),
        Err(e) => {
            tracing::warn!(
                error_kind = e.kind(),
                "the Instagram permalink could not be read"
            );
            None
        }
    };
    Ok(PublishReceipt {
        external_id: id,
        url,
    })
}

/// A media container on `account`, its id.
async fn create(
    connector: &MetaConnector,
    ig: &Ig<'_>,
    account: &str,
    body: Value,
) -> Result<String, ConnectorError> {
    let answer = ig.post(connector, &[account, "media"], body).await?;
    text(&answer["id"]).ok_or_else(|| missing("container id"))
}

/// Reads container `id` until it is `FINISHED` (see the module docs).
async fn wait_finished(
    connector: &MetaConnector,
    ig: &Ig<'_>,
    id: &str,
) -> Result<(), ConnectorError> {
    let poll = connector.poll;
    let attempts = poll.attempts.max(1);
    for attempt in 0..attempts {
        if attempt > 0 && !poll.interval.is_zero() {
            tokio::time::sleep(poll.interval).await;
        }
        let status = ig
            .get(connector, &[node(id)?], &[("fields", "status_code,status")])
            .await?;
        match status["status_code"].as_str() {
            Some("FINISHED" | "PUBLISHED") => return Ok(()),
            Some(code @ ("ERROR" | "EXPIRED")) => {
                // The provider's words, without a secret of the call (see `graph`).
                let detail =
                    strip_secrets(status["status"].as_str().unwrap_or_default(), &ig.secrets());
                return Err(ConnectorError::permanent(format!(
                    "the media container ended {code}: {detail}"
                )));
            }
            _ => {}
        }
    }
    Err(ConnectorError::transient(format!(
        "the media container did not finish after {attempts} reads"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_masks_the_token() {
        let app = GraphApp {
            secret: "app-SECRET".into(),
            version: "v19.0".into(),
        };
        for ig in [
            Ig::Graph {
                app: &app,
                token: "EAAB-page-SECRET",
            },
            Ig::Login {
                token: "IGAA-login-SECRET",
            },
        ] {
            let printed = format!("{ig:?}");
            assert!(!printed.contains("SECRET"), "{printed}");
            assert!(printed.contains("***"), "{printed}");
        }
    }
}
