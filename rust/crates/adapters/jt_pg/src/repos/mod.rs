//! Repositories: the SQL behind every `jt_app::ports` repo trait.
//!
//! The bundles of [`crate::uow`] implement the repo traits themselves (each accessor returns the
//! bundle), so every file here holds one table's statements: `impl <Repo> for Pg<Bundle>Repos`,
//! plus the platform-wide or user-level functions the bundles call. Statements run on the bundle's
//! scoped transaction ([`crate::TenantTx`], [`crate::PlatformTx`] or [`crate::UserTx`]).
//!
//! Rules every statement keeps:
//! - A statement on a tenant table (`roles`, `memberships`, `api_keys`, `agent_connections`,
//!   `ledger_entries`) names `workspace_id`, and one on `workspaces` names its `id`, even though
//!   row-level security scopes it too.
//! - A statement that runs with `app.platform = 'on'` (the platform and user bundles) is preceded
//!   by the line `// archtest: platform-wide`.
//! - Inserts use `on conflict do nothing` and report a skipped row as `CONFLICT`, so an expected
//!   clash does not abort the transaction; any other database error does, and the bundle's
//!   `commit` then reports it instead of letting Postgres roll back silently.
//! - Timestamps come from the caller; column defaults are never relied on.

mod agent_connections;
pub(crate) mod api_keys;
pub(crate) mod ledger;
pub(crate) mod memberships;
mod operators;
pub(crate) mod roles;
mod sessions;
mod users;
pub(crate) mod workspaces;

use std::collections::BTreeSet;

use jt_app::error::AppError;
use jt_tenancy::{Email, Permission, WorkspaceId};

/// SQLSTATE of a unique violation.
const UNIQUE_VIOLATION: &str = "23505";
/// SQLSTATE of a foreign-key violation.
pub(crate) const FOREIGN_KEY_VIOLATION: &str = "23503";

/// Maps an error from the statement described by `what` (e.g. `"insert role"`) to an `AppError`.
///
/// - A unique violation (`23505`) is `CONFLICT`.
/// - A foreign-key violation (`23503`) on a role, user or workspace reference, which the caller
///   supplied, is `NOT_FOUND`; any other foreign-key violation is `INTERNAL`.
/// - Anything else is `INTERNAL` with the database's message. The message never carries the
///   statement's parameters (Postgres puts offending values in the error's detail, unused here).
pub fn map_sqlx(err: sqlx::Error, what: &str) -> AppError {
    let Some(db) = err.as_database_error() else {
        return AppError::internal(format!("{what}: {err}"));
    };
    match db.code().as_deref() {
        Some(UNIQUE_VIOLATION) => AppError::conflict(format!("{what}: the value is already taken")),
        Some(FOREIGN_KEY_VIOLATION) => match referenced_kind(db.constraint()) {
            Some(kind) => AppError::not_found(format!("{what}: no such {kind}")),
            None => AppError::internal(format!("{what}: {}", db.message())),
        },
        _ => AppError::internal(format!("{what}: {}", db.message())),
    }
}

/// What a foreign-key constraint of migration 0001 references, when it is a role, a user or a
/// workspace (Postgres names them `<table>_<column>_fkey`).
fn referenced_kind(constraint: Option<&str>) -> Option<&'static str> {
    let c = constraint?;
    if c.ends_with("_role_id_fkey") {
        Some("role")
    } else if c.ends_with("_workspace_id_fkey") {
        Some("workspace")
    } else if c.ends_with("_user_id_fkey")
        || c.ends_with("_invited_by_fkey")
        || c.ends_with("_issued_by_fkey")
    {
        Some("user")
    } else {
        None
    }
}

/// `INTERNAL` when a row for `row_ws` is handed to the tenant bundle of `bundle_ws`: a
/// programming error, refused before anything is written.
pub(crate) fn same_workspace(bundle_ws: WorkspaceId, row_ws: WorkspaceId) -> Result<(), AppError> {
    if bundle_ws == row_ws {
        Ok(())
    } else {
        Err(AppError::internal(format!(
            "a row for workspace {row_ws} was given to the bundle of workspace {bundle_ws}"
        )))
    }
}

/// `INTERNAL` for a reference to a row that does not exist (or not in this workspace).
pub(crate) fn dangling(reference: &str) -> AppError {
    AppError::internal(format!("{reference} references a row that does not exist"))
}

/// The stored keys of a permission set.
pub(crate) fn permission_keys(permissions: &BTreeSet<Permission>) -> Vec<&'static str> {
    permissions.iter().map(Permission::key).collect()
}

/// The permissions named by stored keys. An unknown key (e.g. one a later version retired) is
/// skipped with a warning rather than failing the read.
pub(crate) fn permissions_from(keys: Vec<String>, column: &str) -> BTreeSet<Permission> {
    keys.into_iter()
        .filter_map(|key| {
            let parsed = Permission::parse(&key);
            if parsed.is_none() {
                tracing::warn!(column, key = %key, "skipping an unknown stored permission key");
            }
            parsed
        })
        .collect()
}

/// A stored email, normalised; `INTERNAL` if it is not a valid address.
pub(crate) fn stored_email(raw: &str, column: &str) -> Result<Email, AppError> {
    Email::parse(raw)
        .map_err(|_| AppError::internal(format!("stored {column} is not a valid email")))
}

/// A stored enum value parsed with its `parse`; `INTERNAL` if the value is unknown.
pub(crate) fn stored<T>(parsed: Option<T>, column: &str) -> Result<T, AppError> {
    parsed.ok_or_else(|| AppError::internal(format!("stored {column} has an unknown value")))
}
