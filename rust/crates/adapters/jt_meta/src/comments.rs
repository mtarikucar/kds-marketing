//! Replies to comments, private replies, moderation and the posts comments are on
//! ([`jt_app::ports::connectors::PublicSurface`] for Meta; spec
//! 2026-10-30-inbox-comments-marketplace-design.md §8.1).
//!
//! | Operation | Facebook Login (Page token, `graph.facebook.com`) | Instagram Login (`graph.instagram.com`) |
//! |---|---|---|
//! | reply in public, Instagram | `POST /{comment-id}/replies` `{message}` | the same |
//! | reply in public, Facebook | `POST /{comment-id}/comments` `{message}` | — |
//! | private reply, Facebook | `POST /{page-id}/messages` `{recipient: {comment_id}, message: {text}}` | — |
//! | private reply, Instagram | `POST /{ig-user-id}/messages`, the same body | the same |
//! | hide or show, Instagram | `POST /{comment-id}?hide=true` (`false` to show) | the same |
//! | hide or show, Facebook | `POST /{comment-id}` `{is_hidden}` | — |
//! | delete | `DELETE /{comment-id}` | the same |
//! | subject, Instagram | `GET /{media-id}?fields=caption,permalink,media_type,media_product_type,thumbnail_url,media_url,timestamp` | the same |
//! | subject, Facebook | `GET /{post-id}?fields=message,permalink_url,full_picture,created_time` | — |
//!
//! Sources, read 2026-11-04: Instagram's comment replies
//! (<https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies>),
//! comments (<https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment>:
//! `hide`, `DELETE`, the two hosts) and private replies
//! (<https://developers.facebook.com/docs/instagram-platform/private-replies/>: `recipient.comment_id`,
//! `message.text`, the answer's `recipient_id` and `message_id`); Facebook's comment edge
//! (<https://developers.facebook.com/docs/graph-api/reference/object/comments/>: `message`, the
//! answer's `id`, `pages_manage_engagement`), comment node
//! (<https://developers.facebook.com/docs/graph-api/reference/comment/>: `is_hidden`, `DELETE`)
//! and private replies
//! (<https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/>:
//! `POST /{page-id}/messages` with `recipient.comment_id`, one message within 7 days).
//!
//! Every call is refused before it is made when the grant lacks what it needs
//! ([`jt_connector::comment_grant`] of the credential's scopes, or of those recorded with a Page
//! token in `public["access"]["scopes"]`): replying and hiding need comments on, deleting another
//! person's comment `delete_others`, a private reply `private_reply`, reading a post comments on.
//! A reply and a private reply are writes Meta takes once (`graph_post_once`): an answer that
//! neither took nor refused one is `Unknown`, never sent again blindly. A Graph answer saying the
//! comment does not exist is `Permanent` with [`PUBLIC_ITEM_GONE`] (`gone`). Meta has no report
//! call: a report is refused.
//!
//! **The backfill poll** ([`jt_app::ports::connectors::PublicPoller`]; spec D17, D28): the
//! account's last 50 posts or media (`GET /{ig-id}/media?fields=id,timestamp,comments_count`,
//! `GET /{page-id}/posts?fields=id,created_time,comments.summary(true).limit(0)`), those of the last
//! 7 days whose comment count changed since the cursor's, read through
//! (`GET /{media-id}/comments?fields=...,replies{...}`, `GET /{post-id}/comments?filter=stream`),
//! at most 25 comment pages a run; a post left unread keeps its old count, so the next run reads
//! it. Each comment is the event its webhook gives (the same `comment:<id>:open` key), so what
//! both see is stored once. A reconciliation lists the replies under each target
//! (`/{comment-id}/replies`, `/{comment-id}/comments`): our own reply found there settles an
//! uncertain one (D25). These read fields are spec V-M1 still.

use jt_app::ports::connectors::{
    EnvelopeAuthor, EnvelopeStatus, EnvelopeSubject, InboundEventDraft, ModerationAction,
    PUBLIC_ITEM_GONE, PrivateReceipt, PublicEnvelope, PublicKind, PublicTarget, SendReceipt,
    SubjectFacts, SubjectKind,
};
use jt_connector::{CommentGrant, ConnectorError, Credential, EventKind, comment_grant};
use jt_outbound::Method;
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::MetaConnector;
use crate::credential::{MetaCred, account_of, granted_scopes, kind_of};
use crate::graph::{Auth, Body, GraphApp, integer, missing, node, text};
use crate::webhook::comment_event_id;

/// The longest caption excerpt a subject keeps, in characters.
const MAX_TITLE_CHARS: usize = 200;

/// The comment kind of `public` (`facebook_page` or `instagram`), else `Permanent`.
fn surface(public: &Value) -> Result<&str, ConnectorError> {
    match kind_of(public)? {
        kind @ ("facebook_page" | "instagram") => Ok(kind),
        _ => Err(ConnectorError::permanent(
            "this capability has no comments to act on",
        )),
    }
}

/// What the grant behind `cred` allows on `kind`'s comments (`granted_scopes`: a pasted token's
/// grant is not known, so it allows nothing).
fn grant(kind: &str, cred: &Credential, public: &Value) -> CommentGrant {
    comment_grant(kind, &granted_scopes(cred, public))
}

/// `Permission` naming `what`, before any call: the grant does not hold it.
fn not_granted(what: &str) -> ConnectorError {
    ConnectorError::permission(format!(
        "the account's grant does not allow {what}: reconnect it with the comment permissions"
    ))
}

/// Whether `e` is Graph's code 100 with subcode 33, taken as a comment that no longer exists (the
/// grant was checked before the call, so it is not a permission the account lacks). That a
/// deleted comment answers exactly this is spec V-M10, open until it is seen on a live comment.
fn is_gone(e: &ConnectorError) -> bool {
    matches!(e, ConnectorError::Permanent { reason, .. } if reason.contains("(#100/33)"))
}

/// `e`, a comment Graph says does not exist as [`PUBLIC_ITEM_GONE`].
fn gone(e: ConnectorError) -> ConnectorError {
    if is_gone(&e) {
        ConnectorError::permanent(PUBLIC_ITEM_GONE)
    } else {
        e
    }
}

/// The comment `target` names, as a Graph node.
fn comment_node(target: &PublicTarget) -> Result<&str, ConnectorError> {
    node(&target.external_id)
}

/// Replies to `target` in public (see the module docs).
pub(crate) async fn reply_public(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    target: &PublicTarget,
    message: &str,
) -> Result<SendReceipt, ConnectorError> {
    let kind = surface(public)?;
    if !grant(kind, cred, public).reply {
        return Err(not_granted("replying to comments"));
    }
    if message.trim().is_empty() {
        return Err(ConnectorError::permanent("no text to send"));
    }
    let comment = comment_node(target)?;
    let edge = if kind == "instagram" {
        "replies"
    } else {
        "comments"
    };
    let answer = match MetaCred::of(cred, "reply to comments")? {
        MetaCred::Instagram { token } if kind == "instagram" => {
            connector
                .instagram_post_once(token, &[comment, edge], json!({ "message": message }))
                .await
        }
        MetaCred::Page { token, .. } | MetaCred::User { token } => {
            let app = connector.graph_app()?;
            connector
                .graph_post_once(
                    &app,
                    token,
                    &[comment, edge],
                    &[],
                    json!({ "message": message }),
                )
                .await
        }
        _ => {
            return Err(ConnectorError::permanent(
                "this credential cannot reply to comments",
            ));
        }
    }
    .map_err(gone)?;
    let id = text(&answer["id"]).ok_or_else(|| missing("reply id"))?;
    Ok(SendReceipt {
        provider_id: id,
        cost_minor: None,
    })
}

/// Replies to `target`'s author privately (see the module docs): its answer's `message_id` and
/// `recipient_id`, the commenter's messaging id.
pub(crate) async fn reply_private(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    target: &PublicTarget,
    message: &str,
) -> Result<PrivateReceipt, ConnectorError> {
    let kind = surface(public)?;
    if !grant(kind, cred, public).private_reply {
        return Err(not_granted("private replies"));
    }
    if message.trim().is_empty() {
        return Err(ConnectorError::permanent("no text to send"));
    }
    // The account the message is sent as: the Page, or the Instagram account.
    let account = account_of(public).ok_or_else(|| missing("account id"))?;
    let body = json!({
        "recipient": { "comment_id": target.external_id },
        "message": { "text": message },
    });
    let answer = match MetaCred::of(cred, "reply privately")? {
        MetaCred::Instagram { token } if kind == "instagram" => {
            connector
                .instagram_post_once(token, &[node(account)?, "messages"], body)
                .await
        }
        MetaCred::Page { token, .. } | MetaCred::User { token } => {
            let app = connector.graph_app()?;
            connector
                .graph_post_once(&app, token, &[node(account)?, "messages"], &[], body)
                .await
        }
        _ => {
            return Err(ConnectorError::permanent(
                "this credential cannot reply privately",
            ));
        }
    }
    .map_err(gone)?;
    let id = text(&answer["message_id"]).ok_or_else(|| missing("message id"))?;
    Ok(PrivateReceipt {
        provider_id: id,
        recipient_id: text(&answer["recipient_id"]),
    })
}

/// Hides, shows again or deletes `target` (see the module docs); a report is refused.
pub(crate) async fn moderate(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    target: &PublicTarget,
    action: ModerationAction,
) -> Result<(), ConnectorError> {
    let kind = surface(public)?;
    let granted = grant(kind, cred, public);
    match action {
        ModerationAction::Report { .. } => {
            return Err(ConnectorError::permanent(
                "Meta takes no reports of comments",
            ));
        }
        ModerationAction::Delete if !granted.delete_others => {
            return Err(not_granted("deleting comments"));
        }
        ModerationAction::Hide | ModerationAction::Unhide if !granted.hide => {
            return Err(not_granted("hiding comments"));
        }
        _ => {}
    }
    let comment = comment_node(target)?;
    let hide = if action == ModerationAction::Hide {
        "true"
    } else {
        "false"
    };
    let answer = match MetaCred::of(cred, "moderate comments")? {
        MetaCred::Instagram { token } if kind == "instagram" => {
            let (method, url) = match action {
                ModerationAction::Delete => {
                    (Method::DELETE, connector.instagram_url(&[comment], &[]))
                }
                _ => (
                    Method::POST,
                    connector.instagram_url(&[comment], &[("hide", hide)]),
                ),
            };
            connector
                .call(method, url, Auth::Bearer(token), Body::Empty)
                .await
        }
        MetaCred::Page { token, .. } | MetaCred::User { token } => {
            let app = connector.graph_app()?;
            match action {
                ModerationAction::Delete => {
                    let url = connector.graph_url(&app.version, &[comment], &[]);
                    connector
                        .call(Method::DELETE, url, app.auth(token), Body::Empty)
                        .await
                }
                _ if kind == "instagram" => {
                    connector
                        .graph_post(&app, token, &[comment], &[("hide", hide)], json!({}))
                        .await
                }
                _ => {
                    let hidden = action == ModerationAction::Hide;
                    connector
                        .graph_post(&app, token, &[comment], &[], json!({ "is_hidden": hidden }))
                        .await
                }
            }
        }
        _ => {
            return Err(ConnectorError::permanent(
                "this credential cannot moderate comments",
            ));
        }
    }
    .map_err(gone)?;
    if answer["success"] == false {
        return Err(ConnectorError::permanent(
            "Meta did not take the moderation",
        ));
    }
    Ok(())
}

/// What Graph tells of the post or media `subject` (see the module docs): its caption or message
/// (cut to `MAX_TITLE_CHARS`), permalink and picture; facts: Instagram's media type, product
/// type and time, Facebook's time.
pub(crate) async fn subject(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    subject: &str,
) -> Result<Option<SubjectFacts>, ConnectorError> {
    let kind = surface(public)?;
    if !grant(kind, cred, public).read {
        return Err(not_granted("reading comments"));
    }
    let post = node(subject)?;
    let instagram = kind == "instagram";
    let fields = if instagram {
        "caption,permalink,media_type,media_product_type,thumbnail_url,media_url,timestamp"
    } else {
        "message,permalink_url,full_picture,created_time"
    };
    let answer = match MetaCred::of(cred, "read posts")? {
        MetaCred::Instagram { token } if instagram => {
            connector
                .instagram_get(token, &[post], &[("fields", fields)])
                .await
        }
        MetaCred::Page { token, .. } | MetaCred::User { token } => {
            let app = connector.graph_app()?;
            connector
                .graph_get(&app, token, &[post], &[("fields", fields)])
                .await
        }
        _ => {
            return Err(ConnectorError::permanent(
                "this credential cannot read posts",
            ));
        }
    }
    .map_err(gone)?;
    let caption = if instagram {
        &answer["caption"]
    } else {
        &answer["message"]
    };
    let title: String = caption
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    let (url, image_url, facts) = if instagram {
        // A video's own file is no picture: its thumbnail is.
        let image = if answer["media_type"] == "VIDEO" {
            text(&answer["thumbnail_url"])
        } else {
            text(&answer["media_url"]).or_else(|| text(&answer["thumbnail_url"]))
        };
        (
            text(&answer["permalink"]),
            image,
            json!({
                "media_type": answer["media_type"],
                "media_product_type": answer["media_product_type"],
                "timestamp": answer["timestamp"],
            }),
        )
    } else {
        (
            text(&answer["permalink_url"]),
            text(&answer["full_picture"]),
            json!({ "created_time": answer["created_time"] }),
        )
    };
    Ok(Some(SubjectFacts {
        kind: SubjectKind::Post,
        title,
        url,
        image_url,
        facts,
    }))
}

// ---------------------------------------------------------------------------------------------
// The comments backfill poll (task M4)
// ---------------------------------------------------------------------------------------------

/// How far back a poll looks for posts and media.
const POLL_WINDOW: Duration = Duration::days(7);
/// The most posts or media one poll reads the comment counts of.
const MAX_POLL_MEDIA: usize = 50;
/// The most comment pages one poll reads, over all its posts or media.
const MAX_POLL_COMMENT_PAGES: usize = 25;

/// A Graph time: RFC 3339, or Graph's `2026-10-20T10:00:00+0000` (no colon in the offset).
fn graph_time(value: &Value) -> Option<OffsetDateTime> {
    let text = value.as_str().filter(|t| t.is_ascii())?;
    if let Ok(at) = OffsetDateTime::parse(text, &Rfc3339) {
        return Some(at);
    }
    let (head, offset) = text.split_at(text.len().checked_sub(5)?);
    let sign = offset.chars().next()?;
    if !matches!(sign, '+' | '-') {
        return None;
    }
    OffsetDateTime::parse(
        &format!("{head}{}:{}", &offset[..3], &offset[3..]),
        &Rfc3339,
    )
    .ok()
}

/// How one poll reads a capability: through the Page (or user) token on `graph.facebook.com`, or
/// an Instagram Login token on `graph.instagram.com`.
enum Reader<'a> {
    Graph { app: GraphApp, token: &'a str },
    Instagram { token: &'a str },
}

impl Reader<'_> {
    fn of<'a>(
        connector: &MetaConnector,
        cred: &'a Credential,
        kind: &str,
    ) -> Result<Reader<'a>, ConnectorError> {
        match MetaCred::of(cred, "read comments")? {
            MetaCred::Instagram { token } if kind == "instagram" => Ok(Reader::Instagram { token }),
            MetaCred::Page { token, .. } | MetaCred::User { token } => Ok(Reader::Graph {
                app: connector.graph_app()?,
                token,
            }),
            _ => Err(ConnectorError::permanent(
                "this credential cannot read comments",
            )),
        }
    }

    /// One page of `segments`: its `data` and the link to the next, if any.
    async fn page(
        &self,
        connector: &MetaConnector,
        url: Option<Url>,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<(Vec<Value>, Option<Url>), ConnectorError> {
        let (url, auth) = match self {
            Reader::Graph { app, token } => (
                url.unwrap_or_else(|| connector.graph_url(&app.version, segments, query)),
                app.auth(token),
            ),
            Reader::Instagram { token } => (
                url.unwrap_or_else(|| connector.instagram_url(segments, query)),
                Auth::Bearer(token),
            ),
        };
        let origin = url.origin();
        let answer = connector.call(Method::GET, url, auth, Body::Empty).await?;
        let data = answer["data"].as_array().cloned().unwrap_or_default();
        let next = match answer["paging"]["next"].as_str() {
            Some(next) => {
                let next = Url::parse(next)
                    .map_err(|_| ConnectorError::permanent("the paging link is not a URL"))?;
                if next.origin() != origin {
                    return Err(ConnectorError::permanent(
                        "the paging link leads away from the API",
                    ));
                }
                Some(next)
            }
            None => None,
        };
        Ok((data, next))
    }
}

/// A comment `item` Graph listed (Instagram's or Facebook's fields), on post or media `subject`
/// (when known) of `account`, as the event its webhook gives the same comment: `None` without an
/// id or a time.
fn polled_comment(
    instagram: bool,
    account: &str,
    subject: Option<&str>,
    item: &Value,
) -> Option<InboundEventDraft> {
    let id = text(&item["id"])?;
    let (created_at, body, name_key) = if instagram {
        (graph_time(&item["timestamp"])?, &item["text"], "username")
    } else {
        (graph_time(&item["created_time"])?, &item["message"], "name")
    };
    let parent = if instagram {
        text(&item["parent_id"])
    } else {
        text(&item["parent"]["id"])
    };
    let from_id = text(&item["from"]["id"]);
    let name = item["from"][name_key]
        .as_str()
        .or_else(|| item["username"].as_str())
        .filter(|n| !n.trim().is_empty())
        .map(str::to_owned);
    let envelope = PublicEnvelope {
        kind: PublicKind::Comment,
        account_id: account.to_owned(),
        root_external_id: parent.clone().unwrap_or_else(|| id.clone()),
        parent_external_id: parent,
        external_id: id.clone(),
        status: EnvelopeStatus::Open,
        author: EnvelopeAuthor {
            is_self: from_id.as_deref() == Some(account),
            id: from_id,
            name,
        },
        text: body.as_str().unwrap_or_default().to_owned(),
        created_at,
        deadline: None,
        live: false,
        subject: subject
            .filter(|s| !s.trim().is_empty())
            .map(|subject| EnvelopeSubject {
                kind: SubjectKind::Post,
                external_id: subject.to_owned(),
                title: String::new(),
                url: None,
                image_url: None,
                facts: Value::Null,
            }),
        answer: None,
        rejection: None,
    };
    let mut provider_item = item.clone();
    if let Value::Object(fields) = &mut provider_item {
        // A polled item's replies come as their own events.
        fields.remove("replies");
    }
    Some(InboundEventDraft {
        external_id: comment_event_id(&id, EnvelopeStatus::Open, None),
        kind: EventKind::Comment,
        payload: envelope.into_payload(provider_item),
        occurred_at: Some(created_at),
    })
}

/// The comment fields a poll reads.
const IG_COMMENT_FIELDS: &str = "id,text,timestamp,username,from,parent_id";
const FB_COMMENT_FIELDS: &str = "id,message,from,created_time,parent";

/// The comments new since `cursor` on the capability's posts or media of the last
/// [`POLL_WINDOW`] (see the module docs): those whose comment count changed since the last poll,
/// at most [`MAX_POLL_MEDIA`] of them and [`MAX_POLL_COMMENT_PAGES`] comment pages in all; a post
/// left unread keeps its old count, so the next poll reads it. The next cursor is
/// `{"since", "counts": {post or media id: count}}`, the counts of the window's posts only.
pub(crate) async fn poll(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    cursor: &Value,
) -> Result<(Vec<InboundEventDraft>, Value), ConnectorError> {
    let kind = surface(public)?;
    if !grant(kind, cred, public).read {
        return Err(not_granted("reading comments"));
    }
    let account = account_of(public).ok_or_else(|| missing("account id"))?;
    let reader = Reader::of(connector, cred, kind)?;
    let instagram = kind == "instagram";
    let since = OffsetDateTime::now_utc() - POLL_WINDOW;
    let limit = MAX_POLL_MEDIA.to_string();
    let (edge, fields) = if instagram {
        ("media", "id,timestamp,comments_count")
    } else {
        ("posts", "id,created_time,comments.summary(true).limit(0)")
    };
    let (media, _) = reader
        .page(
            connector,
            None,
            &[node(account)?, edge],
            &[("fields", fields), ("limit", &limit)],
        )
        .await?;
    let old = &cursor["counts"];
    let mut counts = Map::new();
    let mut drafts = Vec::new();
    let mut pages_left = MAX_POLL_COMMENT_PAGES;
    for item in media.iter().take(MAX_POLL_MEDIA) {
        let Some(id) = text(&item["id"]) else {
            continue;
        };
        let at = if instagram {
            graph_time(&item["timestamp"])
        } else {
            graph_time(&item["created_time"])
        };
        if at.is_some_and(|at| at < since) {
            continue;
        }
        let count = if instagram {
            integer(&item["comments_count"])
        } else {
            integer(&item["comments"]["summary"]["total_count"])
        }
        .unwrap_or(0);
        let seen = integer(&old[id.as_str()]);
        if seen == Some(count) || count == 0 {
            counts.insert(id, json!(count));
            continue;
        }
        let mut next = None;
        let mut complete = false;
        while pages_left > 0 {
            pages_left -= 1;
            let query: &[(&str, &str)] = if instagram {
                &[(
                    "fields",
                    "id,text,timestamp,username,from,parent_id,replies{id,text,timestamp,username,from,parent_id}",
                )]
            } else {
                &[("filter", "stream"), ("fields", FB_COMMENT_FIELDS)]
            };
            let (comments, more) = match reader
                .page(connector, next.take(), &[node(&id)?, "comments"], query)
                .await
            {
                Ok(page) => page,
                // Deleted since it was listed: nothing more to read on it.
                Err(e) if is_gone(&e) => (Vec::new(), None),
                Err(e) => return Err(e),
            };
            for comment in &comments {
                drafts.extend(polled_comment(instagram, account, Some(&id), comment));
                for reply in comment["replies"]["data"].as_array().into_iter().flatten() {
                    drafts.extend(polled_comment(instagram, account, Some(&id), reply));
                }
            }
            match more {
                Some(more) => next = Some(more),
                None => {
                    complete = true;
                    break;
                }
            }
        }
        // Read through: its count is the cursor's; else it stays as it was, to be read again.
        match (complete, seen) {
            (true, _) => {
                counts.insert(id, json!(count));
            }
            (false, Some(seen)) => {
                counts.insert(id, json!(seen));
            }
            (false, None) => {}
        }
    }
    let next_cursor = json!({
        "since": since.format(&Rfc3339).unwrap_or_default(),
        "counts": counts,
    });
    Ok((drafts, next_cursor))
}

/// The replies Graph lists under each of `targets` (comments the inbox answered without knowing
/// whether its answer was taken), as their events: our own reply among them settles the
/// uncertain answer (spec D25). A target Graph says is gone is skipped.
pub(crate) async fn reconcile(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    targets: &[PublicTarget],
) -> Result<Vec<InboundEventDraft>, ConnectorError> {
    let kind = surface(public)?;
    if !grant(kind, cred, public).read {
        return Err(not_granted("reading comments"));
    }
    let account = account_of(public).ok_or_else(|| missing("account id"))?;
    let reader = Reader::of(connector, cred, kind)?;
    let instagram = kind == "instagram";
    let mut drafts = Vec::new();
    for target in targets {
        let comment = node(&target.external_id)?;
        let (edge, fields) = if instagram {
            ("replies", IG_COMMENT_FIELDS)
        } else {
            ("comments", FB_COMMENT_FIELDS)
        };
        let replies = match reader
            .page(connector, None, &[comment, edge], &[("fields", fields)])
            .await
        {
            Ok((replies, _)) => replies,
            // The comment is gone: its removal reaches the item another way (a webhook, a reply's
            // refusal); the other targets are still read.
            Err(e) if is_gone(&e) => continue,
            Err(e) => return Err(e),
        };
        let subject = target.subject_external_id.as_deref();
        for reply in &replies {
            let mut reply = reply.clone();
            // A reply listed under the target answers it, whether or not the listing names its
            // parent.
            if !instagram && reply["parent"].is_null() {
                reply["parent"] = json!({ "id": target.external_id });
            }
            if instagram && reply["parent_id"].is_null() {
                reply["parent_id"] = json!(target.external_id);
            }
            drafts.extend(polled_comment(instagram, account, subject, &reply));
        }
    }
    Ok(drafts)
}
