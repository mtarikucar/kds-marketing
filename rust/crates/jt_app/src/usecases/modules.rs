//! Tenant-owned, declarative modules. Installation is navigation/configuration, never an
//! execution permission, credential grant, or cancellation of existing jobs.
use super::{Deps, ledger_entry};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{ApiKeyStatus, TenantRepos},
};
use jt_capability::{CapabilityId, StoredStatus};
use jt_tenancy::{AgentConnectionId, MembershipStatus, Permission};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blueprint {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub requirements: Vec<String>,
    pub workflow: Vec<String>,
    #[serde(default)]
    pub builtin: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModuleConfig {
    pub brief: String,
    pub agent_ids: Vec<AgentConnectionId>,
    pub capability_ids: Vec<CapabilityId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceModule {
    pub blueprint: Blueprint,
    pub installed: bool,
    pub required: bool,
    pub config: ModuleConfig,
    pub revision: u32,
}
#[derive(Clone, Debug, Serialize)]
pub struct ModulesOut {
    pub modules: Vec<WorkspaceModule>,
    pub catalog: Vec<Blueprint>,
}
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct InstallInput {
    pub blueprint: Option<Blueprint>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateInput {
    pub config: ModuleConfig,
    pub revision: u32,
}
#[derive(Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default)]
    legacy: bool,
    #[serde(default)]
    modules: Vec<WorkspaceModule>,
}

/// Builtin screens are an adapter catalog, not an allowlist for tenant-defined disciplines.
pub fn catalog() -> Vec<Blueprint> {
    [
        (
            "inbox",
            "Gelen kutusu",
            "Tüm görüşmelerin ortak merkezi.",
            vec![],
            vec!["Görüşmeyi incele", "Yanıtla ve takip et"],
        ),
        (
            "strategy",
            "Strateji",
            "Ajanların ve modüllerin ortak hedefleri.",
            vec![],
            vec![
                "Hedefi tanımla",
                "Stratejiyi onayla",
                "Sonuçları değerlendir",
            ],
        ),
        (
            "growth-studio",
            "Büyüme stüdyosu",
            "Materyalden üretime ve yayın hazırlığına.",
            vec!["Yayın hesabı veya içerik üretim aracı"],
            vec!["Materyalleri topla", "Üretimi hazırla", "Yayını planla"],
        ),
        (
            "people",
            "Kişiler",
            "Müşteri ve kişi kayıtlarını düzenle.",
            vec![],
            vec!["Kişiyi kaydet", "Görüşmeleri takip et"],
        ),
        (
            "prospects",
            "Aday havuzu",
            "Araştırmadan nitelikli adaylara.",
            vec![],
            vec!["Araştır", "Adayları değerlendir"],
        ),
        (
            "outreach",
            "Kampanyalar",
            "İzinli erişim ve takip akışları.",
            vec!["İletişim kanalı"],
            vec!["Kitleyi seç", "İçeriği hazırla", "Sonuçları izle"],
        ),
        (
            "calls",
            "Aramalar",
            "Görüşme senaryoları ve arama takibi.",
            vec!["Telefon erişimi"],
            vec!["Senaryoyu hazırla", "Görüşmeyi yürüt", "Sonucu kaydet"],
        ),
    ]
    .into_iter()
    .map(
        |(id, name, description, requirements, workflow)| Blueprint {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            version: "1.0".into(),
            requirements: requirements.into_iter().map(str::to_owned).collect(),
            workflow: workflow.into_iter().map(str::to_owned).collect(),
            builtin: true,
        },
    )
    .collect()
}
fn invalid(field: &str, message: &str) -> AppError {
    AppError::validation(message, json!({"field":field}))
}
fn valid_text(v: &str, max: usize, required: bool) -> bool {
    (!required || !v.trim().is_empty())
        && v.chars().count() <= max
        && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
}
fn validate_blueprint(b: &Blueprint, id: &str) -> Result<(), AppError> {
    if b.id != id
        || b.builtin
        || b.id.len() < 2
        || b.id.len() > 64
        || !b.id.as_bytes()[0].is_ascii_lowercase()
        || !b
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    {
        return Err(invalid("blueprint.id", "invalid custom blueprint identity"));
    }
    if !valid_text(&b.name, 120, true)
        || !valid_text(&b.description, 2000, false)
        || !valid_text(&b.version, 32, true)
        || [&b.requirements, &b.workflow]
            .iter()
            .any(|v| v.len() > 50 || v.iter().any(|s| !valid_text(s, 500, true)))
    {
        return Err(invalid("blueprint", "blueprint text exceeds its bounds"));
    }
    Ok(())
}
async fn load(repos: &mut dyn TenantRepos) -> Result<Registry, AppError> {
    let mut r: Registry = repos
        .workspace()
        .module_registry()
        .await?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| AppError::internal("invalid stored module registry"))?
        .unwrap_or_default();
    for b in catalog() {
        let required = matches!(b.id.as_str(), "inbox" | "strategy");
        if let Some(m) = r.modules.iter_mut().find(|m| m.blueprint.id == b.id) {
            m.blueprint = b;
            m.required = required;
            if required {
                m.installed = true;
            }
        } else {
            r.modules.push(WorkspaceModule {
                blueprint: b,
                installed: required || r.legacy,
                required,
                config: ModuleConfig::default(),
                revision: 1,
            });
        }
    }
    Ok(r)
}
fn out(r: Registry) -> ModulesOut {
    ModulesOut {
        catalog: r.modules.iter().map(|m| m.blueprint.clone()).collect(),
        modules: r.modules,
    }
}
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    Ok(out(load(repos.as_mut()).await?))
}
async fn save(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    r: &Registry,
    action: &str,
    id: &str,
) -> Result<(), AppError> {
    repos
        .workspace()
        .save_module_registry(
            serde_json::to_value(r).map_err(|_| AppError::internal("serialize module registry"))?,
        )
        .await?;
    repos
        .ledger()
        .append(ledger_entry(
            ctx,
            action,
            "workspace",
            ctx.workspace_id,
            json!({"module_id":id}),
        )?)
        .await?;
    Ok(())
}
pub async fn install(
    deps: &Deps,
    ctx: &Ctx,
    id: &str,
    input: InstallInput,
) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.workspace().lock().await?;
    let mut r = load(repos.as_mut()).await?;
    if let Some(m) = r.modules.iter_mut().find(|m| m.blueprint.id == id) {
        if let Some(mut b) = input.blueprint {
            // Exported portable definitions omit the authoritative builtin marker.
            if m.blueprint.builtin {
                b.builtin = true;
            }
            if b != m.blueprint {
                return Err(AppError::conflict(
                    "blueprint identity already exists; use a new versioned identity",
                ));
            }
        }
        if !m.installed {
            m.installed = true;
            m.revision += 1;
        } else {
            return Ok(out(r));
        }
    } else {
        if r.modules.len() >= 100 {
            return Err(invalid("blueprint", "workspace module limit reached"));
        }
        let b = input
            .blueprint
            .ok_or_else(|| AppError::not_found("unknown blueprint"))?;
        validate_blueprint(&b, id)?;
        r.modules.push(WorkspaceModule {
            blueprint: b,
            installed: true,
            required: false,
            config: ModuleConfig::default(),
            revision: 1,
        });
    }
    save(repos.as_mut(), ctx, &r, "modules.installed", id).await?;
    repos.commit().await?;
    Ok(out(r))
}
async fn validate_config(repos: &mut dyn TenantRepos, c: &ModuleConfig) -> Result<(), AppError> {
    if !valid_text(&c.brief, 8000, false) || c.agent_ids.len() > 50 || c.capability_ids.len() > 100
    {
        return Err(invalid("config", "module configuration exceeds its bounds"));
    }
    if c.agent_ids
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != c.agent_ids.len()
        || c.capability_ids
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != c.capability_ids.len()
    {
        return Err(invalid("config", "duplicate bindings"));
    }
    let keys = repos.api_keys().list().await?;
    for id in &c.agent_ids {
        let a = repos
            .agent_connections()
            .find(*id)
            .await?
            .ok_or_else(|| invalid("agent_ids", "unknown workspace agent"))?;
        let key = keys
            .iter()
            .find(|k| {
                k.id == a.api_key_id && k.status == ApiKeyStatus::Active && k.revoked_at.is_none()
            })
            .ok_or_else(|| invalid("agent_ids", "agent key is inactive"))?;
        if repos
            .memberships()
            .find_by_user(key.issued_by)
            .await?
            .is_none_or(|m| m.status != MembershipStatus::Active)
        {
            return Err(invalid("agent_ids", "agent issuer is inactive"));
        }
    }
    for id in &c.capability_ids {
        if repos
            .capabilities()
            .find(*id)
            .await?
            .is_none_or(|c| c.status == StoredStatus::Retired)
        {
            return Err(invalid(
                "capability_ids",
                "capability is missing or retired",
            ));
        }
    }
    Ok(())
}
pub async fn update(
    deps: &Deps,
    ctx: &Ctx,
    id: &str,
    input: UpdateInput,
) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.workspace().lock().await?;
    let mut r = load(repos.as_mut()).await?;
    let m = r
        .modules
        .iter_mut()
        .find(|m| m.blueprint.id == id && m.installed)
        .ok_or_else(|| AppError::not_found("module is not installed"))?;
    if m.revision != input.revision {
        return Err(AppError::conflict("module changed; reload before saving"));
    }
    validate_config(repos.as_mut(), &input.config).await?;
    if m.config == input.config {
        return Ok(out(r));
    }
    m.config = input.config;
    m.revision += 1;
    save(repos.as_mut(), ctx, &r, "modules.configured", id).await?;
    repos.commit().await?;
    Ok(out(r))
}
pub async fn remove(deps: &Deps, ctx: &Ctx, id: &str) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.workspace().lock().await?;
    let mut r = load(repos.as_mut()).await?;
    let m = r
        .modules
        .iter_mut()
        .find(|m| m.blueprint.id == id)
        .ok_or_else(|| AppError::not_found("unknown module"))?;
    if m.required {
        return Err(invalid("module", "required modules cannot be removed"));
    }
    if !m.installed {
        return Ok(out(r));
    }
    m.installed = false;
    m.revision += 1;
    save(repos.as_mut(), ctx, &r, "modules.removed", id).await?;
    repos.commit().await?;
    Ok(out(r))
}
