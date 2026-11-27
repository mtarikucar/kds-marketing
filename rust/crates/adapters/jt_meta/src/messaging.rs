//! Direct messages: Messenger and Instagram through the Page (`POST /me/messages`, Page token,
//! `messaging_type: RESPONSE`), and WhatsApp Cloud (`POST /{phone_number_id}/messages`, a text
//! message). The sender's name: `GET /{psid}?fields=name` (Messenger), `GET /{igsid}?fields=
//! name,username` (Instagram, on `graph.instagram.com` for an Instagram Login token). The
//! one-time sharing of a WhatsApp Business app's contacts or history:
//! `POST /{phone_number_id}/smb_app_data` ([`request_app_sync`]). A media file a person sent to a
//! WhatsApp number: `GET /{media-id}`, then its address ([`fetch_media`]).

use jt_app::ports::connectors::{AppSync, Media, SendReceipt};
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};
use url::Url;

use crate::MetaConnector;
use crate::credential::{MetaCred, account_of, kind_of};
use crate::graph::{missing, node, text};

/// The longest WhatsApp text body, in characters.
const MAX_WHATSAPP_TEXT: usize = 4096;
/// The longest text Instagram Login's messages take, in UTF-8 bytes (Meta's messaging reference,
/// <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/>).
const MAX_INSTAGRAM_LOGIN_TEXT_BYTES: usize = 1000;

/// The permission an Instagram Login account's direct messages need.
pub const INSTAGRAM_MESSAGES_SCOPE: &str = "instagram_business_manage_messages";

/// The longest Messenger text, in characters (a Facebook private reply's bound too:
/// `jt_inbox::public::FACEBOOK_PRIVATE_MAX`, pinned equal by a test).
pub const MAX_MESSENGER_TEXT: usize = 2000;

/// Sends `text` to `recipient` (see the module docs), by the capability's kind: `whatsapp_cloud`
/// through its number (a WhatsApp credential), `messenger`, `instagram_dm` and `facebook_page`
/// through Messenger (a Page token, or a pasted one); `instagram_dm` with an Instagram Login
/// token on `graph.instagram.com` (`POST /{account}/messages`, `{recipient: {id}, message:
/// {text}}`, at most 1000 bytes), refused (`Permission`) before anything is sent when its grant
/// lacks `instagram_business_manage_messages`. Without a Meta kind, `Permanent` ("kind_key
/// missing") before anything is sent.
pub(crate) async fn send_text(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    recipient: &str,
    text_body: &str,
) -> Result<SendReceipt, ConnectorError> {
    let kind = kind_of(public)?;
    if recipient.trim().is_empty() {
        return Err(ConnectorError::permanent("no recipient"));
    }
    if text_body.trim().is_empty() {
        return Err(ConnectorError::permanent("no text to send"));
    }
    let granted = matches!(cred, Credential::OAuth { scopes, .. }
        if scopes.iter().any(|s| s == INSTAGRAM_MESSAGES_SCOPE));
    let cred = MetaCred::of(cred, "send messages")?;
    if let ("instagram_dm", MetaCred::Instagram { token }) = (kind, cred) {
        if !granted {
            return Err(ConnectorError::permission(
                "the Instagram account's grant does not allow direct messages: reconnect it",
            ));
        }
        if text_body.len() > MAX_INSTAGRAM_LOGIN_TEXT_BYTES {
            return Err(ConnectorError::permanent(format!(
                "an Instagram message is at most {MAX_INSTAGRAM_LOGIN_TEXT_BYTES} bytes"
            )));
        }
        let account = match account_of(public) {
            Some(account) => node(account)?,
            None => "me",
        };
        let answer = connector
            .instagram_post(
                token,
                &[account, "messages"],
                json!({ "recipient": { "id": recipient }, "message": { "text": text_body } }),
            )
            .await?;
        let id = text(&answer["message_id"]).ok_or_else(|| missing("message id"))?;
        return Ok(SendReceipt {
            provider_id: id,
            cost_minor: None,
        });
    }
    let app = connector.graph_app()?;
    match (kind, cred) {
        (
            "whatsapp_cloud",
            MetaCred::WhatsApp {
                phone_number_id,
                token,
                ..
            },
        ) => {
            if text_body.chars().count() > MAX_WHATSAPP_TEXT {
                return Err(ConnectorError::permanent(format!(
                    "a WhatsApp text is at most {MAX_WHATSAPP_TEXT} characters"
                )));
            }
            let answer = connector
                .graph_post(
                    &app,
                    token,
                    &[node(phone_number_id)?, "messages"],
                    &[],
                    json!({
                        "messaging_product": "whatsapp",
                        "recipient_type": "individual",
                        "to": recipient,
                        "type": "text",
                        "text": { "preview_url": false, "body": text_body },
                    }),
                )
                .await?;
            let id = answer["messages"]
                .as_array()
                .and_then(|m| m.first())
                .and_then(|m| text(&m["id"]))
                .ok_or_else(|| missing("message id"))?;
            Ok(SendReceipt {
                provider_id: id,
                cost_minor: None,
            })
        }
        (
            "messenger" | "instagram_dm" | "facebook_page",
            MetaCred::Page { token, .. } | MetaCred::User { token },
        ) => {
            if text_body.chars().count() > MAX_MESSENGER_TEXT {
                return Err(ConnectorError::permanent(format!(
                    "a Messenger text is at most {MAX_MESSENGER_TEXT} characters"
                )));
            }
            let answer = connector
                .graph_post(
                    &app,
                    token,
                    &["me", "messages"],
                    &[],
                    json!({
                        "recipient": { "id": recipient },
                        "messaging_type": "RESPONSE",
                        "message": { "text": text_body },
                    }),
                )
                .await?;
            let id = text(&answer["message_id"]).ok_or_else(|| missing("message id"))?;
            Ok(SendReceipt {
                provider_id: id,
                cost_minor: None,
            })
        }
        _ => Err(ConnectorError::permanent(
            "this capability does not send direct messages",
        )),
    }
}

/// The name Meta shows for `sender`, who wrote to the capability (see the module docs): its
/// `name`, else (Instagram) its `username`. `None` for a WhatsApp number (its name comes with
/// the webhook) or another kind, without a call.
pub(crate) async fn sender_name(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    sender: &str,
) -> Result<Option<String>, ConnectorError> {
    let instagram = match kind_of(public)? {
        "messenger" | "facebook_page" => false,
        "instagram_dm" | "instagram" => true,
        _ => return Ok(None),
    };
    let fields = if instagram { "name,username" } else { "name" };
    let answer = match MetaCred::of(cred, "read a sender's name")? {
        MetaCred::Page { token, .. } | MetaCred::User { token } => {
            let app = connector.graph_app()?;
            connector
                .graph_get(&app, token, &[node(sender)?], &[("fields", fields)])
                .await?
        }
        MetaCred::Instagram { token } if instagram => {
            connector
                .instagram_get(token, &[node(sender)?], &[("fields", fields)])
                .await?
        }
        _ => return Ok(None),
    };
    Ok(text(&answer["name"])
        .or_else(|| instagram.then(|| text(&answer["username"])).flatten())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty()))
}

/// The longest caption of a WhatsApp image, in characters.
pub(crate) const MAX_WHATSAPP_CAPTION: usize = 1024;

/// Sends an image to a person on a `whatsapp_cloud` number: `POST /{phone_number_id}/messages`
/// with `type: image` and `image: {link, caption}`, Meta fetching the image from `image.url`
/// (<https://developers.facebook.com/docs/whatsapp/cloud-api/messages/image-messages>). Only
/// JPEG and PNG are WhatsApp images; another type, another kind of capability, or a caption over
/// [`MAX_WHATSAPP_CAPTION`] characters is refused before any call (`Permanent`).
pub(crate) async fn send_image(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    recipient: &str,
    image: &jt_app::ports::connectors::OutboundImage,
    caption: &str,
) -> Result<SendReceipt, ConnectorError> {
    if kind_of(public)? != "whatsapp_cloud" {
        return Err(ConnectorError::permanent(
            "images are sent on WhatsApp numbers only",
        ));
    }
    if recipient.trim().is_empty() {
        return Err(ConnectorError::permanent("no recipient"));
    }
    if !matches!(image.mime.as_str(), "image/jpeg" | "image/png") {
        return Err(ConnectorError::permanent(
            "a WhatsApp image is a JPEG or a PNG",
        ));
    }
    if caption.chars().count() > MAX_WHATSAPP_CAPTION {
        return Err(ConnectorError::permanent(format!(
            "a WhatsApp image caption is at most {MAX_WHATSAPP_CAPTION} characters"
        )));
    }
    let MetaCred::WhatsApp {
        phone_number_id,
        token,
        ..
    } = MetaCred::of(cred, "send messages")?
    else {
        return Err(ConnectorError::permanent(
            "images are sent on WhatsApp numbers only",
        ));
    };
    let app = connector.graph_app()?;
    let mut body = json!({ "link": image.url });
    if !caption.trim().is_empty() {
        body["caption"] = json!(caption);
    }
    let answer = connector
        .graph_post(
            &app,
            token,
            &[node(phone_number_id)?, "messages"],
            &[],
            json!({
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": recipient,
                "type": "image",
                "image": body,
            }),
        )
        .await?;
    let id = answer["messages"]
        .as_array()
        .and_then(|m| m.first())
        .and_then(|m| text(&m["id"]))
        .ok_or_else(|| missing("message id"))?;
    Ok(SendReceipt {
        provider_id: id,
        cost_minor: None,
    })
}

/// Asks Meta, once, to share what the WhatsApp Business app behind a `whatsapp_cloud` number
/// holds: `POST /{phone_number_id}/smb_app_data` with `messaging_product: whatsapp` and
/// `sync_type` `smb_app_state_sync` (contacts) or `history`, as Meta's onboarding page gives it
/// (<https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>);
/// the receipt's id is the answer's `request_id`, empty when a success names none (the request
/// was taken all the same). Meta takes each request once, so it is sent as a one-time write
/// ([`MetaConnector::graph_post_once`]): an answer that neither took nor refused it is `Unknown`.
/// Another kind, or a credential that is not a WhatsApp one, asks nothing (`None`).
pub(crate) async fn request_app_sync(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    sync: AppSync,
) -> Result<Option<SendReceipt>, ConnectorError> {
    if kind_of(public)? != "whatsapp_cloud" {
        return Ok(None);
    }
    let MetaCred::WhatsApp {
        phone_number_id,
        token,
        ..
    } = MetaCred::of(cred, "share a WhatsApp Business app's data")?
    else {
        return Ok(None);
    };
    let sync_type = match sync {
        AppSync::Contacts => "smb_app_state_sync",
        AppSync::History => "history",
    };
    let app = connector.graph_app()?;
    let answer = connector
        .graph_post_once(
            &app,
            token,
            &[node(phone_number_id)?, "smb_app_data"],
            &[],
            json!({ "messaging_product": "whatsapp", "sync_type": sync_type }),
        )
        .await?;
    let id = text(&answer["request_id"]).unwrap_or_default();
    Ok(Some(SendReceipt {
        provider_id: id,
        cost_minor: None,
    }))
}

/// The hosts a media file's address may name, and their subdomains: where Meta serves WhatsApp
/// media (`lookaside.fbsbx.com`) and its content hosts. The number's token is sent to no other.
pub(crate) const MEDIA_HOSTS: [&str; 4] =
    ["fbsbx.com", "whatsapp.net", "fbcdn.net", "facebook.com"];

/// Whether `url` may be read with a number's token: HTTPS on one of [`MEDIA_HOSTS`] (or a
/// subdomain), or on the Graph API's own configured host (a test double's). An address that names
/// a user, a password or another port is refused.
fn media_host(connector: &MetaConnector, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let graph = &connector.bases().graph;
    if graph.host_str() == Some(host)
        && graph.port_or_known_default() == url.port_or_known_default()
    {
        return url.scheme() == graph.scheme();
    }
    let host = host.to_ascii_lowercase();
    url.scheme() == "https"
        && url.port().is_none_or(|p| p == 443)
        && MEDIA_HOSTS
            .iter()
            .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// The media file `media_id` names, one a person sent to a `whatsapp_cloud` number: `GET
/// /{media-id}` names its address (`url`, on `lookaside.fbsbx.com`), its `mime_type` and its
/// `file_size`; the address is then read with the number's token as the bearer
/// (<https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media>). A file larger than
/// `max_bytes` (by its `file_size`, or as it is read) is `Permanent`. The type is Graph's, else
/// the download's. The address must be on a Meta media host ([`media_host`]): the token goes to no
/// other. `None` for another kind, without a call.
pub(crate) async fn fetch_media(
    connector: &MetaConnector,
    cred: &Credential,
    public: &Value,
    media_id: &str,
    max_bytes: usize,
) -> Result<Option<Media>, ConnectorError> {
    if kind_of(public)? != "whatsapp_cloud" {
        return Ok(None);
    }
    let MetaCred::WhatsApp { token, .. } = MetaCred::of(cred, "read a media file")? else {
        return Ok(None);
    };
    let app = connector.graph_app()?;
    let answer = connector
        .graph_get(&app, token, &[node(media_id)?], &[])
        .await?;
    let size = answer["file_size"]
        .as_u64()
        .or_else(|| answer["file_size"].as_str().and_then(|s| s.parse().ok()));
    if size.is_some_and(|size| size > max_bytes as u64) {
        return Err(ConnectorError::permanent("the media file is too large"));
    }
    let url = text(&answer["url"]).ok_or_else(|| missing("media address"))?;
    let url = Url::parse(&url)
        .map_err(|_| ConnectorError::permanent("the media file's address is unreadable"))?;
    if !media_host(connector, &url) {
        return Err(ConnectorError::permanent(
            "the media file's address is not on a Meta media host",
        ));
    }
    let (kind, data) = connector.download(url, Some(token), max_bytes).await?;
    let mime = text(&answer["mime_type"]).or(kind).unwrap_or_default();
    Ok(Some(Media { mime, data }))
}
