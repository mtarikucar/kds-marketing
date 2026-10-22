//! Panel authentication: registration, login, logout, resolving a session token into a
//! [`Principal`], `me`, switching the current workspace, and the [`Ctx`] of a signed-in user.
//!
//! A session token is [`SESSION_TOKEN_BYTES`] random bytes (base64url) handed to the client once;
//! only its [`hash_token`] is stored. A session lasts [`SESSION_LIFETIME`] from the moment it is
//! opened.

use std::fmt;

use jt_ledger::{Actor, LedgerEntry};
use jt_tenancy::{
    Email, MembershipId, RoleDef, RoleId, SessionId, SystemRole, UserId, WorkspaceId,
    WorkspaceStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::{Duration, OffsetDateTime};

use super::{Deps, action, hash_token, invalid, required};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{MembershipView, SessionRow, UserRepos, UserRow};

/// How long a session lasts from the moment it is opened.
pub const SESSION_LIFETIME: Duration = Duration::days(30);
/// The shortest acceptable password, counted in characters.
pub const MIN_PASSWORD_CHARS: usize = 10;
/// Random bytes in a session token.
pub const SESSION_TOKEN_BYTES: usize = 32;

/// Random bytes behind a workspace slug's suffix: three bytes are four base64url characters.
const SLUG_SUFFIX_BYTES: usize = 3;
/// Characters in a workspace slug's suffix.
const SLUG_SUFFIX_LEN: usize = 4;
/// The longest slug stem taken from a workspace name, in characters.
const SLUG_STEM_MAX: usize = 40;
/// Registration attempts before a clashing slug is reported.
const SLUG_ATTEMPTS: usize = 3;

/// The single answer to every failed login, so it never reveals whether an email is registered.
const INVALID_CREDENTIALS: &str = "invalid credentials";
/// The single answer to every unusable session token.
const INVALID_SESSION: &str = "the session is invalid or has expired";
const NOT_A_MEMBER: &str = "not an active member of this workspace";
const EMAIL_TAKEN: &str = "email is already registered";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// What registration asks for. `Debug` masks the password.
#[derive(Clone, Deserialize)]
pub struct RegisterInput {
    pub email: String,
    pub password: String,
    pub display_name: String,
    pub workspace_name: String,
}

impl fmt::Debug for RegisterInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisterInput")
            .field("email", &self.email)
            .field("password", &"***")
            .field("display_name", &self.display_name)
            .field("workspace_name", &self.workspace_name)
            .finish()
    }
}

/// What login asks for. `Debug` masks the password.
#[derive(Clone, Deserialize)]
pub struct LoginInput {
    pub email: String,
    pub password: String,
}

impl fmt::Debug for LoginInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginInput")
            .field("email", &self.email)
            .field("password", &"***")
            .finish()
    }
}

/// The signed-in user as the panel shows them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MeOut {
    pub user_id: UserId,
    pub email: Email,
    pub display_name: String,
    /// The workspace the session works in, if any.
    pub current_workspace: Option<WorkspaceId>,
    /// The user's active memberships, oldest first.
    pub memberships: Vec<MembershipView>,
}

/// A newly opened session. `Debug` masks the token.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionOut {
    /// The plaintext token ([`SESSION_TOKEN_BYTES`] random bytes, base64url): handed to the client
    /// once and never stored.
    pub token: String,
    pub expires_at: OffsetDateTime,
    pub me: MeOut,
}

impl fmt::Debug for SessionOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionOut")
            .field("token", &"***")
            .field("expires_at", &self.expires_at)
            .field("me", &self.me)
            .finish()
    }
}

/// The user behind a live session, resolved for one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Principal {
    pub session_id: SessionId,
    pub user_id: UserId,
    pub email: Email,
    pub display_name: String,
    /// The session's current workspace, kept only while the user is an active member there.
    pub current_workspace: Option<WorkspaceId>,
    /// The user's active memberships, oldest first.
    pub memberships: Vec<MembershipView>,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// Registers a user together with a new workspace they own, and opens their first session.
///
/// The email is normalised by `Email::parse`, the password needs at least
/// [`MIN_PASSWORD_CHARS`] characters, and the display and workspace names are trimmed and must not
/// be empty; each refusal is `VALIDATION` with `details.field` naming the input. An email that is
/// already registered is `CONFLICT`.
///
/// One user-level transaction stores the user, the workspace (`PendingPayment`; slug = a stem of
/// its name, `-`, four random lowercase letters or digits), its three system roles, the user's
/// active owner membership, the session and the `auth.register` ledger entry. If the slug is
/// taken, the whole transaction is retried with a new suffix, up to three attempts in all.
pub async fn register(deps: &Deps, input: RegisterInput) -> Result<SessionOut, AppError> {
    let email = Email::parse(&input.email).map_err(|e| invalid("email", &e.to_string()))?;
    if input.password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(invalid(
            "password",
            &format!("password must be at least {MIN_PASSWORD_CHARS} characters"),
        ));
    }
    let display_name = required("display_name", &input.display_name)?;
    let workspace_name = required("workspace_name", &input.workspace_name)?;
    // Hashing is slow and needs no connection, so it runs before any transaction opens.
    let password_hash = deps.hasher.hash(&input.password).await?;
    let account = NewAccount {
        stem: slug_stem(&workspace_name),
        email,
        password_hash,
        display_name,
        workspace_name,
    };
    for _ in 0..SLUG_ATTEMPTS {
        match register_once(deps, &account).await {
            Ok(out) => return Ok(out),
            Err(Attempt::Failed(e)) => return Err(e),
            Err(Attempt::SlugTaken) => {}
        }
    }
    Err(AppError::conflict(
        "no free workspace address was found; please try again",
    ))
}

/// Opens a session for the user with this email and password. Its current workspace is the
/// user's oldest active membership, if any.
///
/// An unknown email, a wrong password and a malformed email are all `UNAUTHENTICATED` with the
/// same message, and an unknown email still costs one password hash, so neither the answer nor
/// (roughly) its timing tells whether the email is registered.
pub async fn login(deps: &Deps, input: LoginInput) -> Result<SessionOut, AppError> {
    let Ok(email) = Email::parse(&input.email) else {
        return Err(invalid_credentials());
    };
    // The account is read in a transaction of its own, closed before the slow verification.
    let user = {
        let mut repos = deps.uow.user().await?;
        repos.users().find_by_email(&email).await?
    };
    let Some(user) = user else {
        // The hash is discarded: it only spends the time a verification would.
        let _ = deps.hasher.hash(&input.password).await;
        return Err(invalid_credentials());
    };
    if !deps
        .hasher
        .verify(&input.password, &user.password_hash)
        .await?
    {
        return Err(invalid_credentials());
    }

    let now = deps.clock.now();
    let mut repos = deps.uow.user().await?;
    let memberships = repos.memberships_of_user(user.id).await?;
    let current_workspace = memberships.first().map(|m| m.workspace_id);
    let (token, expires_at) =
        open_session(deps, repos.as_mut(), user.id, current_workspace, now).await?;
    repos.commit().await?;
    Ok(SessionOut {
        token,
        expires_at,
        me: MeOut {
            user_id: user.id,
            email: user.email,
            display_name: user.display_name,
            current_workspace,
            memberships,
        },
    })
}

/// Revokes the session with this token, at the clock's time. An unknown or already revoked
/// token is a successful no-op.
pub async fn logout(deps: &Deps, token: &str) -> Result<(), AppError> {
    let mut repos = deps.uow.user().await?;
    let Some(session) = repos
        .sessions()
        .find_by_token_hash(&hash_token(token))
        .await?
    else {
        return Ok(());
    };
    repos
        .sessions()
        .revoke(session.id, deps.clock.now())
        .await?;
    repos.commit().await
}

/// The principal behind a session token. An unknown, revoked or expired (`expires_at` not after
/// now) token is `UNAUTHENTICATED`, always with the same message.
///
/// Memberships are read afresh; a current workspace in which the user is no longer an active
/// member is dropped.
pub async fn resolve_session(deps: &Deps, token: &str) -> Result<Principal, AppError> {
    let now = deps.clock.now();
    let mut repos = deps.uow.user().await?;
    let session = repos
        .sessions()
        .find_by_token_hash(&hash_token(token))
        .await?
        .ok_or_else(invalid_session)?;
    if session.revoked_at.is_some() || session.expires_at <= now {
        return Err(invalid_session());
    }
    let user = repos
        .users()
        .find_by_id(session.user_id)
        .await?
        .ok_or_else(invalid_session)?;
    let memberships = repos.memberships_of_user(user.id).await?;
    let current_workspace = session
        .current_workspace_id
        .filter(|ws| memberships.iter().any(|m| m.workspace_id == *ws));
    Ok(Principal {
        session_id: session.id,
        user_id: user.id,
        email: user.email,
        display_name: user.display_name,
        current_workspace,
        memberships,
    })
}

/// The signed-in user as the panel shows them.
///
/// It takes [`Deps`] like every use case, so adapters call them all alike, but reads nothing:
/// `principal` was resolved for this request.
pub fn me(_deps: &Deps, principal: &Principal) -> MeOut {
    MeOut {
        user_id: principal.user_id,
        email: principal.email.clone(),
        display_name: principal.display_name.clone(),
        current_workspace: principal.current_workspace,
        memberships: principal.memberships.clone(),
    }
}

/// Makes `ws` the current workspace of the principal's session.
///
/// The user must be an active member of `ws`, checked against the stored memberships rather
/// than the principal's copy; otherwise `FORBIDDEN`.
pub async fn switch_workspace(
    deps: &Deps,
    principal: &Principal,
    ws: WorkspaceId,
) -> Result<(), AppError> {
    let mut repos = deps.uow.user().await?;
    let memberships = repos.memberships_of_user(principal.user_id).await?;
    if !memberships.iter().any(|m| m.workspace_id == ws) {
        return Err(AppError::forbidden(NOT_A_MEMBER));
    }
    repos
        .sessions()
        .set_current_workspace(principal.session_id, Some(ws))
        .await?;
    repos.commit().await
}

/// The context of a call the principal makes in workspace `ws` at `now`: a human actor with the
/// permissions of their role there. `FORBIDDEN` unless they are an active member of `ws`.
pub fn ctx_for(
    principal: &Principal,
    ws: WorkspaceId,
    now: OffsetDateTime,
) -> Result<Ctx, AppError> {
    let membership = principal
        .memberships
        .iter()
        .find(|m| m.workspace_id == ws)
        .ok_or_else(|| AppError::forbidden(NOT_A_MEMBER))?;
    Ok(Ctx {
        workspace_id: ws,
        actor: Actor::Human {
            user_id: principal.user_id,
        },
        permissions: membership.permissions.clone(),
        now,
        agent_connection_id: None,
    })
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/// Stores a new session for `user_id` through `repos` (left uncommitted) and returns its
/// plaintext token and expiry.
pub(crate) async fn open_session(
    deps: &Deps,
    repos: &mut dyn UserRepos,
    user_id: UserId,
    current_workspace: Option<WorkspaceId>,
    now: OffsetDateTime,
) -> Result<(String, OffsetDateTime), AppError> {
    let token = deps.tokens.token(SESSION_TOKEN_BYTES);
    let expires_at = now + SESSION_LIFETIME;
    repos
        .sessions()
        .insert(SessionRow {
            id: SessionId(deps.ids.uuid()),
            user_id,
            token_hash: hash_token(&token),
            current_workspace_id: current_workspace,
            created_at: now,
            expires_at,
            revoked_at: None,
        })
        .await?;
    Ok((token, expires_at))
}

/// A validated registration, ready to be stored.
struct NewAccount {
    email: Email,
    password_hash: String,
    display_name: String,
    workspace_name: String,
    /// The slug stem of `workspace_name`.
    stem: String,
}

/// Why one registration transaction did not complete.
enum Attempt {
    /// The workspace slug was taken; nothing was stored and a new suffix may be tried.
    SlugTaken,
    Failed(AppError),
}

impl From<AppError> for Attempt {
    fn from(e: AppError) -> Self {
        Attempt::Failed(e)
    }
}

/// One registration transaction, with a fresh slug suffix.
async fn register_once(deps: &Deps, account: &NewAccount) -> Result<SessionOut, Attempt> {
    let now = deps.clock.now();
    let mut repos = deps.uow.user().await?;
    if repos.users().find_by_email(&account.email).await?.is_some() {
        return Err(AppError::conflict(EMAIL_TAKEN).into());
    }
    let user_id = UserId(deps.ids.uuid());
    repos
        .users()
        .insert(UserRow {
            id: user_id,
            email: account.email.clone(),
            password_hash: account.password_hash.clone(),
            display_name: account.display_name.clone(),
            created_at: now,
        })
        .await
        // A concurrent registration took the email after the check above.
        .map_err(|e| match e.code {
            ErrorCode::Conflict => AppError::conflict(EMAIL_TAKEN),
            _ => e,
        })?;

    let ws = WorkspaceId(deps.ids.uuid());
    let slug = format!("{}-{}", account.stem, slug_suffix(deps));
    if let Err(e) = repos
        .workspaces_create(
            ws,
            &account.workspace_name,
            &slug,
            WorkspaceStatus::PendingPayment,
            now,
        )
        .await
    {
        return Err(match e.code {
            ErrorCode::Conflict => Attempt::SlugTaken,
            _ => Attempt::Failed(e),
        });
    }
    let roles = system_roles(deps);
    // `system_roles` lists the owner first.
    let owner_role = roles[0].id;
    repos.roles_create_system(ws, &roles).await?;
    repos
        .memberships_insert_active(MembershipId(deps.ids.uuid()), ws, user_id, owner_role, now)
        .await?;
    let (token, expires_at) = open_session(deps, repos.as_mut(), user_id, Some(ws), now).await?;
    repos
        .ledger_append(LedgerEntry::new(
            ws,
            Actor::Human { user_id },
            action("auth.register")?,
            json!({ "email": account.email.as_str(), "workspace_id": ws }),
            now,
        ))
        .await?;
    let memberships = repos.memberships_of_user(user_id).await?;
    repos.commit().await?;
    Ok(SessionOut {
        token,
        expires_at,
        me: MeOut {
            user_id,
            email: account.email.clone(),
            display_name: account.display_name.clone(),
            current_workspace: Some(ws),
            memberships,
        },
    })
}

/// The system roles a new workspace starts with, owner first, named in Turkish.
fn system_roles(deps: &Deps) -> [RoleDef; 3] {
    [
        (SystemRole::Owner, "Sahip"),
        (SystemRole::Manager, "Yönetici"),
        (SystemRole::Rep, "Temsilci"),
    ]
    .map(|(role, name)| RoleDef {
        id: RoleId(deps.ids.uuid()),
        key: role.key().to_owned(),
        name: name.to_owned(),
        permissions: role.permissions(),
        is_system: true,
    })
}

/// The slug stem of a workspace name: lowercase ASCII letters and digits, with Turkish letters
/// folded to ASCII and every run of other characters turned into one `-`, at most 40 characters;
/// `workspace` when nothing usable is left.
fn slug_stem(name: &str) -> String {
    let mut stem = String::new();
    let mut gap = false;
    for c in name.chars() {
        match fold_slug_char(c) {
            Some(c) => {
                if gap && !stem.is_empty() {
                    stem.push('-');
                }
                gap = false;
                stem.push(c);
            }
            None => gap = true,
        }
    }
    // The stem is ASCII, so every byte index is a character boundary.
    stem.truncate(SLUG_STEM_MAX);
    match stem.trim_end_matches('-') {
        "" => "workspace".to_owned(),
        trimmed => trimmed.to_owned(),
    }
}

/// The slug character for `c`, if it has one.
fn fold_slug_char(c: char) -> Option<char> {
    match c {
        'a'..='z' | '0'..='9' => Some(c),
        'A'..='Z' => Some(c.to_ascii_lowercase()),
        'ç' | 'Ç' => Some('c'),
        'ğ' | 'Ğ' => Some('g'),
        'ı' | 'İ' | 'î' | 'Î' => Some('i'),
        'ö' | 'Ö' => Some('o'),
        'ş' | 'Ş' => Some('s'),
        'ü' | 'Ü' | 'û' | 'Û' => Some('u'),
        'â' | 'Â' => Some('a'),
        _ => None,
    }
}

/// Four lowercase letters or digits from the token generator: base64url's letters lowercased,
/// `-` and `_` read as `0`.
fn slug_suffix(deps: &Deps) -> String {
    deps.tokens
        .token(SLUG_SUFFIX_BYTES)
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '0'
            }
        })
        .chain(std::iter::repeat('0'))
        .take(SLUG_SUFFIX_LEN)
        .collect()
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
    fn slug_stems_fold_turkish_letters_and_collapse_separators() {
        let cases = [
            ("Acme", "acme"),
            ("  Çiçek Bahçesi  ", "cicek-bahcesi"),
            ("İstanbul Ağ Şirketi", "istanbul-ag-sirketi"),
            ("Işık & Gölge -- Ltd.", "isik-golge-ltd"),
            ("Kâr Ünü", "kar-unu"),
            ("ACME 2026", "acme-2026"),
            ("!!!", "workspace"),
            ("東京", "workspace"),
        ];
        for (name, stem) in cases {
            assert_eq!(slug_stem(name), stem, "{name:?}");
        }
    }

    #[test]
    fn slug_stems_are_at_most_forty_characters_and_never_end_in_a_dash() {
        let stem = slug_stem(&"abcdefghi ".repeat(10));
        assert!(stem.len() <= SLUG_STEM_MAX);
        assert!(!stem.ends_with('-'));
        assert_eq!(slug_stem(&format!("{} x", "a".repeat(39))), "a".repeat(39));
    }

    #[test]
    fn secrets_are_masked_in_debug_output() {
        let register = RegisterInput {
            email: "a@example.com".into(),
            password: "hunter2hunter2".into(),
            display_name: "A".into(),
            workspace_name: "W".into(),
        };
        let login = LoginInput {
            email: "a@example.com".into(),
            password: "hunter2hunter2".into(),
        };
        assert!(!format!("{register:?}").contains("hunter2"));
        assert!(!format!("{login:?}").contains("hunter2"));
    }
}
