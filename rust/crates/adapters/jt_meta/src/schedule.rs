//! A Facebook Page post left with Facebook's own scheduler (design 2026-11-10 §7.3, B47).
//!
//! - **What.** A text or link post, `POST /{page}/feed {message, link, published: false,
//!   scheduled_publish_time}` (the time a Unix timestamp in seconds), and a single-photo post, in
//!   the two calls Meta's Page photos reference gives for a scheduled post with photos
//!   (<https://developers.facebook.com/docs/graph-api/reference/page/photos>): the photo is
//!   uploaded unpublished and temporary, `POST /{page}/photos {url, published: false, temporary:
//!   true}`, and the post is scheduled on the feed with it attached, `POST /{page}/feed {message,
//!   attached_media: [{media_fbid}], published: false, scheduled_publish_time,
//!   unpublished_content_type: "SCHEDULED"}`. Not a story, a video, several photos or anything
//!   on Instagram: those Jeeta sends itself, at their time.
//! - **When.** Meta takes a time between 10 minutes and 30 days from the request (Pages API,
//!   Posts: <https://developers.facebook.com/docs/pages-api/posts>); a post is handed over
//!   between 15 minutes and 29 days ahead.
//! - **Where it stands.** `GET /{post}?fields=id,is_published` (Page Post reference,
//!   <https://developers.facebook.com/docs/graph-api/reference/page-post/>: `is_published`
//!   "indicates whether a scheduled post was published"). A post Graph says does not exist is
//!   gone: it will not go out.
//! - **Taking it back.** The same read first, so that a post that is out is never deleted, then
//!   `DELETE /{post}` (`{"success": true}`).
//!
//! The feed call's answer must name the post (`id`): an answer without it is `Unknown`, because
//! the scheduled post could then be neither read nor taken back. The photo is not scheduled on
//! the photos edge itself: run against a real Page on 2026-11-11, Meta took `POST /{page}/photos`
//! with `scheduled_publish_time` and answered without a `post_id`, which left a scheduled post
//! nobody could follow. An upload that fails schedules nothing (a temporary photo nobody
//! attaches expires by itself), so its failure is never `Unknown`. The text post and the two
//! reads are the documented shapes, tested against the Graph mock.

use jt_app::ports::connectors::{PostFormat, PublishReceipt, PublishRequest, Scheduled};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use crate::MetaConnector;
use crate::credential::{MetaCred, kind_of};
use crate::graph::{Body, join, node, text};
use crate::publish::{is_video, with_link};

/// The shortest time ahead a post is handed over (Meta's own floor is 10 minutes).
const EARLIEST: Duration = Duration::minutes(15);
/// The longest time ahead a post is handed over (Meta's own ceiling is 30 days).
const LATEST: Duration = Duration::days(29);

/// The window Facebook's scheduler takes `request` in for the capability `public` describes, or
/// `None` when it is not a post this module leaves there (see the module docs).
pub(crate) fn window(public: &Value, request: &PublishRequest) -> Option<(Duration, Duration)> {
    let page = kind_of(public).ok()? == "facebook_page";
    let format = matches!(request.format, None | Some(PostFormat::FeedPost));
    let media = match request.media_urls.len() {
        0 => true,
        1 => !is_video(request, 0),
        _ => false,
    };
    (page && format && media && request.tiktok.is_none() && request.privacy.is_none())
        .then_some((EARLIEST, LATEST))
}

/// The page (its id, or `me`) and the token a Page post is written with.
fn page_of<'a>(
    cred: &'a Credential,
    public: &Value,
    what: &str,
) -> Result<(&'a str, &'a str), ConnectorError> {
    if kind_of(public)? != "facebook_page" {
        return Err(ConnectorError::permanent(
            "only a Facebook Page post is left with the platform's scheduler",
        ));
    }
    match MetaCred::of(cred, what)? {
        MetaCred::Page { page_id, token } => Ok((node(page_id)?, token)),
        MetaCred::User { token } => Ok(("me", token)),
        _ => Err(ConnectorError::permanent(
            "this capability does not publish posts",
        )),
    }
}

/// Whether `e` is Graph saying the object is not there (`#100/33`, or a plain 404).
fn gone(e: &ConnectorError) -> bool {
    matches!(e, ConnectorError::Permanent { reason, .. }
        if reason.contains("(#100/33)") || reason.starts_with("HTTP 404"))
}

/// Leaves `request` with Facebook to go out at `at` (see the module docs).
pub(crate) async fn schedule(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    request: &PublishRequest,
    at: OffsetDateTime,
) -> Result<PublishReceipt, ConnectorError> {
    let (page, token) = page_of(cred, public, "schedule")?;
    if window(public, request).is_none() {
        return Err(ConnectorError::permanent(
            "this post is not one Facebook's scheduler takes",
        ));
    }
    let app = connector.graph_app()?;
    let time = at.unix_timestamp();
    let body = match request.media_urls.first() {
        None => {
            let mut body = json!({
                "message": request.text,
                "published": false,
                "scheduled_publish_time": time,
            });
            if let Some(link) = &request.link {
                body["link"] = json!(link.as_str());
            }
            body
        }
        Some(url) => {
            // The photo first, unpublished and temporary: this schedules nothing, so whatever
            // goes wrong here is a plain failure, never an unknown outcome.
            let photo = connector
                .graph_post(
                    &app,
                    token,
                    &[page, "photos"],
                    &[],
                    json!({"url": url.as_str(), "published": false, "temporary": true}),
                )
                .await
                .map_err(|e| match e {
                    ConnectorError::Unknown { .. } => ConnectorError::transient(
                        "the photo upload was not confirmed; nothing was scheduled",
                    ),
                    e => e,
                })?;
            let photo = text(&photo["id"])
                .filter(|id| node(id).is_ok())
                .ok_or_else(|| {
                    ConnectorError::permanent(
                        "the photo upload named no photo; nothing was scheduled",
                    )
                })?;
            json!({
                "message": with_link(&request.text, request.link.as_ref()),
                "attached_media": [{"media_fbid": photo}],
                "published": false,
                "scheduled_publish_time": time,
                "unpublished_content_type": "SCHEDULED",
            })
        }
    };
    // A write Meta takes once: an answer that neither took nor refused it is `Unknown`.
    let answer = connector
        .graph_post_once(&app, token, &[page, "feed"], &[], body)
        .await?;
    let id = text(&answer["id"])
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks post id"))?;
    // A scheduled post has no page of its own yet.
    node(&id).map_err(|_| ConnectorError::unknown("accepted response names no post"))?;
    Ok(PublishReceipt {
        external_id: id,
        url: None,
    })
}

/// Where the scheduled post `receipt` names stands (see the module docs).
pub(crate) async fn scheduled(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    receipt: &PublishReceipt,
) -> Result<Scheduled, ConnectorError> {
    let (_, token) = page_of(cred, public, "read a scheduled post")?;
    let app = connector.graph_app()?;
    let id = node(&receipt.external_id)?;
    let answer = match connector
        .graph_get(&app, token, &[id], &[("fields", "id,is_published")])
        .await
    {
        Ok(answer) => answer,
        Err(e) if gone(&e) => return Ok(Scheduled::Gone),
        Err(e) => return Err(e),
    };
    if text(&answer["id"]).as_deref() != Some(id) {
        return Err(ConnectorError::permanent("the read names another post"));
    }
    match answer["is_published"].as_bool() {
        Some(true) => Ok(Scheduled::Published(PublishReceipt {
            external_id: id.to_owned(),
            url: Some(join(&connector.bases().facebook_dialog, &[id], &[])),
        })),
        Some(false) => Ok(Scheduled::Waiting),
        None => Err(ConnectorError::permanent(
            "the read does not say whether the post was published",
        )),
    }
}

/// Takes the scheduled post `receipt` names back before it goes out: `true` once it is not at
/// Facebook any more, `false` when it had already gone out (it is then left alone).
pub(crate) async fn withdraw(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    receipt: &PublishReceipt,
) -> Result<bool, ConnectorError> {
    match scheduled(connector, cred, public, receipt).await? {
        Scheduled::Published(_) => return Ok(false),
        Scheduled::Gone => return Ok(true),
        Scheduled::Waiting => {}
    }
    let (_, token) = page_of(cred, public, "withdraw")?;
    let app = connector.graph_app()?;
    let url = connector.graph_url(&app.version, &[node(&receipt.external_id)?], &[]);
    match connector
        .call(Method::DELETE, url, app.auth(token), Body::Empty)
        .await
    {
        Ok(answer) if answer["success"].as_bool() == Some(true) => Ok(true),
        Ok(_) => Err(ConnectorError::unknown(
            "Facebook did not confirm deleting the scheduled post",
        )),
        Err(e) if gone(&e) => Ok(true),
        Err(e) => Err(e),
    }
}
