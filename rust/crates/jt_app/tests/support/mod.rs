//! The world the capability, group and budget tests share: the workspace "Acme", registered by its
//! owner over the in-memory fakes, with helpers for members, agents, a second workspace and an
//! approved strategy.

#![allow(dead_code)]

use std::collections::BTreeSet;
use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::{UnitOfWork, UserRow};
use jt_app::usecases::Deps;
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::capabilities::{self, CapabilityOut, DeclareInput};
use jt_ledger::{Actor, LedgerEntry};
use jt_strategy::{Sections, StrategyVersion, StrategyVersionId, VersionStatus};
use jt_tenancy::{
    AgentConnectionId, Email, MembershipId, Permission, SystemRole, UserId, WorkspaceId,
};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, RecordingTenantHosts, deps};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

pub struct World {
    pub uow: InMemoryUow,
    pub deps: Deps,
    /// The tenant host registry of `deps`.
    pub hosts: RecordingTenantHosts,
    pub ws: WorkspaceId,
    pub owner: UserId,
    pub owner_ctx: Ctx,
}

/// Registers `email` with a new workspace called `workspace` in `deps`; its id, the owner and
/// the owner's context.
async fn register(deps: &Deps, email: &str, workspace: &str) -> (WorkspaceId, UserId, Ctx) {
    let out = auth::register(
        deps,
        RegisterInput {
            email: email.into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: workspace.into(),
        },
    )
    .await
    .unwrap();
    let ws = out.me.current_workspace.unwrap();
    let owner = out.me.user_id;
    (
        ws,
        owner,
        human(ws, owner, "owner", SystemRole::Owner.permissions()),
    )
}

pub async fn world() -> World {
    let uow = InMemoryUow::new();
    let hosts = RecordingTenantHosts::new();
    let mut deps = deps(Arc::new(uow.clone()));
    deps.hosts = Arc::new(hosts.clone());
    let (ws, owner, owner_ctx) = register(&deps, "owner@acme.example", "Acme").await;
    World {
        uow,
        deps,
        hosts,
        ws,
        owner,
        owner_ctx,
    }
}

pub fn human(
    ws: WorkspaceId,
    user: UserId,
    role_key: &str,
    permissions: BTreeSet<Permission>,
) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: user },
        permissions,
        role_key: Some(role_key.to_owned()),
        now: FIXED_NOW,
        agent_connection_id: None,
    }
}

/// `ctx` at another time.
pub fn at(ctx: &Ctx, now: OffsetDateTime) -> Ctx {
    Ctx { now, ..ctx.clone() }
}

/// `days` days after the fixed time.
pub fn days_later(days: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::days(days)
}

impl World {
    /// The same world with `hosts` as its tenant host registry.
    pub fn with_hosts(&self, hosts: RecordingTenantHosts) -> World {
        let mut deps = self.deps.clone();
        deps.hosts = Arc::new(hosts.clone());
        World {
            uow: self.uow.clone(),
            deps,
            hosts,
            ws: self.ws,
            owner: self.owner,
            owner_ctx: self.owner_ctx.clone(),
        }
    }

    /// A second workspace, "Beta", registered by its own owner in the same database; its id and
    /// the owner's context.
    pub async fn other_workspace(&self) -> (WorkspaceId, Ctx) {
        let (ws, _, ctx) = register(&self.deps, "owner@beta.example", "Beta").await;
        (ws, ctx)
    }

    /// A new active member holding the role `role_key`, and their context.
    pub async fn member(&self, role_key: &str) -> Ctx {
        let role = {
            let mut t = self.uow.tenant(self.ws).await.unwrap();
            t.roles().find_by_key(role_key).await.unwrap().unwrap()
        };
        let user = UserId::new_v7();
        let mut u = self.uow.user().await.unwrap();
        u.users()
            .insert(UserRow {
                id: user,
                email: Email::parse(&format!("{role_key}@acme.example")).unwrap(),
                password_hash: "plain:pw".into(),
                display_name: role_key.into(),
                created_at: FIXED_NOW,
            })
            .await
            .unwrap();
        u.memberships_insert_active(MembershipId::new_v7(), self.ws, user, role.id, FIXED_NOW)
            .await
            .unwrap();
        u.commit().await.unwrap();
        human(self.ws, user, role_key, role.permissions)
    }

    /// The context of an agent acting through a new key the owner issues with `scopes`.
    pub async fn agent(&self, scopes: &[&str]) -> Ctx {
        let key = api_keys::create(
            &self.deps,
            &self.owner_ctx,
            CreateKey {
                name: format!("agent {}", scopes.join(" ")),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap();
        let principal = api_keys::authenticate(&self.deps, &key.plaintext)
            .await
            .unwrap();
        api_keys::ctx_for_agent(&principal, AgentConnectionId::new_v7(), FIXED_NOW)
    }

    /// Puts an approved strategy version in force, written straight to the repos.
    pub async fn approve_strategy(&self) -> StrategyVersionId {
        let id = StrategyVersionId::new_v7();
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.strategy()
            .insert(StrategyVersion {
                id,
                workspace_id: self.ws,
                number: 1,
                status: VersionStatus::Approved,
                sections: Sections::default(),
                created_at: FIXED_NOW,
                created_by: Actor::Human {
                    user_id: self.owner,
                },
                submitted_at: Some(FIXED_NOW),
                approved_at: Some(FIXED_NOW),
                approved_by: Some(self.owner),
                archived_at: None,
            })
            .await
            .unwrap();
        t.commit().await.unwrap();
        id
    }

    /// Declares a capability of `kind` called `name` as the owner.
    pub async fn declare(&self, kind: &str, name: &str) -> CapabilityOut {
        capabilities::declare(&self.deps, &self.owner_ctx, declaring(kind, name))
            .await
            .unwrap()
    }

    /// The ledger entries whose action starts with `prefix`, oldest first.
    pub fn ledger(&self, prefix: &str) -> Vec<LedgerEntry> {
        self.uow
            .snapshot()
            .ledger
            .into_iter()
            .map(|row| row.entry)
            .filter(|e| e.workspace_id == self.ws && e.action.as_str().starts_with(prefix))
            .collect()
    }

    /// The ledger entries with exactly this action, oldest first.
    pub fn entries(&self, action: &str) -> Vec<LedgerEntry> {
        self.ledger(action)
            .into_iter()
            .filter(|e| e.action.as_str() == action)
            .collect()
    }
}

/// What declaring a capability of `kind` called `name` takes, with nothing else set.
pub fn declaring(kind: &str, name: &str) -> DeclareInput {
    DeclareInput {
        kind_key: kind.into(),
        name: name.into(),
        ..DeclareInput::default()
    }
}

/// The error of a call that must fail.
pub fn err<T: std::fmt::Debug>(result: Result<T, AppError>) -> AppError {
    result.expect_err("the call must fail")
}

/// Asserts `FORBIDDEN` naming `permission`.
pub fn assert_forbidden(e: &AppError, permission: &str) {
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    assert_eq!(e.details, json!({ "permission": permission }));
}

/// Asserts `VALIDATION` naming `field`.
pub fn assert_invalid(e: &AppError, field: &str) {
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details["field"], field, "{e:?}");
}

/// The fields named by a `VALIDATION` error's `details.gaps`.
pub fn gap_fields(e: &AppError) -> Vec<String> {
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    e.details["gaps"]
        .as_array()
        .unwrap_or_else(|| panic!("no gaps in {e:?}"))
        .iter()
        .map(|g| g["field"].as_str().unwrap().to_owned())
        .collect()
}

/// `value` as JSON text.
pub fn wire(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}

/// The payload of `entry`, for comparing.
pub fn payload(entry: &LedgerEntry) -> Value {
    entry.payload.clone()
}
