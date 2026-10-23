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
    if p.erased_at.is_none() {
        r.conversations().lock_for_person(person).await?;
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
