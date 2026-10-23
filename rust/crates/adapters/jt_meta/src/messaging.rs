//! Direct messages: Messenger and Instagram through the Page (`POST /me/messages`, Page token,
//! `messaging_type: RESPONSE`), and WhatsApp Cloud (`POST /{phone_number_id}/messages`, a text
//! message).

use jt_app::ports::connectors::SendReceipt;
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};

use crate::MetaConnector;
use crate::credential::{MetaCred, kind_of};
use crate::graph::{missing, node, text};

/// The longest WhatsApp text body, in characters.
const MAX_WHATSAPP_TEXT: usize = 4096;
/// The longest Messenger text, in characters.
const MAX_MESSENGER_TEXT: usize = 2000;

/// Sends `text` to `recipient` (see the module docs), by the capability's kind: `whatsapp_cloud`
/// through its number (a WhatsApp credential), `messenger`, `instagram_dm` and `facebook_page`
/// through Messenger (a Page token, or a pasted one). Without a Meta kind, `Permanent`
/// ("kind_key missing") before anything is sent.
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
    let cred = MetaCred::of(cred, "send messages")?;
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
            Ok(SendReceipt { provider_id: id })
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
            Ok(SendReceipt { provider_id: id })
        }
        _ => Err(ConnectorError::permanent(
            "this capability does not send direct messages",
        )),
    }
}
