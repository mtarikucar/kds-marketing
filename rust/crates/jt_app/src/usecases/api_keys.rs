//! The workspace's API keys: `api_keys.create`, `api_keys.list` and `api_keys.revoke`, plus
//! authenticating a bearer key into an [`AgentPrincipal`] and the [`Ctx`] of an agent acting
//! through it.
//!
//! A key is [`KEY_PREFIX`] followed by [`KEY_TOKEN_BYTES`] random bytes (base64url, no padding).
//! `create` hands the plaintext out once; only its [`hash_token`] is stored, with its first
//! [`DISPLAY_PREFIX_CHARS`] characters kept as a display prefix. Neither the plaintext nor the
//! hash ever enters the ledger or any other answer.
//!
//! A key's scopes are fixed when it is issued and must be among the issuer's own permissions.
//! Each authentication then narrows them to what the issuer still holds: a key acts with
//! `scopes ∩ issuer's current permissions`, and only while the issuer is an active member of the
//! key's workspace, so demoting or removing the issuer takes effect at the key's next call.

use std::collections::BTreeSet;
use std::fmt;

use jt_ledger::Actor;
use jt_tenancy::{
    AgentConnectionId, ApiKeyId, MembershipStatus, Permission, TenancyError, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use super::{
    Deps, acting_user, hash_token, invalid, ledger_entry, parse_permissions, permission_keys,
    refusal, required,
};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::{ApiKeyRow, ApiKeyStatus};

/// What every API key starts with.
pub const KEY_PREFIX: &str = "jt_live_";
/// Random bytes in an API key, after [`KEY_PREFIX`].
pub const KEY_TOKEN_BYTES: usize = 32;
/// Characters of the plaintext kept, and shown, as the key's prefix.
pub const DISPLAY_PREFIX_CHARS: usize = 12;
/// The longest key name, in characters.
pub const NAME_MAX: usize = 64;

/// The single answer to every bearer key that cannot be used, so it never tells why.
const INVALID_KEY: &str = "invalid api key";
const NO_SUCH_KEY: &str = "no such API key";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// What issuing a key asks for. `scopes` are permission keys such as `"team.manage"`; duplicates
/// collapse, and none at all means every permission of the issuer.
#[derive(Clone, Debug, Deserialize)]
pub struct CreateKey {
    pub name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// A newly issued key. `Debug` masks the plaintext.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct KeyOut {
    pub id: ApiKeyId,
    pub name: String,
    /// The first [`DISPLAY_PREFIX_CHARS`] characters of the plaintext.
    pub prefix: String,
    /// The key itself: handed out here once and never stored.
    pub plaintext: String,
    pub scopes: BTreeSet<Permission>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

impl fmt::Debug for KeyOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyOut")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("prefix", &self.prefix)
            .field("plaintext", &"***")
            .field("scopes", &self.scopes)
            .field("created_at", &self.created_at)
            .finish()
    }
}

/// A key as the key list shows it: never its plaintext or hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct KeySummary {
    pub id: ApiKeyId,
    pub name: String,
    pub prefix: String,
    /// The scopes it was issued with; it acts with those its issuer still holds.
    pub scopes: BTreeSet<Permission>,
    pub status: ApiKeyStatus,
    pub issued_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_used_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub revoked_at: Option<OffsetDateTime>,
}

impl From<ApiKeyRow> for KeySummary {
    fn from(row: ApiKeyRow) -> Self {
        KeySummary {
            id: row.id,
            name: row.name,
            prefix: row.prefix,
            scopes: row.scopes,
            status: row.status,
            issued_by: row.issued_by,
            created_at: row.created_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
        }
    }
}

/// The key behind a bearer token, resolved for one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPrincipal {
    pub workspace_id: WorkspaceId,
    pub api_key_id: ApiKeyId,
    /// The user who issued the key, on whose authority the agent acts.
    pub issued_by: UserId,
    /// The key of the issuer's current role in the workspace.
    pub issuer_role_key: String,
    /// The key's effective scopes: its scopes that the issuer still holds.
    pub permissions: BTreeSet<Permission>,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// Issues a key in the context's workspace and returns it with its plaintext, the only time the
/// plaintext is ever shown. Needs `api_keys.manage`.
///
/// The name is trimmed and must be 1 to [`NAME_MAX`] characters, else `VALIDATION` with
/// `details.field = "name"`. Unknown scope keys are `VALIDATION` listing them in
/// `details.unknown`; scopes the caller does not hold are `FORBIDDEN` with
/// `details.reason = "exceeds_own_authority"` and the missing keys in `details.missing`. No
/// scopes at all means every permission the caller holds. The key is issued by the user behind
/// the caller (for an agent, its key's issuer). Writes `api_keys.create` (payload `name`,
/// `prefix`, `scopes`).
pub async fn create(deps: &Deps, ctx: &Ctx, input: CreateKey) -> Result<KeyOut, AppError> {
    ctx.require(Permission::ApiKeysManage)?;
    let name = required("name", &input.name)?;
    if name.chars().count() > NAME_MAX {
        return Err(invalid(
            "name",
            &format!("name must be at most {NAME_MAX} characters"),
        ));
    }
    let requested = parse_permissions(&input.scopes)?;
    let scopes = if requested.is_empty() {
        ctx.permissions.clone()
    } else {
        within_own_permissions(ctx, requested)?
    };
    let issued_by = acting_user(&ctx.actor)
        .ok_or_else(|| AppError::forbidden("only a user or an agent can issue an API key"))?;

    let plaintext = format!("{KEY_PREFIX}{}", deps.tokens.token(KEY_TOKEN_BYTES));
    let prefix: String = plaintext.chars().take(DISPLAY_PREFIX_CHARS).collect();
    let id = ApiKeyId(deps.ids.uuid());
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos
        .api_keys()
        .insert(ApiKeyRow {
            id,
            workspace_id: ctx.workspace_id,
            name: name.clone(),
            prefix: prefix.clone(),
            key_hash: hash_token(&plaintext),
            scopes: scopes.clone(),
            issued_by,
            status: ApiKeyStatus::Active,
            created_at: ctx.now,
            last_used_at: None,
            revoked_at: None,
        })
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "api_keys.create",
            "api_key",
            id,
            json!({ "name": name, "prefix": prefix, "scopes": permission_keys(&scopes) }),
        )?)
        .await?;
    repos.commit().await?;
    Ok(KeyOut {
        id,
        name,
        prefix,
        plaintext,
        scopes,
        created_at: ctx.now,
    })
}

/// The workspace's keys, active and revoked, oldest first. Needs `api_keys.manage`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<KeySummary>, AppError> {
    ctx.require(Permission::ApiKeysManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let keys = repos.api_keys().list().await?;
    Ok(keys.into_iter().map(KeySummary::from).collect())
}

/// Revokes the key `key_id` at the context's time; it authenticates no more. Needs
/// `api_keys.manage`.
///
/// A key that is not this workspace's is `NOT_FOUND`; one already revoked is `CONFLICT`. Writes
/// `api_keys.revoke` (payload `name`, `prefix`).
pub async fn revoke(deps: &Deps, ctx: &Ctx, key_id: ApiKeyId) -> Result<(), AppError> {
    ctx.require(Permission::ApiKeysManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let key = repos
        .api_keys()
        .list()
        .await?
        .into_iter()
        .find(|k| k.id == key_id)
        .ok_or_else(|| AppError::not_found(NO_SUCH_KEY))?;
    if key.status == ApiKeyStatus::Revoked {
        return Err(AppError::conflict("the API key is already revoked"));
    }
    repos.api_keys().revoke(key_id, ctx.now).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "api_keys.revoke",
            "api_key",
            key_id,
            json!({ "name": key.name, "prefix": key.prefix }),
        )?)
        .await?;
    repos.commit().await
}

/// The principal behind a bearer key, at the clock's time.
///
/// The key must start with [`KEY_PREFIX`], be known by its hash, be active, and have been issued
/// by a user who is still an active member of its workspace; otherwise `UNAUTHENTICATED`, always
/// with the same message. The principal acts with the key's scopes that the issuer's current
/// role still grants, and under that role's key. The key's `last_used_at` is set to now.
pub async fn authenticate(deps: &Deps, bearer: &str) -> Result<AgentPrincipal, AppError> {
    if !bearer.starts_with(KEY_PREFIX) {
        return Err(invalid_key());
    }
    // The key is found in a platform-wide transaction of its own: its workspace is not yet known.
    let found = {
        let mut platform = deps.uow.platform().await?;
        platform.api_key_find_by_hash(&hash_token(bearer)).await?
    };
    let key = found
        .filter(|k| k.status == ApiKeyStatus::Active)
        .ok_or_else(invalid_key)?;

    let now = deps.clock.now();
    let mut repos = deps.uow.tenant(key.workspace_id).await?;
    let membership = repos
        .memberships()
        .find_by_user(key.issued_by)
        .await?
        .filter(|m| m.status == MembershipStatus::Active)
        .ok_or_else(invalid_key)?;
    let role = repos
        .roles()
        .find(membership.role_id)
        .await?
        .ok_or_else(|| AppError::internal("membership refers to a missing role"))?;
    let permissions = key
        .scopes
        .intersection(&role.permissions)
        .copied()
        .collect();
    repos.api_keys().touch_last_used(key.id, now).await?;
    repos.commit().await?;
    Ok(AgentPrincipal {
        workspace_id: key.workspace_id,
        api_key_id: key.id,
        issued_by: key.issued_by,
        issuer_role_key: role.key,
        permissions,
    })
}

/// The context of a call an agent makes at `now` through connection `connection_id` with the
/// key behind `p`: an agent actor on the issuer's authority, with the key's effective scopes and
/// the issuer's role key (so an owner's agent counts as an owner, within its scopes).
pub fn ctx_for_agent(
    p: &AgentPrincipal,
    connection_id: AgentConnectionId,
    now: OffsetDateTime,
) -> Ctx {
    Ctx {
        workspace_id: p.workspace_id,
        actor: Actor::Agent {
            connection_id,
            user_id: p.issued_by,
        },
        permissions: p.permissions.clone(),
        role_key: Some(p.issuer_role_key.clone()),
        now,
        agent_connection_id: Some(connection_id),
    }
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/// `requested`, when the caller holds every permission in it; else `FORBIDDEN` as [`refusal`]
/// gives `ExceedsOwnAuthority`, naming the missing keys.
fn within_own_permissions(
    ctx: &Ctx,
    requested: BTreeSet<Permission>,
) -> Result<BTreeSet<Permission>, AppError> {
    let missing: BTreeSet<Permission> = requested.difference(&ctx.permissions).copied().collect();
    if missing.is_empty() {
        return Ok(requested);
    }
    let mut err = refusal(ctx, TenancyError::ExceedsOwnAuthority { missing });
    "the scopes include permissions the issuer does not hold".clone_into(&mut err.message);
    Err(err)
}

fn invalid_key() -> AppError {
    AppError::unauthenticated(INVALID_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plaintext_is_masked_in_debug_output() {
        let key = KeyOut {
            id: ApiKeyId::new_v7(),
            name: "CI".into(),
            prefix: "jt_live_abcd".into(),
            plaintext: "jt_live_abcdefs3cret".into(),
            scopes: BTreeSet::new(),
            created_at: OffsetDateTime::UNIX_EPOCH,
        };
        let text = format!("{key:?}");
        assert!(!text.contains("s3cret"), "{text}");
        assert!(text.contains("jt_live_abcd"), "{text}");
    }
}
