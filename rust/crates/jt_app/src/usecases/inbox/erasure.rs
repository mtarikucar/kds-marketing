//! Atomic person erasure. Financial references remain attached to an anonymous tombstone.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{TenantRepos, inbox::ErasureLog},
    usecases::{Deps, invalid},
};
use jt_inbox::{IdentityChannel, PersonId, identity_hash};
use jt_ledger::Actor;
use jt_tenancy::Permission;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseInput {
    #[serde(default)]
    pub confirm: bool,
}

pub async fn erase(
    deps: &Deps,
    ctx: &Ctx,
    person: PersonId,
    input: EraseInput,
) -> Result<Value, AppError> {
    ctx.require(Permission::InboxManage)?;
    if !input.confirm {
        return Err(invalid("confirm", "confirm must be true to erase a person"));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let p = r
        .people()
        .lock(person)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    if p.merged_into.is_some() {
        return Err(AppError::conflict("erase the surviving person"));
    }
    r.conversations().lock_for_person(person).await?;
    if p.erased_at.is_some() {
        r.erasure().scrub(person).await?;
    } else {
        r.erasure()
            .record(ErasureLog {
                workspace_id: ctx.workspace_id,
                person_id: person,
                requested_via: match ctx.actor {
                    Actor::Human { .. } => "panel",
                    Actor::Agent { .. } => "mcp",
                    Actor::System { .. } => "system",
                }
                .into(),
                at: ctx.now,
            })
            .await?;
        r.erasure().scrub(person).await?;
        r.people().set_erased(person, ctx.now).await?;
        super::record(
            r.as_mut(),
            ctx,
            "inbox.person.erased",
            "person",
            person,
            json!({"person_id":person}),
        )
        .await?;
    }
    r.commit().await?;
    Ok(json!({"person_id":person,"erased":true}))
}

pub(crate) async fn check_identity(
    r: &mut dyn TenantRepos,
    channel: IdentityChannel,
    value: &str,
) -> Result<(), AppError> {
    if r.erasure()
        .is_erased_identity(channel, &identity_hash(channel, value))
        .await?
    {
        return Err(AppError {
            code: crate::error::ErrorCode::Forbidden,
            message: "identity was erased".into(),
            details: json!({"reason":"erased_identity"}),
        });
    }
    Ok(())
}

/// Mask recursively on copies only. Shared by both ledger adapters.
pub fn mask_personal(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let cdr = map.get("scenario").and_then(Value::as_str) == Some("cdr");
            for (key, value) in map {
                if (cdr && key == "source")
                    || matches!(
                        key.as_str(),
                        "name"
                            | "display_name"
                            | "company"
                            | "phone"
                            | "email"
                            | "body"
                            | "text"
                            | "product"
                            | "from"
                            | "to"
                            | "recipient"
                            | "sender"
                            | "contact"
                            | "subject"
                            | "attachments"
                            | "file_ref"
                            | "location"
                            | "customer_num"
                            | "customer_name"
                            | "note"
                            | "title"
                            | "address"
                            | "field_data"
                            | "recipient_id"
                            | "wa_id"
                            | "image"
                            | "audio"
                            | "video"
                            | "document"
                            | "sticker"
                            | "contacts"
                            | "url"
                            | "link"
                            | "raw"
                            | "row"
                            | "recording"
                            | "crm_id"
                            | "internal_num"
                            | "destination"
                    )
                {
                    *value = json!("");
                } else {
                    mask_personal(value);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                mask_personal(item);
            }
        }
        _ => {}
    }
}

/// Called under the workspace write lock before accepting personal journey data.
pub(crate) async fn check_person(
    r: &mut dyn TenantRepos,
    person: PersonId,
) -> Result<(), AppError> {
    let p = r
        .people()
        .get(person)
        .await?
        .ok_or_else(|| AppError::not_found("no such person"))?;
    if p.erased_at.is_some() {
        return Err(AppError {
            code: crate::error::ErrorCode::Conflict,
            message: "person was erased".into(),
            details: json!({"reason":"person_erased"}),
        });
    }
    Ok(())
}

/// Identity candidates in provider payloads, normalized in the capability's namespace.
/// Shared by intake and the in-memory erasure inventory.
pub fn event_identities(
    cap: Option<&jt_capability::Capability>,
    payload: &Value,
) -> Vec<(IdentityChannel, String)> {
    use jt_inbox::{Channel, channel_for_kind, normalise, scope_opaque};
    let namespace = cap.and_then(|c| match c.kind_key.as_str() {
        "facebook_page" => Some(IdentityChannel::Messenger),
        "instagram" => Some(IdentityChannel::InstagramDm),
        kind => channel_for_kind(kind).map(Channel::identity_channel),
    });
    let recipient_namespace = match payload["channel"].as_str() {
        Some("EPOSTA") => Some(IdentityChannel::Email),
        Some("MESAJ" | "ARAMA") => Some(IdentityChannel::Phone),
        _ => namespace,
    };
    let cdr = (payload["scenario"] == "cdr").then_some(IdentityChannel::Phone);
    let mut out = vec![];
    for (path, channel) in [
        ("/from", namespace),
        ("/to", namespace),
        ("/recipient", recipient_namespace),
        ("/source", cdr),
        ("/destination", cdr),
        ("/customer_num", Some(IdentityChannel::Phone)),
        ("/email", Some(IdentityChannel::Email)),
        ("/phone", Some(IdentityChannel::Phone)),
        ("/message/from", Some(IdentityChannel::Phone)),
        ("/messaging/sender/id", namespace),
        ("/messaging/recipient/id", namespace),
        ("/sender/id", namespace),
        ("/recipient/id", namespace),
        ("/status/recipient_id", Some(IdentityChannel::Phone)),
    ] {
        let (Some(channel), Some(candidate)) =
            (channel, payload.pointer(path).and_then(Value::as_str))
        else {
            continue;
        };
        if channel == IdentityChannel::Email {
            for address in candidate.split(|c: char| c.is_whitespace() || "<>,;:\"".contains(c)) {
                if let Ok(v) = normalise(channel, address) {
                    out.push((channel, v));
                }
            }
        } else if let Ok(v) = normalise(channel, candidate) {
            let v = if channel == IdentityChannel::Phone {
                v
            } else {
                let Some(account) = cap.and_then(|c| c.external_id.as_deref()) else {
                    continue;
                };
                scope_opaque(account, &v)
            };
            out.push((channel, v));
        }
    }
    out
}

/// Sanitize before persistence, while holding the workspace write lock shared with erasure.
/// The caller must discard raw for the entire delivery when any item is scrubbed.
pub async fn scrub_inbound(
    r: &mut dyn TenantRepos,
    capability: Option<jt_capability::CapabilityId>,
    payload: &mut Value,
) -> Result<bool, AppError> {
    let mut erased = payload["erased_identity"] == true;
    if let Some(person) = payload["person_id"]
        .as_str()
        .and_then(|s| s.parse::<PersonId>().ok())
    {
        erased |= r.erasure().get(person).await?.is_some();
    }
    let cap = match capability {
        Some(id) => r.capabilities().find(id).await?,
        None => None,
    };
    // A bounce is addressed by the mailer daemon; its original outbound Message-ID is
    // the customer reference. Unknown sends may not have an external message id yet.
    if let Some(cap) = cap.as_ref().filter(|c| c.kind_key == "mailbox")
        && let Some(mid) = payload["message_id"].as_str()
    {
        let mut conversation = r
            .messages()
            .find_by_external_id(cap.id, mid)
            .await?
            .filter(|m| m.direction == jt_inbox::Direction::Outbound)
            .map(|m| m.conversation_id);
        if conversation.is_none()
            && let Some(id) = mid
                .strip_prefix('<')
                .and_then(|s| s.split_once('@'))
                .and_then(|(id, _)| uuid::Uuid::parse_str(id).ok())
            && let Some(row) = r.outbox().get(id).await?
            && row.capability_id == cap.id
            && row.intent["mail"]["message_id"].as_str() == Some(mid)
        {
            conversation = Some(row.conversation_id);
        }
        if let Some(id) = conversation
            && let Some(c) = r.conversations().get(id).await?
            && r.erasure().get(c.person_id).await?.is_some()
        {
            payload["person_id"] = json!(c.person_id);
            erased = true;
        }
    }
    if !erased {
        for (channel, value) in event_identities(cap.as_ref(), payload) {
            if r.erasure()
                .is_erased_identity(channel, &identity_hash(channel, &value))
                .await?
            {
                erased = true;
                break;
            }
        }
    }
    if erased {
        mask_personal(payload);
        payload["erased_identity"] = json!(true);
    }
    Ok(erased)
}
