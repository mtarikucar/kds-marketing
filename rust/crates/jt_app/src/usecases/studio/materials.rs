//! The material gate (spec `2026-11-03-studio-materials-design.md` D1, D2, §5.5, §5.6): every medium
//! of a piece is a material, at least one an eligible anchor, checked at submission at the slot's
//! time and again at publish time. Studio cannot publish what no real material backs, whatever the
//! approval policy and whoever submits.
//!
//! The truth check (§7) runs beside it: what the piece's texts claim against its subject's and its
//! materials' olays. Its caption findings never refuse a submission; `studio.slot_get` shows them
//! (`material_check`) and the publisher holds the piece until an owner or manager releases those
//! exact findings for that revision (`studio.material_check_release`). A hard finding, an
//! eligibility refusal, is never releasable (D19).
use super::{
    chain::refuse,
    control::human_approver,
    work::{SlotOut, gated, slot_in},
};
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{
        TenantRepos,
        materials::{Calendar, Material, MaterialId, MaterialRelease, Olay, Subject, UseRole},
        studio::ApprovalTarget,
    },
    usecases::{Deps, ledger_entry},
};
use jt_inbox::PersonId;
use jt_studio::{
    CaptionFinding, FileId, MediaAsset, Piece, PieceRefusal, Slot, SlotId, SlotState, UseContext,
    canonical_findings, check_caption, istanbul_day, piece_roles,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

/// The reason a publish is held for its materials ([`publish_check`]).
pub(crate) const MATERIAL_HOLD: &str = "material_check_hold";

/// What the rules read: the workspace's olays and its effective calendar around `at`.
pub(crate) struct Library {
    pub olays: Vec<Olay>,
    pub calendar: Calendar,
    /// The materials policy's `ai_standalone`.
    pub ai_standalone: bool,
}

impl Library {
    pub fn context(&self, at: OffsetDateTime) -> UseContext<'_> {
        UseContext {
            at,
            olays: &self.olays,
            calendar: &self.calendar,
            ai_standalone: self.ai_standalone,
        }
    }
}

/// The workspace's olays, its calendar over every year from its earliest olay to the year after
/// `at`, and its materials policy's standalone setting.
pub(crate) async fn library(
    r: &mut dyn TenantRepos,
    at: OffsetDateTime,
) -> Result<Library, AppError> {
    let olays = r.studio_materials().list_olays().await?;
    let rows = r.studio_materials().calendar_rows().await?;
    let year = istanbul_day(at).year();
    let first = olays
        .iter()
        .map(|o| o.starts_on.year())
        .min()
        .unwrap_or(year)
        .min(year)
        - 1;
    let ai_standalone = r.studio_materials().material_policy().await?.ai_standalone;
    Ok(Library {
        olays,
        calendar: Calendar::effective(first.max(2000)..=(year + 1).min(2100), &rows),
        ai_standalone,
    })
}

/// Every medium of a piece's content, top level and adaptations.
pub(crate) fn media<'a>(
    top: &'a [MediaAsset],
    adaptations: impl Iterator<Item = &'a [MediaAsset]>,
) -> Vec<&'a MediaAsset> {
    top.iter().chain(adaptations.flatten()).collect()
}

fn refused(reason: &str, message: &str, extra: Value) -> AppError {
    let mut details = json!({"field": "media", "reason": reason});
    if let (Some(d), Value::Object(more)) = (details.as_object_mut(), extra) {
        d.extend(more);
    }
    AppError::validation(message.to_owned(), details)
}

/// `VALIDATION` `not_a_material` unless every medium is a stored file (spec D2): inline bytes and
/// hosted URLs carry no provenance.
pub(crate) fn only_files(media: &[&MediaAsset]) -> Result<Vec<FileId>, AppError> {
    let mut files = Vec::new();
    for m in media {
        match m {
            MediaAsset::File { id } => {
                if !files.contains(id) {
                    files.push(*id);
                }
            }
            MediaAsset::HostedUrl { .. } | MediaAsset::Bytes { .. } => {
                return Err(refused(
                    "not_a_material",
                    "every medium of a piece must be a material",
                    json!({}),
                ));
            }
        }
    }
    Ok(files)
}

/// The materials of `files`, in order; `VALIDATION` `not_a_material` when one is no material.
pub(crate) async fn materials_of(
    r: &mut dyn TenantRepos,
    files: &[FileId],
) -> Result<Vec<Material>, AppError> {
    let mut out = Vec::new();
    for f in files {
        match r.studio_materials().material_by_file(*f).await? {
            Some(m) => out.push(m),
            None => {
                return Err(refused(
                    "not_a_material",
                    "every medium of a piece must be a material",
                    json!({"file_id": f}),
                ));
            }
        }
    }
    Ok(out)
}

/// The refusal of a piece's materials as the error a caller gets.
fn piece_refusal(e: PieceRefusal) -> AppError {
    match e {
        PieceRefusal::NoAnchor => refused(
            "no_eligible_material",
            "the piece shows no eligible material",
            json!({}),
        ),
        PieceRefusal::Refused(list) => refused(
            "material_refused",
            "a material of the piece may not be used here",
            json!({"refusals": list.iter().map(|(id, r)| json!({"material_id": id, "code": r.code()})).collect::<Vec<_>>()}),
        ),
    }
}

/// The roles of `materials` in a piece about `subject` at `at`, or the refusal (spec §5.5).
pub(crate) async fn check_piece(
    r: &mut dyn TenantRepos,
    materials: &[Material],
    subject: &Subject,
    at: OffsetDateTime,
) -> Result<Vec<(MaterialId, UseRole)>, AppError> {
    let blocked = super::library::blocked_derivatives(r).await?;
    if let Some(m) = materials.iter().find(|m| blocked.contains(&m.id)) {
        return Err(refused(
            "source_permission_restricted",
            "a derivative source may no longer be shared",
            json!({"material_id":m.id}),
        ));
    }
    let lib = library(r, at).await?;
    let refs: Vec<&Material> = materials.iter().collect();
    piece_roles(&refs, subject, &lib.context(at)).map_err(piece_refusal)
}

/// One hard finding of a piece: an eligibility refusal of one of its materials (spec §4.3), or
/// what holds a piece as a whole (`no_material`, `no_eligible_material`). Never releasable (spec
/// D19): the piece or the material changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardFinding {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_id: Option<MaterialId>,
}

/// The truth check of the piece revision a slot shows (spec §5.5, §5.6, §7): `studio.slot_get`'s
/// `material_check`, and what the publisher checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialCheck {
    /// The piece revision checked.
    pub revision: u64,
    /// The caption findings, sorted and unique: what the piece's texts (and an approved TikTok
    /// posting screen's title) name that its subject's and its materials' olays do not back. A
    /// human may release them, for this revision and these findings only.
    pub findings: Vec<CaptionFinding>,
    /// The SHA-256 of the findings' canonical text, lowercase hex: what a release names. Any new
    /// or changed finding changes it.
    pub digest: String,
    /// Whether an owner or manager released this revision's findings with this digest.
    pub released: bool,
    /// The eligibility refusals at the time the piece would publish (now, or the slot's time when
    /// later), never releasable.
    pub hard: Vec<HardFinding>,
    /// Whether the publisher holds the piece: a hard finding, or caption findings not released.
    pub holds: bool,
}

impl MaterialCheck {
    /// What holds the piece, as `material_check_hold` lists it: each hard finding (`kind`
    /// `hard`), then each caption finding not released (`kind` `caption`).
    fn hold_findings(&self) -> Value {
        let mut out: Vec<Value> = self
            .hard
            .iter()
            .map(|h| json!({"kind": "hard", "code": h.code, "material_id": h.material_id}))
            .collect();
        if !self.released {
            out.extend(self.findings.iter().map(|f| {
                json!({"kind": "caption", "code": f.code.code(), "olay_id": f.olay_id,
                    "material_id": f.material_id, "matched": f.matched})
            }));
        }
        Value::Array(out)
    }
}

/// The SHA-256 of `findings`' canonical text, lowercase hex.
pub(crate) fn findings_digest(findings: &[CaptionFinding]) -> String {
    crate::usecases::hash_token(&canonical_findings(findings))
}

/// The most merges followed from an olay's client person to the person kept.
const MAX_MERGE_HOPS: usize = 32;

/// The current display name of each olay client person (spec §7), read from the inbox now: a
/// merged person's is the name of the person they were merged into. An erased person has none.
async fn client_names(
    r: &mut dyn TenantRepos,
    olays: &[Olay],
) -> Result<Vec<(Uuid, String)>, AppError> {
    let mut names: Vec<(Uuid, String)> = Vec::new();
    for linked in olays
        .iter()
        .filter_map(|o| o.client.as_ref().and_then(|c| c.person_id))
    {
        if names.iter().any(|(id, _)| *id == linked) {
            continue;
        }
        let mut id = PersonId(linked);
        for _ in 0..MAX_MERGE_HOPS {
            let Some(p) = r.people().get(id).await? else {
                break;
            };
            if let Some(next) = p.merged_into {
                id = next;
                continue;
            }
            if p.erased_at.is_none() && !p.display_name.trim().is_empty() {
                names.push((linked, p.display_name));
            }
            break;
        }
    }
    Ok(names)
}

/// The truth check of `piece`, slot `slot`'s piece at its revision, at `at` (spec §5.6, §7):
/// `None` when the piece records no materials (submitted before the materials library).
pub(crate) async fn material_check(
    r: &mut dyn TenantRepos,
    slot: SlotId,
    piece: &Piece,
    at: OffsetDateTime,
) -> Result<Option<MaterialCheck>, AppError> {
    let Some(recorded) = r
        .studio_materials()
        .piece_materials(slot, piece.revision)
        .await?
    else {
        return Ok(None);
    };
    let mut materials = Vec::new();
    for u in &recorded.uses {
        let m = r
            .studio_materials()
            .get_material(u.material_id)
            .await?
            .ok_or_else(|| AppError::internal("a recorded material is missing"))?;
        materials.push(m);
    }
    // The texts that go out: the piece's, each adaptation's, and the title a human left on the
    // TikTok posting screen, which replaces the drafted text there.
    let title = r
        .studio()
        .get_approval(ApprovalTarget::Slot(slot), piece.revision)
        .await?
        .and_then(|a| a.tiktok)
        .map(|t| t.title);
    let mut texts: Vec<&str> = vec![piece.text.as_str()];
    texts.extend(piece.adaptations.values().map(|a| a.text.as_str()));
    texts.extend(title.as_deref());
    // A story's text never goes out (Instagram takes no caption for one): nothing to check.
    if r.studio_posts()
        .get_post(slot)
        .await?
        .is_some_and(|p| p.format == jt_studio::PostFormat::Story)
    {
        texts.clear();
    }
    let (hard, findings) = check_content(r, &materials, &recorded.subject, &texts, at).await?;
    let digest = findings_digest(&findings);
    let released = r
        .studio_materials()
        .get_release(slot, piece.revision)
        .await?
        .is_some_and(|x| x.digest == digest);
    let holds = !hard.is_empty() || (!findings.is_empty() && !released);
    Ok(Some(MaterialCheck {
        revision: piece.revision,
        findings,
        digest,
        released,
        hard,
        holds,
    }))
}

fn hold(findings: Value) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: MATERIAL_HOLD.into(),
        details: json!({"reason": MATERIAL_HOLD, "findings": findings}),
    }
}

/// `CONFLICT` [`MATERIAL_HOLD`] unless the piece of slot `slot` at its revision still passes the
/// material gate at `now` (spec §5.6): its recorded materials (`no_material` when none were
/// recorded) each still eligible for its subject, and its caption findings (spec §7) none, or
/// released by a human for this revision with the digest they have now. `details.findings` lists
/// what holds it: each hard finding (`kind` `hard`), then each caption finding not released
/// (`kind` `caption`).
pub(crate) async fn publish_check(
    r: &mut dyn TenantRepos,
    slot: &Slot,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let piece = r
        .studio()
        .get_piece(slot.id, slot.revision)
        .await?
        .ok_or_else(|| AppError::not_found("piece"))?;
    match material_check(r, slot.id, &piece, now).await? {
        None => Err(hold(json!([{"kind": "hard", "code": "no_material"}]))),
        Some(check) if check.holds => Err(hold(check.hold_findings())),
        Some(_) => Ok(()),
    }
}

/// What a material hold asks for (spec §5.6): `fix_piece_or_release` when only caption findings
/// hold it, `fix_piece` when a hard finding does (D19).
pub(crate) fn hold_next_action(findings: &Value) -> &'static str {
    let caption_only = findings
        .as_array()
        .is_some_and(|f| !f.is_empty() && f.iter().all(|f| f["kind"] == "caption"));
    if caption_only {
        "fix_piece_or_release"
    } else {
        "fix_piece"
    }
}

/// `studio.material_check_release`'s input: the slot's revision and the digest of the findings
/// the human saw.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialCheckReleaseInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
    pub digest: String,
}

/// An owner or manager, in person, releases the caption findings of a slot's piece at its
/// current revision (spec §7, D4, D19): the publisher no longer holds the piece for them while
/// they stay the findings released. Refused (`CONFLICT`) when the revision moved
/// (`revision_changed`), when any hard finding holds the piece (`hard_findings_not_releasable`:
/// change the piece or the material), when there is nothing to release (`no_caption_findings`),
/// or when the findings are no longer those of `digest` (`findings_changed`). Releasing the same
/// findings again writes nothing. The ledger names the slot, the revision, the digest and the
/// finding codes, never a caption or a name.
pub async fn material_check_release(
    d: &Deps,
    ctx: &Ctx,
    i: MaterialCheckReleaseInput,
) -> Result<SlotOut, AppError> {
    ctx.require_any(crate::usecases::studio::permissions::for_use_case(
        "studio.material_check_release",
    ))?;
    let by = human_approver(ctx)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let frame = gated(
        r.as_mut(),
        ctx,
        crate::usecases::studio::permissions::for_use_case("studio.material_check_release"),
    )
    .await?;
    if i.digest.len() != 64
        || !i
            .digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(AppError::validation(
            "the digest is 64 lowercase hex characters",
            json!({"field": "digest"}),
        ));
    }
    r.studio_control().lock_control().await?;
    let s = r
        .studio()
        .get_slot(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    if s.revision != i.expected_revision {
        return Err(refuse("revision_changed"));
    }
    if s.state != SlotState::Ready {
        return Err(refuse("slot_not_ready"));
    }
    let piece = r
        .studio()
        .get_piece(s.id, s.revision)
        .await?
        .ok_or_else(|| AppError::not_found("piece"))?;
    let check = material_check(r.as_mut(), s.id, &piece, ctx.now.max(s.scheduled_at))
        .await?
        .filter(|c| c.hard.is_empty())
        .ok_or_else(|| refuse("hard_findings_not_releasable"))?;
    if check.findings.is_empty() {
        return Err(refuse("no_caption_findings"));
    }
    if check.digest != i.digest {
        return Err(refuse("findings_changed"));
    }
    if !check.released {
        r.studio_materials()
            .save_release(MaterialRelease {
                slot_id: s.id,
                revision: s.revision,
                digest: check.digest.clone(),
                by,
                at: ctx.now,
            })
            .await?;
        let codes: BTreeSet<&str> = check.findings.iter().map(|f| f.code.code()).collect();
        let mut e = ledger_entry(
            ctx,
            "studio.material.check_released",
            "studio_slot",
            s.id,
            json!({"slot_id": s.id, "revision": s.revision, "digest": check.digest,
                "codes": codes}),
        )?;
        e.strategy_version_id = Some(frame.id.0);
        r.ledger().append(e).await?;
    }
    let out = slot_in(r.as_mut(), s.id, &frame, ctx.now).await?;
    r.commit().await?;
    Ok(out)
}

/// The common eligibility and truth checks, independent of whether content has a slot yet.
pub(crate) async fn check_content(
    r: &mut dyn TenantRepos,
    materials: &[Material],
    subject: &Subject,
    texts: &[&str],
    at: OffsetDateTime,
) -> Result<(Vec<HardFinding>, Vec<CaptionFinding>), AppError> {
    let lib = library(r, at).await?;
    let refs: Vec<&Material> = materials.iter().collect();
    let mut hard = match piece_roles(&refs, subject, &lib.context(at)) {
        Ok(_) => Vec::new(),
        Err(PieceRefusal::NoAnchor) => vec![HardFinding {
            code: "no_eligible_material".into(),
            material_id: None,
        }],
        Err(PieceRefusal::Refused(list)) => list
            .iter()
            .map(|(id, refusal)| HardFinding {
                code: refusal.code().into(),
                material_id: Some(*id),
            })
            .collect(),
    };
    let blocked = super::library::blocked_derivatives(r).await?;
    hard.extend(
        materials
            .iter()
            .filter(|m| blocked.contains(&m.id))
            .map(|m| HardFinding {
                code: "source_permission_restricted".into(),
                material_id: Some(m.id),
            }),
    );
    let names = client_names(r, &lib.olays).await?;
    let findings = check_caption(texts, subject, &refs, &lib.olays, &names, &lib.calendar);
    Ok((hard, findings))
}
