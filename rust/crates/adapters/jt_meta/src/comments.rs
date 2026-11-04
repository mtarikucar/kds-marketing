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

use jt_app::ports::connectors::{
    ModerationAction, PUBLIC_ITEM_GONE, PrivateReceipt, PublicTarget, SendReceipt, SubjectFacts,
    SubjectKind,
};
use jt_connector::{CommentGrant, ConnectorError, Credential, comment_grant};
use jt_outbound::Method;
use serde_json::{Value, json};

use crate::MetaConnector;
use crate::credential::{MetaCred, account_of, granted_scopes, kind_of};
use crate::graph::{Auth, Body, missing, node, text};

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
