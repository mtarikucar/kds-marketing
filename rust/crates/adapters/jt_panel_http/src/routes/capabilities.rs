//! `/api/capabilities`: the capabilities of the session's current workspace (spec §6): what it
//! can act through, how each is reached, verified and limited, and the budget items each spends
//! from.
//!
//! Reading answers the capability with its status at the time of the call
//! (`{capability, effective_status}`). Declaring answers `201`; every other write, unlinking a
//! budget item included, answers the capability as it now stands (`200`), the same JSON its MCP
//! tool answers; an edit adds `verification_reset`. A policy, in a declaration or on its own, is
//! read strictly: an unknown field is `422 VALIDATION` naming `policy`; so is an edit's body,
//! which takes only `name`, `description` and `external_id`.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jt_app::usecases::capabilities::{
    self, CapabilityOut, CapabilityQuery, DeclareInput, UpdateCapability, UpdatedCapability,
    parse_policy_strict,
};
use jt_capability::{BudgetItemId, CapabilityId, Evidence};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::session::WorkspaceCtx;
use crate::state::AppState;

/// `POST /api/capabilities`: the declaration, as [`DeclareInput`] reads it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclareBody {
    /// A kind key, e.g. `"phone"`.
    pub kind_key: String,
    /// The tool's name, for the third-party kind `other` only.
    #[serde(default)]
    pub key_detail: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub external_id: Option<String>,
    /// Public connector settings, an object; never a secret.
    #[serde(default)]
    pub connector_public: Value,
    /// The policy as written; none is the default policy.
    #[serde(default)]
    pub policy: Option<Value>,
}

impl DeclareBody {
    /// The use case's input, its policy read strictly.
    pub fn into_input(self) -> Result<DeclareInput, ApiError> {
        let policy = match &self.policy {
            Some(value) => Some(parse_policy_strict(value)?),
            None => None,
        };
        Ok(DeclareInput {
            kind_key: self.kind_key,
            key_detail: self.key_detail,
            name: self.name,
            description: self.description,
            external_id: self.external_id,
            connector_public: self.connector_public,
            policy,
        })
    }
}

/// The agent's evidence: what it ran or saw, and references to what backs it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceBody {
    pub text: String,
    #[serde(default)]
    pub refs: Vec<String>,
}

impl From<EvidenceBody> for Evidence {
    fn from(body: EvidenceBody) -> Evidence {
        Evidence {
            text: body.text,
            refs: body.refs,
        }
    }
}

/// `POST /api/capabilities/{capability_id}/verify`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyBody {
    pub evidence: EvidenceBody,
}

/// `POST /api/capabilities/{capability_id}/unreachable`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnreachableBody {
    pub reason: String,
}

/// `POST /api/capabilities/{capability_id}/retire`: the confirmation (missing reads as `false`,
/// which is refused).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetireBody {
    #[serde(default)]
    pub confirm: bool,
}

/// `POST /api/capabilities/{capability_id}/budget-links`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkBudgetBody {
    pub budget_item_id: BudgetItemId,
}

/// `200` with the capabilities the query matches (`?group=&kind=&status=&group_id=`, each
/// optional), oldest first.
pub async fn list(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiQuery(query): ApiQuery<CapabilityQuery>,
) -> Result<Json<Vec<CapabilityOut>>, ApiError> {
    Ok(Json(capabilities::list(&state.deps, &ctx, query).await?))
}

/// `200` with the capability.
pub async fn get(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(capabilities::get(&state.deps, &ctx, id).await?))
}

/// `201` with the declared capability.
pub async fn declare(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiJson(body): ApiJson<DeclareBody>,
) -> Result<(StatusCode, Json<CapabilityOut>), ApiError> {
    let out = capabilities::declare(&state.deps, &ctx, body.into_input()?).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// `200` with the capability as edited and whether its verification was reset. The body is the
/// edit as [`UpdateCapability`] reads it: `{name?, description?, external_id?}`, at least one.
pub async fn update(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<UpdateCapability>,
) -> Result<Json<UpdatedCapability>, ApiError> {
    Ok(Json(
        capabilities::update(&state.deps, &ctx, id, body).await?,
    ))
}

/// `200` with the capability, verified on the strength of the evidence.
pub async fn verify(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<VerifyBody>,
) -> Result<Json<CapabilityOut>, ApiError> {
    let evidence = body.evidence.into();
    Ok(Json(
        capabilities::verify(&state.deps, &ctx, id, evidence).await?,
    ))
}

/// `200` with the capability, marked unreachable.
pub async fn mark_unreachable(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<UnreachableBody>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(
        capabilities::mark_unreachable(&state.deps, &ctx, id, body.reason).await?,
    ))
}

/// `200` with the capability under its new policy; the body is the policy as written.
pub async fn set_policy(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(policy): ApiJson<Value>,
) -> Result<Json<CapabilityOut>, ApiError> {
    let policy = parse_policy_strict(&policy)?;
    Ok(Json(
        capabilities::set_policy(&state.deps, &ctx, id, policy).await?,
    ))
}

/// `200` with the retired capability, detached from its groups and budget items.
pub async fn retire(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<RetireBody>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(
        capabilities::retire(&state.deps, &ctx, id, body.confirm).await?,
    ))
}

/// `200` with the capability, linked to the budget item.
pub async fn link_budget(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath(id): ApiPath<CapabilityId>,
    ApiJson(body): ApiJson<LinkBudgetBody>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(
        capabilities::link_budget(&state.deps, &ctx, id, body.budget_item_id).await?,
    ))
}

/// `200` with the capability, which no longer spends from the budget item.
pub async fn unlink_budget(
    State(state): State<AppState>,
    WorkspaceCtx(ctx): WorkspaceCtx,
    ApiPath((id, item)): ApiPath<(CapabilityId, BudgetItemId)>,
) -> Result<Json<CapabilityOut>, ApiError> {
    Ok(Json(
        capabilities::unlink_budget(&state.deps, &ctx, id, item).await?,
    ))
}
