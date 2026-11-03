//! The material gate (spec `2026-11-03-studio-materials-design.md` D1, D2, §5.5, §5.6): every medium
//! of a piece is a material, at least one an eligible anchor, checked at submission at the slot's
//! time and again at publish time. Studio cannot publish what no real material backs, whatever the
//! approval policy and whoever submits.
use crate::{
    error::{AppError, ErrorCode},
    ports::{
        TenantRepos,
        materials::{Calendar, Material, MaterialId, Olay, Subject, UseRole},
    },
};
use jt_studio::{FileId, MediaAsset, PieceRefusal, Slot, UseContext, istanbul_day, piece_roles};
use serde_json::{Value, json};
use time::OffsetDateTime;

/// The reason a publish is held for its materials ([`publish_check`]).
pub(crate) const MATERIAL_HOLD: &str = "material_check_hold";

/// What the rules read: the workspace's olays and its effective calendar around `at`.
pub(crate) struct Library {
    pub olays: Vec<Olay>,
    pub calendar: Calendar,
}

impl Library {
    pub fn context(&self, at: OffsetDateTime) -> UseContext<'_> {
        UseContext {
            at,
            olays: &self.olays,
            calendar: &self.calendar,
        }
    }
}

/// The workspace's olays and its calendar over every year from its earliest olay to the year after
/// `at`.
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
    Ok(Library {
        olays,
        calendar: Calendar::effective(first.max(2000)..=(year + 1).min(2100), &rows),
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
    let lib = library(r, at).await?;
    let refs: Vec<&Material> = materials.iter().collect();
    piece_roles(&refs, subject, &lib.context(at)).map_err(piece_refusal)
}

/// `CONFLICT` [`MATERIAL_HOLD`] unless the piece of slot `slot` at its revision still passes the
/// material gate at `now` (spec §5.6): its recorded materials (`no_material` when none were
/// recorded), each still eligible for its subject.
pub(crate) async fn publish_check(
    r: &mut dyn TenantRepos,
    slot: &Slot,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let hold = |findings: Value| AppError {
        code: ErrorCode::Conflict,
        message: MATERIAL_HOLD.into(),
        details: json!({"reason": MATERIAL_HOLD, "findings": findings}),
    };
    let Some(recorded) = r
        .studio_materials()
        .piece_materials(slot.id, slot.revision)
        .await?
    else {
        return Err(hold(json!([{"code": "no_material"}])));
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
    let lib = library(r, now).await?;
    let refs: Vec<&Material> = materials.iter().collect();
    match piece_roles(&refs, &recorded.subject, &lib.context(now)) {
        Ok(_) => Ok(()),
        Err(PieceRefusal::NoAnchor) => Err(hold(json!([{"code": "no_eligible_material"}]))),
        Err(PieceRefusal::Refused(list)) => Err(hold(Value::Array(
            list.iter()
                .map(|(id, r)| json!({"material_id": id, "code": r.code()}))
                .collect(),
        ))),
    }
}
