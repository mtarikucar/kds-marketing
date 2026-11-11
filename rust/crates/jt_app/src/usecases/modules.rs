//! Tenant-owned, declarative modules. Installation is navigation/configuration, never an
//! execution permission, credential grant, or cancellation of existing jobs.
use super::{Deps, ledger_entry};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{ApiKeyStatus, TenantRepos},
};
use jt_capability::{CapabilityId, StoredStatus, missing_requirements};
use jt_tenancy::{AgentConnectionId, MembershipStatus, Permission};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

/// The strategy: the one module every workspace has and cannot remove.
pub const STRATEGY: &str = "strategy";
/// The four modules the Growth Studio was split into (design
/// `2026-11-10-uc-modul-ve-panel-iskeleti-design.md` §4.4).
pub const CONTENT: &str = "content";
pub const SOCIAL: &str = "social";
pub const ADS: &str = "ads";
/// The library `content`, `social` and `ads` share: installed with any of them (B3).
pub const MATERIALS: &str = "materials";
/// The modules that bring the materials library with them.
pub const NEEDS_MATERIALS: &[&str] = &[CONTENT, SOCIAL, ADS];
/// Removing one of these stops its automation, and the gate refuses its use cases while it is
/// removed (S25). The other builtin modules keep the older rule: removal is navigation only.
pub const INSTALL_GATED: &[&str] = &[CONTENT, SOCIAL, ADS, MATERIALS];

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
    /// Per module id: whether the workspace's connected capabilities meet its requirements
    /// (spec 2026-11-10-module-capability-gating-design.md).
    pub availability: BTreeMap<String, Availability>,
}
/// Whether a module's capability requirements are met, and which are not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Availability {
    pub ready: bool,
    /// The unmet requirement expressions, in their canonical text.
    pub missing: Vec<String>,
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
pub(crate) struct Registry {
    #[serde(default)]
    legacy: bool,
    #[serde(default)]
    pub(crate) modules: Vec<WorkspaceModule>,
}

/// Builtin screens are an adapter catalog, not an allowlist for tenant-defined disciplines.
pub fn catalog() -> Vec<Blueprint> {
    [
        (
            "inbox",
            "Gelen kutusu",
            "Tüm görüşmelerin ortak merkezi.",
            vec!["messaging"],
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
            CONTENT,
            "İçerik oluşturma",
            "Hedeften yayına hazır içerik paketine.",
            vec![],
            // The agent's working guide for an area (design 2026-11-10 §6.2): it reports each
            // step by its number, 1 to 14, and the area page shows them under the same names.
            vec![
                "Amacı belirle: hedef cümlesinden ve onaylı stratejiden bu içeriğin tek amacını çıkar.",
                "Hedef kitleyi tanımla: stratejideki kitlelerden bu içeriğin seslendiğini seç, içerik için daralt.",
                "Platformu ve biçimi seç: alan açılırken seçildiyse ona uy; seçilmediyse bağlı hesaplara ve stratejiye göre belirle.",
                "Konu araştırması: konuyu araştır, dayandığın kaynakları kısa bir liste olarak not et.",
                "Fikir ve yaklaşım: içeriğin fikrini ve anlatım biçimini bir cümleyle yaz.",
                "Ana mesaj: izleyenin aklında kalacak tek mesajı bir cümleyle yaz.",
                "Başlık ve açılış: başlığı ve ilk cümleyi ya da ilk kareyi yaz.",
                "Metin ya da senaryo: açıklama metnini ya da senaryoyu yaz; yer, tarih ve kişi bilgisi kullanılan materyalle çelişmesin.",
                "Materyali üret ya da topla: alanın materyallerini kullan ya da görseli kendin üretip alana ekle; gerçek çekim gerekiyorsa iste ve alanı bırak.",
                "Düzenleme ve tasarım: görseli düzenle ve tasarla; ara çıktıyı not et.",
                "Platforma uyarla: her platform sürümünü kendi biçimine, ölçüsüne ve dosya sayısına göre hazırla.",
                "Paylaşım bilgileri: her sürümün açıklamasını, başlığını, etiketlerini ve bağlantısını yaz.",
                "Son kontrol: materyallerin paylaşım iznini ve metnin materyalle uyumunu denetle; teslimde aynı denetim uygulanır.",
                "Paketle: bütün sürümleri tek pakette teslim et; tutulan sürüm olursa bulguyu düzeltip yeniden teslim et.",
            ],
        ),
        (
            SOCIAL,
            "Sosyal medya yönetimi",
            "Hazır içerikleri planla ve paylaş; hesapların performansını izle.",
            vec!["social_account"],
            vec!["Paketi al", "Zamanı seç", "Paylaş", "Sonucu ölç"],
        ),
        (
            ADS,
            "Reklam yönetimi",
            "Hedef ve bütçeden yayındaki reklama.",
            vec!["ads"],
            vec![
                "Hedefi ve bütçeyi al",
                "Kampanyayı planla",
                "Kur ve izle",
                "İyileştir",
            ],
        ),
        (
            MATERIALS,
            "Materyal kütüphanesi",
            "Fotoğraf, video ve biten içeriklerin ortak deposu.",
            vec![],
            vec!["Materyali yükle", "Etiketle ve izin ver", "Kullanıma sun"],
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
            vec!["mailbox|sms_line|whatsapp_cloud"],
            vec!["Kitleyi seç", "İçeriği hazırla", "Sonuçları izle"],
        ),
        (
            "calls",
            "Aramalar",
            "Görüşme senaryoları ve arama takibi.",
            vec!["telephony"],
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
/// A stored registry (`None`: the workspace has no row) with the builtin catalog applied: every
/// builtin blueprint is present and current, a builtin the catalog no longer has is dropped, only
/// the strategy is required, and the materials library is installed whenever a module that needs
/// it is (B3).
pub(crate) fn resolve(data: Option<serde_json::Value>) -> Result<Registry, AppError> {
    let mut r: Registry = data
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| AppError::internal("invalid stored module registry"))?
        .unwrap_or_default();
    let builtins = catalog();
    r.modules
        .retain(|m| !m.blueprint.builtin || builtins.iter().any(|b| b.id == m.blueprint.id));
    for b in builtins {
        let required = b.id == STRATEGY;
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
    let needed = r
        .modules
        .iter()
        .any(|m| m.installed && NEEDS_MATERIALS.contains(&m.blueprint.id.as_str()));
    if needed && let Some(m) = r.modules.iter_mut().find(|m| m.blueprint.id == MATERIALS) {
        m.installed = true;
    }
    Ok(r)
}
async fn load(repos: &mut dyn TenantRepos) -> Result<Registry, AppError> {
    resolve(repos.workspace().module_registry().await?)
}
/// Whether module `id` is installed in a stored registry (`None`: the workspace has no row). Pure:
/// the catalog, the legacy flag and the materials dependency decide, as they do for [`list`].
pub fn installed_in(data: Option<&serde_json::Value>, id: &str) -> Result<bool, AppError> {
    Ok(resolve(data.cloned())?
        .modules
        .iter()
        .any(|m| m.installed && m.blueprint.id == id))
}
/// The Studio lanes stopped because their module is removed (S25): the organic lane with social
/// media, the paid lane with advertising. What `StudioControl::removed` is read from.
pub fn removed_lanes(
    data: Option<&serde_json::Value>,
) -> Result<BTreeSet<jt_strategy::LaneKind>, AppError> {
    let r = resolve(data.cloned())?;
    let installed = |id: &str| {
        r.modules
            .iter()
            .any(|m| m.installed && m.blueprint.id == id)
    };
    let mut lanes = BTreeSet::new();
    if !installed(SOCIAL) {
        lanes.insert(jt_strategy::LaneKind::Organic);
    }
    if !installed(ADS) {
        lanes.insert(jt_strategy::LaneKind::Paid);
    }
    Ok(lanes)
}
/// Whether module `id` is installed in the workspace of `repos`.
pub async fn installed(repos: &mut dyn TenantRepos, id: &str) -> Result<bool, AppError> {
    installed_in(repos.workspace().module_registry().await?.as_ref(), id)
}
/// The workspace's capabilities as (kind key, stored status), what requirements are judged by.
async fn capability_states(
    repos: &mut dyn TenantRepos,
) -> Result<Vec<(String, StoredStatus)>, AppError> {
    Ok(repos
        .capabilities()
        .list(Default::default())
        .await?
        .into_iter()
        .map(|c| (c.kind_key, c.status))
        .collect())
}
fn availability(b: &Blueprint, caps: &[(String, StoredStatus)]) -> Availability {
    let states: Vec<(&str, StoredStatus)> = caps.iter().map(|(k, s)| (k.as_str(), *s)).collect();
    let missing = missing_requirements(b.requirements.iter().map(String::as_str), &states);
    Availability {
        ready: missing.is_empty(),
        missing,
    }
}
/// The unmet requirements of module `id` in the workspace of `repos`: empty when it is ready or
/// unknown (a module the registry does not hold gates nothing).
pub async fn missing_for(repos: &mut dyn TenantRepos, id: &str) -> Result<Vec<String>, AppError> {
    let Some(b) = catalog().into_iter().find(|b| b.id == id) else {
        return Ok(Vec::new());
    };
    let caps = capability_states(repos).await?;
    Ok(availability(&b, &caps).missing)
}
fn out(r: Registry, caps: &[(String, StoredStatus)]) -> ModulesOut {
    ModulesOut {
        catalog: r.modules.iter().map(|m| m.blueprint.clone()).collect(),
        availability: r
            .modules
            .iter()
            .map(|m| (m.blueprint.id.clone(), availability(&m.blueprint, caps)))
            .collect(),
        modules: r.modules,
    }
}
pub async fn list(deps: &Deps, ctx: &Ctx) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let caps = capability_states(repos.as_mut()).await?;
    Ok(out(load(repos.as_mut()).await?, &caps))
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
    let caps = capability_states(repos.as_mut()).await?;
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
            return Ok(out(r, &caps));
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
    if NEEDS_MATERIALS.contains(&id)
        && let Some(m) = r
            .modules
            .iter_mut()
            .find(|m| m.blueprint.id == MATERIALS && !m.installed)
    {
        m.installed = true;
        m.revision += 1;
    }
    save(repos.as_mut(), ctx, &r, "modules.installed", id).await?;
    repos.commit().await?;
    resume_or_pause(deps, ctx, id).await;
    Ok(out(r, &caps))
}
/// After `ads` was installed or removed: the bound ad sets and the campaigns Jeeta built follow
/// at their provider, as they do after a brake. Best effort; the scheduler's reconciliation and
/// the campaign watch retry what this could not do.
async fn resume_or_pause(deps: &Deps, ctx: &Ctx, id: &str) {
    if id == ADS {
        let _ = super::studio::control::reconcile_bindings(deps, ctx.workspace_id).await;
        let _ = super::ads::watch::watch_all(deps, ctx.workspace_id, ctx.now).await;
    }
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
    let caps = capability_states(repos.as_mut()).await?;
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
        return Ok(out(r, &caps));
    }
    m.config = input.config;
    m.revision += 1;
    save(repos.as_mut(), ctx, &r, "modules.configured", id).await?;
    repos.commit().await?;
    Ok(out(r, &caps))
}
pub async fn remove(deps: &Deps, ctx: &Ctx, id: &str) -> Result<ModulesOut, AppError> {
    ctx.require(Permission::CapabilitiesManage)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    repos.workspace().lock().await?;
    let mut r = load(repos.as_mut()).await?;
    let caps = capability_states(repos.as_mut()).await?;
    let needed = id == MATERIALS
        && r.modules
            .iter()
            .any(|m| m.installed && NEEDS_MATERIALS.contains(&m.blueprint.id.as_str()));
    let m = r
        .modules
        .iter_mut()
        .find(|m| m.blueprint.id == id)
        .ok_or_else(|| AppError::not_found("unknown module"))?;
    if m.required {
        return Err(invalid("module", "required modules cannot be removed"));
    }
    if !m.installed {
        return Ok(out(r, &caps));
    }
    if needed {
        return Err(invalid(
            "module",
            "the materials library is needed by an installed module",
        ));
    }
    m.installed = false;
    m.revision += 1;
    save(repos.as_mut(), ctx, &r, "modules.removed", id).await?;
    repos.commit().await?;
    resume_or_pause(deps, ctx, id).await;
    Ok(out(r, &caps))
}
