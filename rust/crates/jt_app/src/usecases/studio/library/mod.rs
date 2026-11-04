//! The materials library's use cases (spec `2026-11-03-studio-materials-design.md` §5.2, §5.3, §8,
//! §9): olays, materials and their tags, what a slot may show, the calendar and the materials
//! policy, and the çekim listesi. Each is exempt from the strategy gate (D35: the owner gathers
//! materials before and while the strategy is worked out), never from the workspace-status check.
//!
//! The consent decisions are a human's (D4): confirming an olay, a material's share permission,
//! freeing it, rebinding it, deleting it, the calendar and the policy are panel-only use cases for
//! an owner or manager human (`control::human_approver`). One exception (D5, D17): an agent may
//! set the permission of an AI image it adds while the image depicts nothing.
//!
//! Every change to an olay, a material, the calendar or the policy holds the Studio control lock,
//! the publisher's fence, so it never interleaves with a publish. Ledger entries name ids, codes,
//! tag keys and kinds, never the owner's words (titles, notes, places, client names, texts).
mod calendar;
mod items;
mod kvkk;
mod olays;
mod shoots;

pub use calendar::*;
pub use items::*;
pub(crate) use kvkk::erase_person;
pub use olays::*;
pub use shoots::*;

use super::chain::active;
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::TenantRepos,
    usecases::Deps,
};
use jt_ledger::Actor;
use jt_studio::StudioError;
use jt_tenancy::{Permission, UserId};
use serde::{Deserialize, Deserializer};
use serde_json::json;
use uuid::Uuid;

/// A tenant bundle for a library use case: the caller holds `studio.work` and the workspace is
/// active.
pub(crate) async fn open(d: &Deps, ctx: &Ctx) -> Result<Box<dyn TenantRepos>, AppError> {
    ctx.require(Permission::StudioWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    active(r.as_mut()).await?;
    Ok(r)
}

/// Whether the caller is an agent (its own actor, or a person's key used through a connection).
pub(crate) fn is_agent(ctx: &Ctx) -> bool {
    matches!(ctx.actor, Actor::Agent { .. }) || ctx.agent_connection_id.is_some()
}

/// The person calling in person, not through an agent.
pub(crate) fn person(ctx: &Ctx) -> Option<UserId> {
    match ctx.actor {
        Actor::Human { user_id } if !is_agent(ctx) => Some(user_id),
        _ => None,
    }
}

/// The owner or manager deciding in person (D4), when the caller is one.
pub(crate) fn decider(ctx: &Ctx) -> Option<UserId> {
    super::control::human_approver(ctx).ok()
}

/// `VALIDATION` naming the field a library rule refused.
pub(crate) fn invalid(e: StudioError) -> AppError {
    let field = match &e {
        StudioError::InvalidMaterial(f) | StudioError::InvalidIdentity(f) => *f,
        StudioError::RevisionConflict => "revision",
        _ => "input",
    };
    AppError::validation(e.to_string(), json!({ "field": field }))
}

/// `VALIDATION` on `field` with a closed `reason`.
pub(crate) fn refused(field: &str, reason: &str, message: &str) -> AppError {
    AppError::validation(
        message.to_owned(),
        json!({ "field": field, "reason": reason }),
    )
}

/// `FORBIDDEN` `human_required`: only a person in the panel (not an agent) may do it.
pub(crate) fn person_required(field: &str) -> AppError {
    AppError {
        code: ErrorCode::Forbidden,
        message: "a person must decide this in the panel".into(),
        details: json!({ "reason": "human_required", "field": field }),
    }
}

/// `CONFLICT` with a closed `reason`.
pub(crate) fn conflict(reason: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: reason.into(),
        details: json!({ "reason": reason }),
    }
}

/// Each person of `people` exists and is not erased (`NOT_FOUND`, `CONFLICT` `person_erased`).
/// The caller holds the inbox's workspace lock, so no erasure runs meanwhile.
pub(crate) async fn check_people(
    r: &mut dyn TenantRepos,
    people: impl IntoIterator<Item = Uuid>,
) -> Result<(), AppError> {
    for p in people {
        crate::usecases::inbox::erasure::check_person(r, jt_inbox::PersonId(p)).await?;
    }
    Ok(())
}

/// A field that may be absent (unchanged), `null` (cleared) or a value (set): `Some(None)` is
/// `null`.
pub(crate) fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}
