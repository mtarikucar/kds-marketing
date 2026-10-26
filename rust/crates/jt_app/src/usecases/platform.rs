//! The platform operator: bootstrapping the first operator, logging in, resolving an operator
//! session into a [`PlatformCtx`], listing every workspace and changing a workspace's status.
//!
//! Operators are not users: they live in their own table, sign in with their own sessions and
//! reach workspaces only through platform bundles. An operator session token is
//! [`PLATFORM_TOKEN_BYTES`] random bytes (base64url) handed to the client once; only its
//! [`hash_token`] is stored. A session lasts [`PLATFORM_SESSION_LIFETIME`] from the moment it is
//! opened.
//!
//! Changing a workspace's status is what opens (or closes) the strategy gate's first check:
//! `check_gate` refuses `Gated` use cases with `WORKSPACE_INACTIVE` unless the workspace is
//! `Active`. API keys are left alone on suspension; they are checked on every request, and
//! `Exempt` use cases keep working by design.

use std::cmp::Reverse;
use std::fmt;

use jt_ledger::Actor;
use jt_tenancy::{Email, OperatorId, WorkspaceId, WorkspaceStatus};
use serde::Serialize;
use time::{Duration, OffsetDateTime};

use super::auth::LoginInput;
use super::{Deps, hash_token, invalid};
use crate::ctx::PlatformCtx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{OperatorRow, PlatformRepos, PlatformSessionRow, WorkspaceRow};

/// How long an operator session lasts from the moment it is opened.
pub const PLATFORM_SESSION_LIFETIME: Duration = Duration::hours(12);
/// The shortest acceptable operator password, counted in characters.
pub const MIN_OPERATOR_PASSWORD_CHARS: usize = 12;
/// Random bytes in an operator session token.
pub const PLATFORM_TOKEN_BYTES: usize = 32;

/// The single answer to every failed operator login, so it never reveals whether an email
/// belongs to an operator.
const INVALID_CREDENTIALS: &str = "invalid credentials";
/// The single answer to every unusable operator session token.
const INVALID_SESSION: &str = "the platform session is invalid or has expired";

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

/// A newly opened operator session. `Debug` masks the token.
#[derive(Clone, PartialEq, Eq)]
pub struct PlatformSessionOut {
    /// The plaintext token ([`PLATFORM_TOKEN_BYTES`] random bytes, base64url): handed to the
    /// client once and never stored.
    pub token: String,
    pub expires_at: OffsetDateTime,
}

impl fmt::Debug for PlatformSessionOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlatformSessionOut")
            .field("token", &"***")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// A workspace as the platform console shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WorkspaceAdminOut {
    pub id: WorkspaceId,
    pub name: String,
    pub slug: String,
    pub status: WorkspaceStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// The email of the workspace's oldest active owner, if it has one.
    pub owner_email: Option<Email>,
    /// Active memberships in the workspace.
    pub member_count: i64,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// Creates the first platform operator, unless one already exists. Returns whether it created
/// one; once any operator exists it is a successful no-op, whichever email it names, so the
/// binary can call it at every start.
///
/// The email is normalised by `Email::parse` and the password needs at least
/// [`MIN_OPERATOR_PASSWORD_CHARS`] characters; each refusal is `VALIDATION` with
/// `details.field` naming the input, checked before anything is read.
pub async fn bootstrap(deps: &Deps, email: &str, password: &str) -> Result<bool, AppError> {
    let email = Email::parse(email).map_err(|e| invalid("email", &e.to_string()))?;
    if password.chars().count() < MIN_OPERATOR_PASSWORD_CHARS {
        return Err(invalid(
            "password",
            &format!("password must be at least {MIN_OPERATOR_PASSWORD_CHARS} characters"),
        ));
    }
    // A cheap check first, so a start with an operator in place spends no password hash.
    if operator_exists(deps.uow.platform().await?.as_mut()).await? {
        return Ok(false);
    }
    // Hashing is slow and needs no connection, so it runs between the transactions.
    let password_hash = deps.hasher.hash(password).await?;

    let mut repos = deps.uow.platform().await?;
    if operator_exists(repos.as_mut()).await? {
        return Ok(false);
    }
    let inserted = repos
        .operators()
        .insert(OperatorRow {
            id: OperatorId(deps.ids.uuid()),
            email,
            password_hash,
            created_at: deps.clock.now(),
        })
        .await;
    match inserted {
        Ok(()) => {}
        // A concurrent bootstrap stored the same email first: an operator exists.
        Err(e) if e.code == ErrorCode::Conflict => return Ok(false),
        Err(e) => return Err(e),
    }
    repos.commit().await?;
    Ok(true)
}

/// Opens an operator session for this email and password.
///
/// An unknown email, a wrong password and a malformed email are all `UNAUTHENTICATED` with the
/// same message, and an unknown email still costs one password hash, so neither the answer nor
/// (roughly) its timing tells whether the email belongs to an operator. A user's (tenant's)
/// credentials are not an operator's.
pub async fn login(deps: &Deps, input: LoginInput) -> Result<PlatformSessionOut, AppError> {
    let Ok(email) = Email::parse(&input.email) else {
        return Err(invalid_credentials());
    };
    // The operator is read in a transaction of its own, closed before the slow verification.
    let operator = {
        let mut repos = deps.uow.platform().await?;
        repos.operators().find_by_email(&email).await?
    };
    let Some(operator) = operator else {
        // The hash is discarded: it only spends the time a verification would.
        let _ = deps.hasher.hash(&input.password).await;
        return Err(invalid_credentials());
    };
    if !deps
        .hasher
        .verify(&input.password, &operator.password_hash)
        .await?
    {
        return Err(invalid_credentials());
    }

    let now = deps.clock.now();
    let token = deps.tokens.token(PLATFORM_TOKEN_BYTES);
    let expires_at = now + PLATFORM_SESSION_LIFETIME;
    let mut repos = deps.uow.platform().await?;
    repos
        .platform_sessions()
        .insert(PlatformSessionRow {
            id: deps.ids.uuid(),
            operator_id: operator.id,
            token_hash: hash_token(&token),
            created_at: now,
            expires_at,
        })
        .await?;
    repos.commit().await?;
    Ok(PlatformSessionOut { token, expires_at })
}

/// The context of the operator behind a platform session token, at the clock's time. An unknown
/// or expired (`expires_at` not after now) token is `UNAUTHENTICATED`, always with the same
/// message; a user's session token is unknown here.
pub async fn resolve(deps: &Deps, token: &str) -> Result<PlatformCtx, AppError> {
    let now = deps.clock.now();
    let mut repos = deps.uow.platform().await?;
    let session = repos
        .platform_sessions()
        .find_by_token_hash(&hash_token(token))
        .await?
        .filter(|s| s.expires_at > now)
        .ok_or_else(invalid_session)?;
    Ok(PlatformCtx {
        operator_id: session.operator_id,
        now,
    })
}

/// Every workspace, newest first, with its owner's email and its member count. The context only
/// proves a signed-in operator; nothing in it narrows the list.
pub async fn list_workspaces(
    deps: &Deps,
    _pctx: &PlatformCtx,
) -> Result<Vec<WorkspaceAdminOut>, AppError> {
    let mut repos = deps.uow.platform().await?;
    let mut rows = repos.workspaces_list().await?;
    rows.sort_by_key(|w| Reverse((w.created_at, w.id)));
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(admin_view(repos.as_mut(), row).await?);
    }
    Ok(out)
}

/// Active → suspended; never closes or creates an entitlement.
pub async fn suspend(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    reason_text: &str,
) -> Result<WorkspaceAdminOut, AppError> {
    let reason = reason(reason_text)?;
    transition(deps, pctx, ws, WorkspaceStatus::Suspended, reason).await
}

/// Suspended → active only with an activated, unrevoked entitlement.
pub async fn resume(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
) -> Result<WorkspaceAdminOut, AppError> {
    transition(
        deps,
        pctx,
        ws,
        WorkspaceStatus::Active,
        "platform.workspace_resume",
    )
    .await
}

async fn transition(
    deps: &Deps,
    pctx: &PlatformCtx,
    ws: WorkspaceId,
    status: WorkspaceStatus,
    reason: &str,
) -> Result<WorkspaceAdminOut, AppError> {
    let mut repos = deps.uow.platform().await?;
    let mut row = repos.workspace_lock(ws).await?;
    let grant = repos.entitlement_get(ws).await?;
    if row.status == status {
        return admin_view(&mut *repos, row).await;
    }
    if row.status == WorkspaceStatus::PendingPayment {
        return Err(AppError::conflict(
            "pending workspace requires payment activation",
        ));
    }
    if status == WorkspaceStatus::Active && grant.is_none_or(|g| g.activated_at.is_none()) {
        return Err(AppError::conflict("activated open entitlement required"));
    }
    repos
        .workspace_set_status(ws, status, reason, &actor(pctx))
        .await?;
    row.status = status;
    let out = admin_view(&mut *repos, row).await?;
    repos.commit().await?;
    Ok(out)
}

pub(crate) fn actor(pctx: &PlatformCtx) -> Actor {
    Actor::System {
        component: format!("platform_operator:{}", pctx.operator_id),
    }
}

pub(crate) fn reason(reason: &str) -> Result<&str, AppError> {
    let reason = reason.trim();
    if reason.is_empty() || reason.chars().count() > 500 {
        return Err(invalid("reason", "reason must contain 1 to 500 characters"));
    }
    Ok(reason)
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

async fn operator_exists(repos: &mut dyn PlatformRepos) -> Result<bool, AppError> {
    Ok(repos.operators().count().await? > 0)
}

/// `row` with its owner's email and member count, read through `repos`.
pub(crate) async fn admin_view(
    repos: &mut dyn PlatformRepos,
    row: WorkspaceRow,
) -> Result<WorkspaceAdminOut, AppError> {
    let owner_email = repos.workspace_owner_email(row.id).await?;
    let member_count = repos.workspace_member_count(row.id).await?;
    Ok(WorkspaceAdminOut {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        created_at: row.created_at,
        owner_email,
        member_count,
    })
}

fn invalid_credentials() -> AppError {
    AppError::unauthenticated(INVALID_CREDENTIALS)
}

fn invalid_session() -> AppError {
    AppError::unauthenticated(INVALID_SESSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_token_is_masked_in_debug_output() {
        let out = PlatformSessionOut {
            token: "secret-token".into(),
            expires_at: OffsetDateTime::UNIX_EPOCH,
        };
        assert!(!format!("{out:?}").contains("secret-token"));
    }
}
