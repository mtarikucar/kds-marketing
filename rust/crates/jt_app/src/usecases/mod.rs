//! Use cases: the application's operations. Each is a function over [`Deps`] (plus a `Ctx` once
//! it is scoped to a workspace) that adapters call from the panel or the MCP gate.
//!
//! A use case scoped to a workspace takes its time from `Ctx::now` (fixed when the request was
//! authenticated) and reaches workspace data only through tenant bundles of `Ctx::workspace_id`;
//! the others read the `Clock`.

pub mod auth;
pub mod roles;
pub mod team;
pub mod workspace;

use std::fmt::{Display, Write as _};
use std::sync::Arc;

use jt_ledger::{Action, LedgerEntry, Subject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::{Clock, IdGen, PasswordHasher, TokenGen, UnitOfWork};

/// The ports a use case may call, built once by the binary (or a test) and shared by every
/// adapter.
#[derive(Clone)]
pub struct Deps {
    pub uow: Arc<dyn UnitOfWork>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGen>,
    pub tokens: Arc<dyn TokenGen>,
    pub hasher: Arc<dyn PasswordHasher>,
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

/// `VALIDATION` naming `field` in `details.field`.
pub(crate) fn invalid(field: &str, message: &str) -> AppError {
    AppError::validation(message, json!({ "field": field }))
}

/// `raw` trimmed, or `VALIDATION` when nothing is left.
pub(crate) fn required(field: &str, raw: &str) -> Result<String, AppError> {
    match raw.trim() {
        "" => Err(invalid(field, &format!("{field} must not be empty"))),
        trimmed => Ok(trimmed.to_owned()),
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
