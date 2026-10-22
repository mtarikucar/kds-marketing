//! The workspace's team: `team.list`, `team.invite`, `team.accept_invite`, `team.set_role` and
//! `team.remove`.
//!
//! An invitation is an `Invited` membership that stores only the [`hash_token`] of a token of
//! [`INVITE_TOKEN_BYTES`] random bytes (base64url), open for [`INVITE_LIFETIME`]. `invite` hands
//! the plaintext token out once, for the inviter to pass on (the panel shows it as a link); it
//! never enters the ledger. An invitation binds to the invited email, not to whoever holds the
//! token: only a user with that email can accept it, and accepting spends the token.
//!
//! Who may give which role is `jt_tenancy`'s: only an owner gives the owner role or changes or
//! removes a membership holding it (else `FORBIDDEN`, `details.reason = "owner_only"`), and a
//! role given may carry only permissions the caller holds itself (else `FORBIDDEN`,
//! `details.reason = "exceeds_own_authority"` with the missing keys in `details.missing`).
//!
//! A workspace always keeps an owner: demoting or removing its last active owner is `CONFLICT`
//! with `details.reason = "last_owner"`. Every role change and removal first counts the active
//! owners with `count_active_owners`, which locks their memberships until the transaction ends,
//! so two concurrent changes cannot each leave the other's owner as the last one and then remove
//! it.

use std::fmt;

use jt_ledger::{Actor, LedgerEntry, Subject};
use jt_tenancy::{
    Email, MembershipId, MembershipStatus, Permission, RoleDef, RoleGrant, SystemRole,
    TenancyError, UserId, WorkspaceId, can_change_role, can_grant_role, can_remove_member,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};

use super::auth::{self, MIN_PASSWORD_CHARS, MeOut, Principal, SessionOut};
use super::{Deps, action, hash_token, invalid, ledger_entry, refusal, required};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{MemberOut, MembershipRow, MembershipView, UserRepos, UserRow};

/// How long an invitation stays open.
pub const INVITE_LIFETIME: Duration = Duration::days(7);
/// Random bytes in an invite token.
pub const INVITE_TOKEN_BYTES: usize = 32;

/// The single answer to an unknown, expired, spent or cancelled invite token, so the answer never
/// tells which.
const INVALID_INVITE: &str = "invite is not valid";
const ALREADY_A_MEMBER: &str = "already a member of this workspace";
const SIGN_IN_FIRST: &str = "sign in to accept this invite";
const NO_SUCH_MEMBERSHIP: &str = "no such membership";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// What an invitation asks for: who, and with which of the workspace's roles.
#[derive(Clone, Debug, Deserialize)]
pub struct InviteInput {
    pub email: String,
    pub role_key: String,
}

/// A new invitation. `Debug` masks the token.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct InviteOut {
    pub membership_id: MembershipId,
    /// The plaintext token ([`INVITE_TOKEN_BYTES`] random bytes, base64url): handed out here
    /// once and never stored.
    pub invite_token: String,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

impl fmt::Debug for InviteOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InviteOut")
            .field("membership_id", &self.membership_id)
            .field("invite_token", &"***")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// What accepting an invitation asks for. `Debug` masks the token and the password.
#[derive(Clone)]
pub struct AcceptInput<'a> {
    /// The plaintext invite token.
    pub token: String,
    /// The new account's password; needed, and read, only without `principal`.
    pub password: Option<String>,
    /// The new account's display name; needed, and read, only without `principal`.
    pub display_name: Option<String>,
    /// The signed-in user who accepts, if any.
    pub principal: Option<&'a Principal>,
}

impl fmt::Debug for AcceptInput<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AcceptInput")
            .field("token", &"***")
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("display_name", &self.display_name)
            .field("principal", &self.principal.map(|p| p.user_id))
            .finish()
    }
}

/// An accepted invitation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptOut {
    pub workspace_id: WorkspaceId,
    pub membership_id: MembershipId,
    /// The first session of a user created by accepting; `None` when a signed-in user accepted,
    /// whose own session goes on.
    pub session: Option<SessionOut>,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// The workspace's members and open (or expired, not yet replaced) invitations, oldest first.
/// Needs `workspace.read`.
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<Vec<MemberOut>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.memberships().list().await
}

/// Invites `email` into the workspace with the role `role_key`. Needs `team.manage`.
///
/// The email is normalised by `Email::parse` (`VALIDATION` with `details.field = "email"`); a
/// role key the workspace does not have is `VALIDATION` with `details.role_key`. The role must
/// be the caller's to give (`can_grant_role`; see the module docs). An email that already belongs
/// to an active member, or has an invitation that is still open, is `CONFLICT`; expired
/// invitations for it are replaced (set `Removed`) by the new one. The invitation, the
/// replacements and the `team.invite` ledger entry (payload `invited_email`, `role_key`,
/// `replaced_membership_ids`) are written in one transaction.
pub async fn invite(deps: &Deps, ctx: &Ctx, input: InviteInput) -> Result<InviteOut, AppError> {
    ctx.require(Permission::TeamManage)?;
    let email = Email::parse(&input.email).map_err(|e| invalid("email", &e.to_string()))?;
    let now = ctx.now;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let role = repos
        .roles()
        .find_by_key(&input.role_key)
        .await?
        .ok_or_else(|| unknown_role(&input.role_key))?;
    let grant = RoleGrant {
        role_is_owner: is_owner(&role),
        role_permissions: role.permissions.clone(),
        current_role_is_owner: false,
    };
    can_grant_role(&ctx.authority(), &grant).map_err(|e| refusal(ctx, e))?;

    let mut expired = Vec::new();
    for member in repos.memberships().list().await? {
        if member.email != email {
            continue;
        }
        match member.status {
            MembershipStatus::Active => return Err(AppError::conflict(ALREADY_A_MEMBER)),
            MembershipStatus::Invited => {
                let row = repos
                    .memberships()
                    .find(member.membership_id)
                    .await?
                    .ok_or_else(|| AppError::internal("a listed membership is missing"))?;
                if is_open(&row, now) {
                    return Err(AppError::conflict(
                        "an open invitation for this email already exists",
                    ));
                }
                expired.push(row.id);
            }
            MembershipStatus::Removed => {}
        }
    }
    for id in &expired {
        repos.memberships().remove(*id).await?;
    }

    let invite_token = deps.tokens.token(INVITE_TOKEN_BYTES);
    let membership_id = MembershipId(deps.ids.uuid());
    let expires_at = now + INVITE_LIFETIME;
    repos
        .memberships()
        .insert_invite(MembershipRow {
            id: membership_id,
            workspace_id: ctx.workspace_id,
            user_id: None,
            role_id: role.id,
            status: MembershipStatus::Invited,
            invited_email: Some(email.clone()),
            invite_token_hash: Some(hash_token(&invite_token)),
            invite_expires_at: Some(expires_at),
            invited_by: acting_user(&ctx.actor),
            created_at: now,
        })
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "team.invite",
            "membership",
            membership_id,
            json!({
                "invited_email": email.as_str(),
                "role_key": role.key,
                "replaced_membership_ids": expired,
            }),
        )?)
        .await?;
    repos.commit().await?;
    Ok(InviteOut {
        membership_id,
        invite_token,
        expires_at,
    })
}

/// Accepts the invitation behind `input.token`, at the clock's time.
///
/// An unknown token, one whose invitation has expired (`invite_expires_at` not after now), and
/// one already spent or cancelled are all `FORBIDDEN` with the same message.
///
/// - Signed in (`principal` set): the principal's email must equal the invited email, else
///   `FORBIDDEN`; a principal already in the workspace is `CONFLICT`. The membership becomes
///   theirs and their session goes on (`session: None`).
/// - Not signed in: `password` (at least [`MIN_PASSWORD_CHARS`] characters) and `display_name`
///   (trimmed, not empty) are required, else `VALIDATION` naming the field; an invited email that
///   is already registered is `CONFLICT` ("sign in to accept this invite"). The user is created
///   with the invited email and gets a session in the workspace, as login gives one.
///
/// Either way one user-level transaction activates the membership (spending the token), creates
/// the user and the session where needed, and writes the `team.accept_invite` ledger entry
/// (payload `invited_email`, `role_key`).
pub async fn accept_invite(deps: &Deps, input: AcceptInput<'_>) -> Result<AcceptOut, AppError> {
    let now = deps.clock.now();
    let found = {
        let mut platform = deps.uow.platform().await?;
        platform
            .membership_find_by_invite_hash(&hash_token(&input.token))
            .await?
    };
    let invitation = found
        .filter(|m| is_open(m, now))
        .ok_or_else(invalid_invite)?;
    let invited_email = invitation
        .invited_email
        .clone()
        .ok_or_else(invalid_invite)?;
    let accepted = Accepted {
        invitation: &invitation,
        email: &invited_email,
        now,
    };
    match input.principal {
        Some(principal) => accept_signed_in(deps, accepted, principal).await,
        None => accept_as_new_user(deps, accepted, input.password, input.display_name).await,
    }
}

/// Moves the active membership `membership_id` to the role `role_key` and returns it as the team
/// list shows it. Needs `team.manage`.
///
/// A membership that is not an active one of this workspace is `NOT_FOUND`; an unknown role key
/// is `VALIDATION` with `details.role_key`. The new role must be the caller's to give, and the
/// membership's present role too if it is `owner` (`can_grant_role`; see the module docs).
/// Moving the workspace's last active owner to another role is `CONFLICT` ("cannot demote the
/// last owner", `details.reason = "last_owner"`). Writes `team.set_role` (payload `role_key`,
/// `previous_role_key`).
pub async fn set_role(
    deps: &Deps,
    ctx: &Ctx,
    membership_id: MembershipId,
    role_key: &str,
) -> Result<MemberOut, AppError> {
    ctx.require(Permission::TeamManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    // First, so the owner memberships stay locked until this transaction ends.
    let owners = repos.memberships().count_active_owners().await?;
    let target = repos
        .memberships()
        .find(membership_id)
        .await?
        .filter(|m| m.status == MembershipStatus::Active)
        .ok_or_else(|| AppError::not_found(NO_SUCH_MEMBERSHIP))?;
    let role = repos
        .roles()
        .find_by_key(role_key)
        .await?
        .ok_or_else(|| unknown_role(role_key))?;
    let current = role_of(repos.roles().find(target.role_id).await?)?;
    let grant = RoleGrant {
        role_is_owner: is_owner(&role),
        role_permissions: role.permissions.clone(),
        current_role_is_owner: is_owner(&current),
    };
    can_grant_role(&ctx.authority(), &grant).map_err(|e| refusal(ctx, e))?;

    let last_owner = is_owner(&current) && !is_owner(&role) && owners <= 1;
    may_change(ctx, last_owner, "cannot demote the last owner")?;
    repos.memberships().set_role(membership_id, role.id).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "team.set_role",
            "membership",
            membership_id,
            json!({ "role_key": role.key, "previous_role_key": current.key }),
        )?)
        .await?;
    let member = repos
        .memberships()
        .list()
        .await?
        .into_iter()
        .find(|m| m.membership_id == membership_id)
        .ok_or_else(|| AppError::internal("the updated membership is missing"))?;
    repos.commit().await?;
    Ok(member)
}

/// Removes the membership `membership_id`: an active member, who may be the caller, or an open
/// invitation, which is cancelled. Needs `team.manage`.
///
/// A membership that is unknown here or already removed is `NOT_FOUND`; one holding the owner
/// role (an invitation to it included) is only an owner's to remove (`can_remove_member`;
/// `FORBIDDEN` with `details.reason = "owner_only"`); removing the workspace's last active owner
/// is `CONFLICT` ("cannot remove the last owner", `details.reason = "last_owner"`). One tenant transaction sets the status `Removed` and writes
/// `team.remove` (payload `user_id`, `role_key`, `previous_status`).
///
/// Then a second, user-level transaction revokes the removed user's live sessions whose current
/// workspace is this one (sessions are user-level data, outside the tenant bundle). The removal
/// has already committed by then and takes effect on its own: resolving a session re-reads the
/// memberships, so the removed user can no longer act here even before the revocation. If the
/// revocation fails its error is returned, but the removal stands.
pub async fn remove(deps: &Deps, ctx: &Ctx, membership_id: MembershipId) -> Result<(), AppError> {
    ctx.require(Permission::TeamManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    // First, so the owner memberships stay locked until this transaction ends.
    let owners = repos.memberships().count_active_owners().await?;
    let target = repos
        .memberships()
        .find(membership_id)
        .await?
        .filter(|m| m.status != MembershipStatus::Removed)
        .ok_or_else(|| AppError::not_found(NO_SUCH_MEMBERSHIP))?;
    let role = role_of(repos.roles().find(target.role_id).await?)?;
    can_remove_member(&ctx.authority(), is_owner(&role)).map_err(|e| refusal(ctx, e))?;

    let last_owner = target.status == MembershipStatus::Active && is_owner(&role) && owners <= 1;
    may_change(ctx, last_owner, "cannot remove the last owner")?;
    repos.memberships().remove(membership_id).await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            "team.remove",
            "membership",
            membership_id,
            json!({
                "user_id": target.user_id,
                "role_key": role.key,
                "previous_status": target.status.key(),
            }),
        )?)
        .await?;
    repos.commit().await?;

    if let (Some(user_id), MembershipStatus::Active) = (target.user_id, target.status) {
        let mut users = deps.uow.user().await?;
        users
            .sessions()
            .revoke_all_for_workspace(user_id, ctx.workspace_id, ctx.now)
            .await?;
        users.commit().await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------------------------

/// An open invitation being accepted, with its invited email and the time of acceptance.
#[derive(Clone, Copy)]
struct Accepted<'a> {
    invitation: &'a MembershipRow,
    email: &'a Email,
    now: OffsetDateTime,
}

async fn accept_signed_in(
    deps: &Deps,
    accepted: Accepted<'_>,
    principal: &Principal,
) -> Result<AcceptOut, AppError> {
    if principal.email != *accepted.email {
        return Err(AppError::forbidden(
            "this invite was sent to another email address",
        ));
    }
    let ws = accepted.invitation.workspace_id;
    let mut repos = deps.uow.user().await?;
    let memberships = repos.memberships_of_user(principal.user_id).await?;
    if memberships.iter().any(|m| m.workspace_id == ws) {
        return Err(AppError::conflict(ALREADY_A_MEMBER));
    }
    activate(repos.as_mut(), accepted, principal.user_id).await?;
    repos.commit().await?;
    Ok(AcceptOut {
        workspace_id: ws,
        membership_id: accepted.invitation.id,
        session: None,
    })
}

async fn accept_as_new_user(
    deps: &Deps,
    accepted: Accepted<'_>,
    password: Option<String>,
    display_name: Option<String>,
) -> Result<AcceptOut, AppError> {
    let password = password
        .filter(|p| p.chars().count() >= MIN_PASSWORD_CHARS)
        .ok_or_else(|| {
            invalid(
                "password",
                &format!("password must be at least {MIN_PASSWORD_CHARS} characters"),
            )
        })?;
    let display_name = required("display_name", display_name.as_deref().unwrap_or(""))?;
    // Hashing is slow and needs no connection, so it runs before the transaction opens.
    let password_hash = deps.hasher.hash(&password).await?;

    let (ws, now) = (accepted.invitation.workspace_id, accepted.now);
    let mut repos = deps.uow.user().await?;
    if repos.users().find_by_email(accepted.email).await?.is_some() {
        return Err(AppError::conflict(SIGN_IN_FIRST));
    }
    let user_id = UserId(deps.ids.uuid());
    repos
        .users()
        .insert(UserRow {
            id: user_id,
            email: accepted.email.clone(),
            password_hash,
            display_name: display_name.clone(),
            created_at: now,
        })
        .await
        // The email was registered concurrently, after the check above.
        .map_err(|e| match e.code {
            ErrorCode::Conflict => AppError::conflict(SIGN_IN_FIRST),
            _ => e,
        })?;
    let memberships = activate(repos.as_mut(), accepted, user_id).await?;
    let (token, expires_at) =
        auth::open_session(deps, repos.as_mut(), user_id, Some(ws), now).await?;
    repos.commit().await?;
    Ok(AcceptOut {
        workspace_id: ws,
        membership_id: accepted.invitation.id,
        session: Some(SessionOut {
            token,
            expires_at,
            me: MeOut {
                user_id,
                email: accepted.email.clone(),
                display_name,
                current_workspace: Some(ws),
                memberships,
            },
        }),
    })
}

/// Activates the invitation for `user_id` through `repos` (left uncommitted), writes the
/// `team.accept_invite` entry and returns the user's memberships, the new one included.
///
/// The activation re-checks, with the row locked, that the invitation is still open, so a token
/// spent or cancelled since it was looked up is `FORBIDDEN` here too.
async fn activate(
    repos: &mut dyn UserRepos,
    accepted: Accepted<'_>,
    user_id: UserId,
) -> Result<Vec<MembershipView>, AppError> {
    let invitation = accepted.invitation;
    let ws = invitation.workspace_id;
    repos
        .memberships_activate(ws, invitation.id, user_id, accepted.now)
        .await
        .map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::Conflict => invalid_invite(),
            _ => e,
        })?;
    let memberships = repos.memberships_of_user(user_id).await?;
    let role_key = memberships
        .iter()
        .find(|m| m.workspace_id == ws)
        .map(|m| m.role_key.clone())
        .ok_or_else(|| AppError::internal("the activated membership is missing"))?;
    let mut entry = LedgerEntry::new(
        ws,
        Actor::Human { user_id },
        action("team.accept_invite")?,
        json!({ "invited_email": accepted.email.as_str(), "role_key": role_key }),
        accepted.now,
    );
    entry.subject = Some(Subject {
        kind: "membership".to_owned(),
        id: invitation.id.to_string(),
    });
    repos.ledger_append(entry).await?;
    Ok(memberships)
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/// Whether `m` is an invitation still open at `now`.
fn is_open(m: &MembershipRow, now: OffsetDateTime) -> bool {
    m.status == MembershipStatus::Invited && m.invite_expires_at.is_some_and(|e| e > now)
}

/// Whether `role` is the `owner` system role.
fn is_owner(role: &RoleDef) -> bool {
    role.is_system && role.key == SystemRole::Owner.key()
}

/// `can_change_role` for the caller, refused as [`refusal`] says, with `message` for the last
/// owner.
fn may_change(ctx: &Ctx, target_is_last_owner: bool, message: &str) -> Result<(), AppError> {
    can_change_role(&ctx.permissions, target_is_last_owner).map_err(|e| {
        let last_owner = e == TenancyError::LastOwner;
        let mut err = refusal(ctx, e);
        if last_owner {
            message.clone_into(&mut err.message);
        }
        err
    })
}

/// The user behind an actor, whom an invitation records as its inviter.
fn acting_user(actor: &Actor) -> Option<UserId> {
    match actor {
        Actor::Human { user_id } | Actor::Agent { user_id, .. } => Some(*user_id),
        Actor::System { .. } => None,
    }
}

/// The role a membership refers to; a missing one is a broken reference.
fn role_of(role: Option<RoleDef>) -> Result<RoleDef, AppError> {
    role.ok_or_else(|| AppError::internal("membership refers to a missing role"))
}

/// `VALIDATION` for a role key the workspace does not have, named in `details.role_key`.
fn unknown_role(key: &str) -> AppError {
    AppError::validation("no such role", json!({ "role_key": key }))
}

fn invalid_invite() -> AppError {
    AppError::forbidden(INVALID_INVITE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_masked_in_debug_output() {
        let invite = InviteOut {
            membership_id: MembershipId::new_v7(),
            invite_token: "s3cret-token".into(),
            expires_at: OffsetDateTime::UNIX_EPOCH,
        };
        let accept = AcceptInput {
            token: "s3cret-token".into(),
            password: Some("hunter2hunter2".into()),
            display_name: Some("Bob".into()),
            principal: None,
        };
        for text in [format!("{invite:?}"), format!("{accept:?}")] {
            assert!(!text.contains("s3cret"), "{text}");
            assert!(!text.contains("hunter2"), "{text}");
        }
    }
}
