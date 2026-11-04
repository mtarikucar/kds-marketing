//! Materials: a stored file with its olay or genel, its origin, its share permission and its tags
//! (spec §4.2, §5.3, D2–D6, D8, D17).
use super::{
    check_people, conflict, decider, invalid, nullable, open, person, person_required, refused,
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        files::StoredFile,
        materials::{
            Binding, ContentType, Depicts, Door, HumanMark, Material, MaterialId, Olay, OlayId,
            Origin, ProductGroup, Quality, ShareDecision, SharePermission, Subject, Tags, UseRole,
        },
    },
    usecases::{
        Deps, ledger_entry,
        studio::{
            control::human_required,
            files::{decode, encode, key},
        },
    },
};
use jt_capability::CapabilityId;
use jt_studio::{
    FileId, MaterialUsage, PieceId, PublicationId, SlotId, SlotNeed, SlotState, TagKey,
    istanbul_day, olay_suggestions, rank_materials,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use url::Url;
use uuid::Uuid;

/// `studio.material_add`'s input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialAddInput {
    pub request_key: String,
    /// A file stored by `studio.file_upload`; one material per file.
    pub file_id: FileId,
    /// The olay it comes from, or none with `genel`.
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    /// Evergreen, bound to no olay. A real genel material is freed by the human adding it.
    #[serde(default)]
    pub genel: bool,
    pub origin: Origin,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub product_groups: BTreeSet<ProductGroup>,
    #[serde(default)]
    pub doors: BTreeSet<Door>,
    #[serde(default)]
    pub content_types: BTreeSet<ContentType>,
    #[serde(default)]
    pub quality: Option<Quality>,
    /// What it shows that needs a human's permission; mandatory (possibly empty) for an AI image.
    #[serde(default)]
    pub depicts: Option<BTreeSet<Depicts>>,
    /// The inbox persons it shows.
    #[serde(default)]
    pub people: BTreeSet<Uuid>,
    /// The share permission: mandatory from an owner or manager; an agent gives one only for an
    /// AI image that depicts nothing and names no person.
    #[serde(default)]
    pub share: Option<SharePermission>,
    /// When it was taken, if the file's bytes do not say.
    #[serde(default, with = "jt_studio::time_compat::option")]
    pub captured_at: Option<OffsetDateTime>,
}

/// `studio.material_add`'s answer: the material and the olays its capture day suggests.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MaterialAddOut {
    pub material: Material,
    pub olay_suggestions: Vec<Olay>,
}

/// What `studio.material_add`'s request key keeps (D40): the material's id and its suggested
/// olays', never the records, which name people and hold the owner's words. A replay reads them as
/// they are now: after an erasure, the redacted material.
#[derive(Serialize, Deserialize)]
struct AddReceipt {
    material_id: MaterialId,
    olay_suggestions: Vec<OlayId>,
}

impl AddReceipt {
    fn of(out: &MaterialAddOut) -> Self {
        Self {
            material_id: out.material.id,
            olay_suggestions: out.olay_suggestions.iter().map(|o| o.id).collect(),
        }
    }

    /// The answer the receipt names, read again.
    async fn read(r: &mut dyn TenantRepos, receipt: Value) -> Result<MaterialAddOut, AppError> {
        let AddReceipt {
            material_id,
            olay_suggestions,
        } = decode(receipt)?;
        let material = load(r, material_id).await?;
        let mut olays = Vec::new();
        for id in olay_suggestions {
            if let Some(o) = r.studio_materials().get_olay(id).await? {
                olays.push(o);
            }
        }
        Ok(MaterialAddOut {
            material,
            olay_suggestions: olays,
        })
    }
}

/// `studio.material_tag`'s input: each field given replaces that set (`[]` empties it; `null`
/// clears the quality).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialTagInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    #[serde(default)]
    pub product_groups: Option<BTreeSet<ProductGroup>>,
    #[serde(default)]
    pub doors: Option<BTreeSet<Door>>,
    #[serde(default)]
    pub content_types: Option<BTreeSet<ContentType>>,
    #[serde(default, deserialize_with = "nullable")]
    pub quality: Option<Option<Quality>>,
    #[serde(default)]
    pub depicts: Option<BTreeSet<Depicts>>,
    #[serde(default)]
    pub people: Option<BTreeSet<Uuid>>,
}

/// One material, by id.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialIdInput {
    pub material_id: MaterialId,
}

/// Which materials `studio.materials_list` answers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialState {
    /// Not erased.
    #[default]
    Live,
    Erased,
    /// Live, and waiting for a person: no share permission, an AI image that depicts something or
    /// names a person and whose permission an agent set, no quality, or tags no person reviewed.
    NeedsReview,
    All,
}

/// `studio.materials_list`'s filter.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialsQuery {
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    #[serde(default)]
    pub state: MaterialState,
}

/// `studio.material_permission`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialPermissionInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    pub permission: SharePermission,
}

/// `studio.material_free`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialFreeInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    pub free: bool,
}

/// `studio.material_bind`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialBindInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    pub binding: Binding,
}

/// `studio.material_delete`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialDeleteInput {
    pub material_id: MaterialId,
    pub expected_revision: u64,
    #[serde(default)]
    pub confirm: bool,
}

/// A publication that showed a material.
#[derive(Clone, Debug, Serialize)]
pub struct PublishedIn {
    pub publication_id: PublicationId,
    pub capability_id: CapabilityId,
    pub external_id: String,
    pub url: Option<Url>,
    #[serde(with = "jt_studio::time_compat")]
    pub published_at: OffsetDateTime,
}

/// A piece revision that showed a material, its slot and what it was published as. Posts stay on
/// their provider when a material is deleted (spec §9.3): this names them.
#[derive(Clone, Debug, Serialize)]
pub struct UsedIn {
    pub slot_id: SlotId,
    pub piece_id: PieceId,
    pub revision: u64,
    pub role: UseRole,
    pub slot_state: Option<SlotState>,
    #[serde(with = "jt_studio::time_compat::option")]
    pub scheduled_at: Option<OffsetDateTime>,
    pub publications: Vec<PublishedIn>,
}

/// A material with where it was used.
#[derive(Clone, Debug, Serialize)]
pub struct MaterialDetail {
    pub material: Material,
    pub used_in: Vec<UsedIn>,
}

/// One material a slot's piece may show (`studio.slot_materials`).
#[derive(Clone, Debug, Serialize)]
pub struct SlotCandidate {
    pub material_id: MaterialId,
    pub file_id: FileId,
    pub mime: String,
    pub subject: Subject,
    pub role: UseRole,
    pub matches_need: bool,
}

/// A material a slot's piece may not show, with why.
#[derive(Clone, Debug, Serialize)]
pub struct SlotRefusal {
    pub material_id: MaterialId,
    pub code: &'static str,
}

/// `studio.slot_materials`'s answer.
#[derive(Clone, Debug, Serialize)]
pub struct SlotMaterialsOut {
    pub slot_id: SlotId,
    #[serde(with = "jt_studio::time_compat")]
    pub scheduled_at: OffsetDateTime,
    /// The tags the slot's anchor needs, from its hypothesis's segment and its content type.
    pub need: SlotNeed,
    /// Best first: the anchors that match the need, the other anchors, the supporting visuals.
    pub candidates: Vec<SlotCandidate>,
    pub refused: Vec<SlotRefusal>,
}

/// The slot of the path, for `studio.slot_materials`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlotMaterialsInput {
    pub slot_id: SlotId,
}

fn keys<T: TagKey>(set: &BTreeSet<T>) -> Vec<&'static str> {
    set.iter().map(|t| t.key()).collect()
}

/// The ledger payload of a material: ids, binding and origin kinds, permission and tag keys.
fn summary(m: &Material) -> Value {
    json!({
        "file_id": m.file_id,
        "binding": match m.binding { Binding::Olay { .. } => "olay", Binding::Genel => "genel" },
        "olay_id": m.olay_id(),
        "origin": match &m.origin { Origin::Real => "real", Origin::AiGenerated { .. } => "ai_generated" },
        "generator": match &m.origin { Origin::Real => None, Origin::AiGenerated { generator } => Some(generator) },
        "share": m.share.as_ref().map(|s| s.permission),
        "share_by_human": m.share.as_ref().map(|s| s.by.is_some()),
        "freed": m.freed.is_some(),
        "product_groups": keys(&m.tags.product_groups),
        "doors": keys(&m.tags.doors),
        "content_types": keys(&m.tags.content_types),
        "quality": m.tags.quality.map(Quality::key),
        "depicts": keys(&m.tags.depicts),
        "people": m.people.len(),
        "revision": m.revision,
    })
}

async fn append(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    m: &Material,
    extra: Value,
) -> Result<(), AppError> {
    let mut payload = summary(m);
    if let (Some(p), Value::Object(more)) = (payload.as_object_mut(), extra) {
        p.extend(more);
    }
    r.ledger()
        .append(ledger_entry(ctx, action, "studio_material", m.id, payload)?)
        .await?;
    Ok(())
}

/// The material of `id`, `NOT_FOUND` when there is none.
async fn load(r: &mut dyn TenantRepos, id: MaterialId) -> Result<Material, AppError> {
    r.studio_materials()
        .get_material(id)
        .await?
        .ok_or_else(|| AppError::not_found("material"))
}

/// The live material of `id` at `expected_revision`, for a change.
async fn live(
    r: &mut dyn TenantRepos,
    id: MaterialId,
    expected_revision: u64,
) -> Result<Material, AppError> {
    let m = load(r, id).await?;
    if m.erased_at.is_some() {
        return Err(conflict("material_erased"));
    }
    if m.revision != expected_revision {
        return Err(AppError::conflict("material revision changed"));
    }
    Ok(m)
}

/// `m` at its next revision.
fn next(mut m: Material) -> Result<Material, AppError> {
    m.revision = m
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::conflict("revision overflow"))?;
    Ok(m)
}

/// Where material `m` was used: each piece revision that showed it, its slot and publications.
pub(crate) async fn detail(
    r: &mut dyn TenantRepos,
    material: Material,
) -> Result<MaterialDetail, AppError> {
    let uses = r.studio_materials().uses_of(material.id).await?;
    let publications = if uses.is_empty() {
        Vec::new()
    } else {
        r.studio().list_publications().await?
    };
    let mut used_in = Vec::new();
    for u in uses {
        let slot = r.studio().get_slot(u.slot_id).await?;
        used_in.push(UsedIn {
            slot_id: u.slot_id,
            piece_id: u.piece_id,
            revision: u.revision,
            role: u.role,
            slot_state: slot.as_ref().map(|s| s.state),
            scheduled_at: slot.as_ref().map(|s| s.scheduled_at),
            publications: publications
                .iter()
                .filter(|p| p.piece_id == u.piece_id)
                .map(|p| PublishedIn {
                    publication_id: p.id,
                    capability_id: p.capability_id,
                    external_id: p.external_id.clone(),
                    url: p.url.clone(),
                    published_at: p.published_at,
                })
                .collect(),
        });
    }
    Ok(MaterialDetail { material, used_in })
}

/// Whether a person still has to look at `m` (`MaterialState::NeedsReview`).
fn needs_review(m: &Material) -> bool {
    m.erased_at.is_none()
        && (m.share.is_none()
            || (m.needs_human_permission() && m.share.as_ref().is_some_and(|s| s.by.is_none()))
            || m.tags.quality.is_none()
            || m.tags_reviewed_by.is_none())
}

/// The workspace's materials, newest first: `state` (live unless said) and `olay_id` filter.
pub async fn materials_list(
    d: &Deps,
    ctx: &Ctx,
    q: MaterialsQuery,
) -> Result<Vec<Material>, AppError> {
    let mut r = open(d, ctx).await?;
    Ok(r.studio_materials()
        .list_materials()
        .await?
        .into_iter()
        .filter(|m| q.olay_id.is_none_or(|o| m.olay_id() == Some(o)))
        .filter(|m| match q.state {
            MaterialState::Live => m.erased_at.is_none(),
            MaterialState::Erased => m.erased_at.is_some(),
            MaterialState::NeedsReview => needs_review(m),
            MaterialState::All => true,
        })
        .collect())
}

/// One material with where it was used.
pub async fn material_get(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialIdInput,
) -> Result<MaterialDetail, AppError> {
    let mut r = open(d, ctx).await?;
    let m = load(r.as_mut(), i.material_id).await?;
    detail(r.as_mut(), m).await
}

/// The file `file` names, a live Studio file of the workspace (`NOT_FOUND`).
async fn stored_file(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    file: FileId,
) -> Result<StoredFile, AppError> {
    r.studio()
        .get_file(file)
        .await?
        .filter(|f| f.workspace_id == ctx.workspace_id && f.deleted_at.is_none())
        .ok_or_else(|| AppError::not_found("file"))
}

/// What `material_add` checks before and after reading the file's bytes: the file is stored and no
/// material's yet, its bytes are no material's (D36), and the olay exists.
async fn add_checks(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    i: &MaterialAddInput,
) -> Result<StoredFile, AppError> {
    let file = stored_file(r, ctx, i.file_id).await?;
    if let Some(m) = r.studio_materials().material_by_file(i.file_id).await? {
        return Err(AppError {
            details: json!({"reason":"file_has_material","material_id":m.id}),
            ..conflict("file_has_material")
        });
    }
    // The same bytes under a new file id: a photo once refused, deleted or erased with its person
    // never comes back as another material, real or "AI" (D36, D37).
    if let Some(m) = r
        .studio_materials()
        .material_by_sha256(&file.sha256)
        .await?
    {
        return Err(AppError {
            details: json!({"reason":"duplicate_material_file","material_id":m.id}),
            ..conflict("duplicate_material_file")
        });
    }
    if let Some(o) = i.olay_id
        && r.studio_materials().get_olay(o).await?.is_none()
    {
        return Err(AppError::not_found("olay"));
    }
    Ok(file)
}

/// What a new material is given by who adds it.
struct Decided {
    binding: Binding,
    depicts: BTreeSet<Depicts>,
    freed: Option<HumanMark>,
    share: Option<ShareDecision>,
}

/// Who decides what of a new material (D4, D5, D8, D17): its binding, its `depicts`, a real genel
/// material's freeing and its share permission, or the refusal.
fn decide(ctx: &Ctx, i: &MaterialAddInput) -> Result<Decided, AppError> {
    let ai = matches!(i.origin, Origin::AiGenerated { .. });
    let binding = match (i.olay_id, i.genel) {
        (Some(olay_id), false) => Binding::Olay { olay_id },
        (None, true) => Binding::Genel,
        _ => {
            return Err(refused(
                "olay_id",
                "olay_or_genel",
                "a material names its olay, or is genel",
            ));
        }
    };
    let depicts = match (&i.depicts, ai) {
        (Some(d), _) => d.clone(),
        (None, false) => BTreeSet::new(),
        (None, true) => {
            return Err(refused(
                "depicts",
                "depicts_required",
                "an AI image names what it depicts (an empty list when nothing)",
            ));
        }
    };
    let by = decider(ctx);
    let freed = match (&binding, ai, by) {
        (Binding::Genel, false, Some(by)) => Some(HumanMark { by, at: ctx.now }),
        (Binding::Genel, false, None) => return Err(human_required()),
        _ => None,
    };
    let share = match (i.share, by) {
        (Some(permission), Some(by)) => Some(ShareDecision {
            permission,
            by: Some(by),
            at: ctx.now,
        }),
        (None, Some(_)) => {
            return Err(refused(
                "share",
                "share_required",
                "the share permission is the adding person's decision",
            ));
        }
        // A named person counts as a `depicts` flag (D38).
        (Some(permission), None) if ai && depicts.is_empty() && i.people.is_empty() => {
            Some(ShareDecision {
                permission,
                by: None,
                at: ctx.now,
            })
        }
        (Some(_), None) => return Err(human_required()),
        (None, None) => None,
    };
    Ok(Decided {
        binding,
        depicts,
        freed,
        share,
    })
}

/// Adds a stored file to the library as a material (spec §5.3). Its capture time is read from its
/// bytes (outside any transaction, a JPEG's first part or a video's boxes up to `mvhd`, never the
/// whole file, D41), else taken from the input; the answer names the olays whose dates contain its
/// Istanbul day. Nothing is bound by that suggestion.
///
/// The rules of who decides what (D4, D5, D17): an owner or manager in person gives the share
/// permission (mandatory) and may add a real genel material, which that frees; an agent (or
/// another person) adds a real material with no permission, and an AI image with a permission only
/// while it depicts nothing and names no person (D38). An AI image names its `depicts` (possibly
/// empty). Replayed by `request_key`, answering the material and the suggested olays as they are
/// now (D40).
pub async fn material_add(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialAddInput,
) -> Result<MaterialAddOut, AppError> {
    key(&i.request_key)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    let mut r = open(d, ctx).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.material_add", &i.request_key, &payload)
        .await?
    {
        return AddReceipt::read(r.as_mut(), v).await;
    }
    let Decided {
        binding,
        depicts,
        freed,
        share,
    } = decide(ctx, &i)?;
    let file = add_checks(r.as_mut(), ctx, &i).await?;
    drop(r);
    // The capture time, from what the stored bytes say of themselves, read under no transaction
    // and without holding the file (D41).
    let captured_at = super::capture::capture_time_of(d, &file)
        .await?
        .or(i.captured_at);
    let material = Material {
        id: MaterialId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        file_id: file.id,
        mime: file.mime.clone(),
        title: i.title.clone(),
        origin: i.origin.clone(),
        binding,
        freed,
        share,
        tags: Tags {
            product_groups: i.product_groups.clone(),
            doors: i.doors.clone(),
            content_types: i.content_types.clone(),
            quality: i.quality,
            depicts,
        },
        tags_reviewed_by: person(ctx),
        people: i.people.clone(),
        captured_at,
        created_by: ctx.actor.clone(),
        revision: 1,
        created_at: ctx.now,
        erased_at: None,
    };
    material.validate().map_err(invalid)?;
    let mut r = open(d, ctx).await?;
    if !material.people.is_empty() {
        r.people().lock_workspace().await?;
    }
    if let Some(v) = r
        .studio()
        .request_replay("studio.material_add", &i.request_key, &payload)
        .await?
    {
        return AddReceipt::read(r.as_mut(), v).await;
    }
    r.studio_control().lock_control().await?;
    add_checks(r.as_mut(), ctx, &i).await?;
    check_people(r.as_mut(), material.people.iter().copied()).await?;
    r.studio_materials()
        .insert_material(material.clone())
        .await?;
    append(
        r.as_mut(),
        ctx,
        "studio.material.added",
        &material,
        json!({}),
    )
    .await?;
    let olays = r.studio_materials().list_olays().await?;
    let out = MaterialAddOut {
        olay_suggestions: material
            .captured_at
            .map(|at| {
                olay_suggestions(&olays, istanbul_day(at))
                    .into_iter()
                    .cloned()
                    .collect()
            })
            .unwrap_or_default(),
        material,
    };
    r.studio()
        .request_receipt(
            "studio.material_add",
            &i.request_key,
            &payload,
            &encode(&AddReceipt::of(&out))?,
        )
        .await?;
    r.commit().await?;
    Ok(out)
}

/// Changes a material's tags, quality, depicts and people at its expected revision. A person's
/// edit marks the tags reviewed by them; an agent's is a suggestion again (no reviewer), and an
/// agent never removes a `depicts` flag or a person (privacy markers only a person corrects). A
/// new `depicts` flag or a new person clears the material's share permission, whether an agent or
/// a human gave it: an owner or manager decides again, and meanwhile it is listed as needing
/// review (D5, D17, D38, D45). Removing a marker keeps the permission.
pub async fn material_tag(d: &Deps, ctx: &Ctx, i: MaterialTagInput) -> Result<Material, AppError> {
    let given = [
        ("product_groups", i.product_groups.is_some()),
        ("doors", i.doors.is_some()),
        ("content_types", i.content_types.is_some()),
        ("quality", i.quality.is_some()),
        ("depicts", i.depicts.is_some()),
        ("people", i.people.is_some()),
    ];
    let fields: Vec<&str> = given.iter().filter(|(_, g)| *g).map(|(f, _)| *f).collect();
    if fields.is_empty() {
        return Err(crate::usecases::nothing_to_change(&given.map(|(f, _)| f)));
    }
    let mut r = open(d, ctx).await?;
    if i.people.as_ref().is_some_and(|p| !p.is_empty()) {
        r.people().lock_workspace().await?;
    }
    r.studio_control().lock_control().await?;
    let current = live(r.as_mut(), i.material_id, i.expected_revision).await?;
    let reviewer = person(ctx);
    if reviewer.is_none() {
        if i.depicts
            .as_ref()
            .is_some_and(|d| !current.tags.depicts.is_subset(d))
        {
            return Err(person_required("depicts"));
        }
        if i.people
            .as_ref()
            .is_some_and(|p| !current.people.is_subset(p))
        {
            return Err(person_required("people"));
        }
    }
    let mut m = next(current.clone())?;
    if let Some(v) = i.product_groups {
        m.tags.product_groups = v;
    }
    if let Some(v) = i.doors {
        m.tags.doors = v;
    }
    if let Some(v) = i.content_types {
        m.tags.content_types = v;
    }
    if let Some(v) = i.quality {
        m.tags.quality = v;
    }
    if let Some(v) = i.depicts {
        m.tags.depicts = v;
    }
    if let Some(v) = i.people {
        m.people = v;
    }
    m.tags_reviewed_by = reviewer;
    // A new privacy marker reopens the permission, whoever gave it: it was given for what the
    // material was known to show (D45). An agent's own permission never covers a marker (D38).
    let marked =
        !m.tags.depicts.is_subset(&current.tags.depicts) || !m.people.is_subset(&current.people);
    let share_cleared = m
        .share
        .as_ref()
        .is_some_and(|s| marked || (s.by.is_none() && m.is_ai() && m.needs_human_permission()));
    if share_cleared {
        m.share = None;
    }
    m.validate().map_err(invalid)?;
    let added: Vec<Uuid> = m.people.difference(&current.people).copied().collect();
    check_people(r.as_mut(), added).await?;
    r.studio_materials()
        .update_material(m.clone(), i.expected_revision)
        .await?;
    append(
        r.as_mut(),
        ctx,
        "studio.material.tagged",
        &m,
        json!({"fields": fields, "share_cleared": share_cleared}),
    )
    .await?;
    r.commit().await?;
    Ok(m)
}

/// An owner or manager sets a material's share permission in person (D4); revoking is
/// `not_shareable`.
pub async fn material_permission(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialPermissionInput,
) -> Result<Material, AppError> {
    let by = super::super::control::human_approver(ctx)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut m = next(live(r.as_mut(), i.material_id, i.expected_revision).await?)?;
    m.share = Some(ShareDecision {
        permission: i.permission,
        by: Some(by),
        at: ctx.now,
    });
    m.validate().map_err(invalid)?;
    r.studio_materials()
        .update_material(m.clone(), i.expected_revision)
        .await?;
    append(
        r.as_mut(),
        ctx,
        "studio.material.permission_set",
        &m,
        json!({}),
    )
    .await?;
    r.commit().await?;
    Ok(m)
}

/// An owner or manager frees a real material for generic content ("genel kullanılabilir", D8), or
/// takes that back. A real genel material stays freed: it is genel because a human freed it.
pub async fn material_free(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialFreeInput,
) -> Result<Material, AppError> {
    let by = super::super::control::human_approver(ctx)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut m = next(live(r.as_mut(), i.material_id, i.expected_revision).await?)?;
    if m.is_ai() {
        return Err(refused(
            "material_id",
            "ai_material",
            "only a real material is freed",
        ));
    }
    if !i.free && m.binding == Binding::Genel {
        return Err(refused(
            "free",
            "genel_stays_freed",
            "a real genel material stays freed; bind it to an olay first",
        ));
    }
    m.freed = i.free.then_some(HumanMark { by, at: ctx.now });
    m.validate().map_err(invalid)?;
    r.studio_materials()
        .update_material(m.clone(), i.expected_revision)
        .await?;
    append(
        r.as_mut(),
        ctx,
        "studio.material.freed",
        &m,
        json!({"free": i.free}),
    )
    .await?;
    r.commit().await?;
    Ok(m)
}

/// An owner or manager binds a material to another olay, or makes it genel (D4); a real material
/// made genel is freed by that decision (D8).
pub async fn material_bind(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialBindInput,
) -> Result<Material, AppError> {
    let by = super::super::control::human_approver(ctx)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let mut m = next(live(r.as_mut(), i.material_id, i.expected_revision).await?)?;
    if let Binding::Olay { olay_id } = i.binding
        && r.studio_materials().get_olay(olay_id).await?.is_none()
    {
        return Err(AppError::not_found("olay"));
    }
    m.binding = i.binding;
    if m.binding == Binding::Genel && !m.is_ai() && m.freed.is_none() {
        m.freed = Some(HumanMark { by, at: ctx.now });
    }
    m.validate().map_err(invalid)?;
    r.studio_materials()
        .update_material(m.clone(), i.expected_revision)
        .await?;
    append(r.as_mut(), ctx, "studio.material.bound", &m, json!({})).await?;
    r.commit().await?;
    Ok(m)
}

/// An owner or manager deletes a material (`confirm: true`): it is redacted, keeping its id, file
/// id, origin and binding for what it was used in (spec §9.3). Its bytes go at the next
/// `StudioFilesCleanup` run once no publish attempt in flight (queued, sending, unknown) shows it
/// (D43): a provider may still be reading them. Posts already published stay on their provider:
/// `studio.material_get` names them.
pub async fn material_delete(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialDeleteInput,
) -> Result<Material, AppError> {
    super::super::control::human_approver(ctx)?;
    if !i.confirm {
        return Err(crate::usecases::invalid(
            "confirm",
            "confirm must be true to delete a material",
        ));
    }
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let current = load(r.as_mut(), i.material_id).await?;
    let m = if current.erased_at.is_some() {
        drop(r);
        current
    } else {
        if current.revision != i.expected_revision {
            return Err(AppError::conflict("material revision changed"));
        }
        let m = current.redacted(ctx.now);
        r.studio_materials()
            .update_material(m.clone(), i.expected_revision)
            .await?;
        append(r.as_mut(), ctx, "studio.material.deleted", &m, json!({})).await?;
        r.commit().await?;
        m
    };
    Ok(m)
}

/// When each material was shown: the publications of the pieces that showed it.
pub(crate) async fn usage(r: &mut dyn TenantRepos) -> Result<Vec<MaterialUsage>, AppError> {
    let publications = r.studio().list_publications().await?;
    let mut out = Vec::new();
    for m in r.studio_materials().list_materials().await? {
        for u in r.studio_materials().uses_of(m.id).await? {
            out.extend(
                publications
                    .iter()
                    .filter(|p| p.piece_id == u.piece_id)
                    .map(|p| MaterialUsage {
                        material_id: m.id,
                        at: p.published_at,
                    }),
            );
        }
    }
    Ok(out)
}

/// What the slot's piece may show at the slot's time (spec §8): its need, the eligible materials
/// best first, each with the subject it takes and its role, and the refusals of the others.
pub async fn slot_materials(
    d: &Deps,
    ctx: &Ctx,
    i: SlotMaterialsInput,
) -> Result<SlotMaterialsOut, AppError> {
    let mut r = open(d, ctx).await?;
    let slot = r
        .studio()
        .get_slot(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    let arm = r
        .studio()
        .get_arm(slot.chain.arm_id)
        .await?
        .ok_or_else(|| AppError::not_found("arm"))?;
    let segment = r
        .hypotheses()
        .list(slot.chain.born_version_id)
        .await?
        .into_iter()
        .find(|h| h.id == slot.chain.hypothesis_id)
        .map(|h| h.segment_key)
        .unwrap_or_default();
    let need = SlotNeed::from_keys(&arm.key.content_type, &segment);
    let policy = r.studio_materials().material_policy().await?;
    let materials = r.studio_materials().list_materials().await?;
    let usage = usage(r.as_mut()).await?;
    let lib = super::super::materials::library(r.as_mut(), slot.scheduled_at).await?;
    let (ranked, refusals) = rank_materials(
        &need,
        &materials,
        &usage,
        &policy,
        &lib.context(slot.scheduled_at),
    );
    let of = |id: MaterialId| materials.iter().find(|m| m.id == id);
    Ok(SlotMaterialsOut {
        slot_id: slot.id,
        scheduled_at: slot.scheduled_at,
        need,
        candidates: ranked
            .into_iter()
            .filter_map(|c| {
                of(c.material_id).map(|m| SlotCandidate {
                    material_id: c.material_id,
                    file_id: m.file_id,
                    mime: m.mime.clone(),
                    subject: c.subject,
                    role: c.role,
                    matches_need: c.matches_need,
                })
            })
            .collect(),
        refused: refusals
            .into_iter()
            .map(|(material_id, r)| SlotRefusal {
                material_id,
                code: r.code(),
            })
            .collect(),
    })
}
