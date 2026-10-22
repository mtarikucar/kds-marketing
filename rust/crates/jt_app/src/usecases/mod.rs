//! Use cases: the application's operations. Each is a function over [`Deps`] (plus a `Ctx` once
//! it is scoped to a workspace) that adapters call from the panel or the MCP gate.
//!
//! A use case scoped to a workspace takes its time from `Ctx::now` (fixed when the request was
//! authenticated) and reaches workspace data only through tenant bundles of `Ctx::workspace_id`;
//! the others read the `Clock`.

pub mod agents;
pub mod api_keys;
pub mod auth;
pub mod budget;
pub mod capabilities;
pub mod groups;
pub mod ledger;
pub mod platform;
pub mod roles;
pub mod strategy;
pub mod team;
pub mod workspace;

use std::collections::BTreeSet;
use std::fmt::{Display, Write as _};
use std::sync::Arc;

use jt_ledger::{Action, Actor, LedgerEntry, Subject};
use jt_tenancy::{Permission, TenancyError, UserId};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{
    ChannelCatalog, Clock, IdGen, PasswordHasher, SecretBox, StrategyArchivedHook,
    TenantHostRegistry, TokenGen, UnitOfWork,
};

/// The ports a use case may call, built once by the binary (or a test) and shared by every
/// adapter.
#[derive(Clone)]
pub struct Deps {
    pub uow: Arc<dyn UnitOfWork>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGen>,
    pub tokens: Arc<dyn TokenGen>,
    pub hasher: Arc<dyn PasswordHasher>,
    /// Seals connector secrets per workspace.
    pub seal: Arc<dyn SecretBox>,
    /// The channel kinds a workspace has, against which a strategy's channels are checked.
    pub channels: Arc<dyn ChannelCatalog>,
    /// Told after an approved strategy version is archived.
    pub archived_hook: Arc<dyn StrategyArchivedHook>,
    /// The hosts each workspace's connectors may reach: the egress allowlist's tenant tier.
    pub hosts: Arc<dyn TenantHostRegistry>,
}

/// The stored form of a secret token (a session, invite or API-key token): the lowercase hex
/// SHA-256 of its text. A fast hash suffices because the tokens are long random values, and a
/// deterministic one is needed so the token can be looked up by it.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        // Writing into a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// The ledger action called `name`; a name that is not a valid action is a programming error.
pub(crate) fn action(name: &str) -> Result<Action, AppError> {
    Action::new(name).map_err(|e| AppError::internal(e.to_string()))
}

/// The ledger entry of a tenant-scoped use case: in the context's workspace, by its actor, at
/// its time, about the `kind` with this `id`.
pub(crate) fn ledger_entry(
    ctx: &Ctx,
    name: &str,
    kind: &str,
    id: impl Display,
    payload: Value,
) -> Result<LedgerEntry, AppError> {
    let mut entry = LedgerEntry::new(
        ctx.workspace_id,
        ctx.actor.clone(),
        action(name)?,
        payload,
        ctx.now,
    );
    entry.subject = Some(Subject {
        kind: kind.to_owned(),
        id: id.to_string(),
    });
    Ok(entry)
}

/// The error for a refusal by a `jt_tenancy` role rule:
/// - `Forbidden`: `FORBIDDEN` naming `team.manage` in `details.permission`, as `Ctx::require`;
/// - `OwnerOnly`: `FORBIDDEN` with `details.reason = "owner_only"`;
/// - `ExceedsOwnAuthority`: `FORBIDDEN` with `details.reason = "exceeds_own_authority"` and the
///   missing permission keys in `details.missing`;
/// - `LastOwner`: `CONFLICT` with `details.reason = "last_owner"`.
pub(crate) fn refusal(ctx: &Ctx, e: TenancyError) -> AppError {
    let message = e.to_string();
    let (code, details) = match e {
        TenancyError::Forbidden => {
            if let Err(missing) = ctx.require(Permission::TeamManage) {
                return missing;
            }
            (ErrorCode::Forbidden, json!({}))
        }
        TenancyError::OwnerOnly => (ErrorCode::Forbidden, json!({ "reason": "owner_only" })),
        TenancyError::ExceedsOwnAuthority { missing } => {
            let missing: Vec<&str> = missing.iter().map(Permission::key).collect();
            (
                ErrorCode::Forbidden,
                json!({ "reason": "exceeds_own_authority", "missing": missing }),
            )
        }
        TenancyError::LastOwner => (ErrorCode::Conflict, json!({ "reason": "last_owner" })),
    };
    AppError {
        code,
        message,
        details,
    }
}

/// `VALIDATION` naming `field` in `details.field`.
pub(crate) fn invalid(field: &str, message: &str) -> AppError {
    AppError::validation(message, json!({ "field": field }))
}

/// A keyset cursor `(at, id)` from the two halves a caller sends: `before_at`, an RFC 3339 time
/// as the previous page's last entry's `at` reads, and `before_id`, that entry's id. Both or
/// neither, else `VALIDATION` naming the missing one; a `before_at` that does not parse is
/// `VALIDATION` naming it.
pub(crate) fn keyset_cursor<I>(
    before_at: Option<&str>,
    before_id: Option<I>,
) -> Result<Option<(OffsetDateTime, I)>, AppError> {
    match (before_at, before_id) {
        (None, None) => Ok(None),
        (Some(at), Some(id)) => {
            let at = OffsetDateTime::parse(at, &Rfc3339).map_err(|_| {
                invalid(
                    "before_at",
                    "before_at must be an RFC 3339 time, as an entry's `at` reads",
                )
            })?;
            Ok(Some((at, id)))
        }
        (Some(_), None) => Err(invalid("before_id", "before_id must come with before_at")),
        (None, Some(_)) => Err(invalid("before_at", "before_at must come with before_id")),
    }
}

/// `raw` trimmed, or `VALIDATION` when nothing is left.
pub(crate) fn required(field: &str, raw: &str) -> Result<String, AppError> {
    match raw.trim() {
        "" => Err(invalid(field, &format!("{field} must not be empty"))),
        trimmed => Ok(trimmed.to_owned()),
    }
}

/// The permissions named by `raw`; `VALIDATION` listing every unknown key, in input order and
/// once each, in `details.unknown`.
pub(crate) fn parse_permissions(raw: &[String]) -> Result<BTreeSet<Permission>, AppError> {
    let mut permissions = BTreeSet::new();
    let mut unknown: Vec<&str> = Vec::new();
    for key in raw {
        match Permission::parse(key) {
            Some(p) => {
                permissions.insert(p);
            }
            None if !unknown.contains(&key.as_str()) => unknown.push(key),
            None => {}
        }
    }
    if unknown.is_empty() {
        Ok(permissions)
    } else {
        Err(AppError::validation(
            "unknown permissions",
            json!({ "unknown": unknown }),
        ))
    }
}

/// The keys of a permission set, in the set's order.
pub(crate) fn permission_keys(permissions: &BTreeSet<Permission>) -> Vec<&'static str> {
    permissions.iter().map(Permission::key).collect()
}

/// The user behind an actor: the human, or the user who issued an agent's key. A system
/// component has none.
pub(crate) fn acting_user(actor: &Actor) -> Option<UserId> {
    match actor {
        Actor::Human { user_id } | Actor::Agent { user_id, .. } => Some(*user_id),
        Actor::System { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_token_is_hex_sha256() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_token("").len(), 64);
    }
}
