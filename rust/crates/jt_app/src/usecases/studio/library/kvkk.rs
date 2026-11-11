//! A person's erasure in the materials library (spec §9.2): in the erasure's transaction, every
//! material that shows the person is redacted, and every olay naming the person as its client
//! keeps only the organization. The caller deletes the redacted materials' bytes after commit.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        materials::{Olay, OlayClient},
    },
    usecases::ledger_entry,
};
use jt_inbox::PersonId;
use jt_studio::FileId;
use serde_json::json;
use uuid::Uuid;

/// The most merges followed from a linked person to the one erased.
const MAX_MERGE_HOPS: usize = 32;

/// Whether `linked` is `person` or was merged into it (directly or through others): erasing a
/// person erases what was merged into them.
async fn erased_with(
    r: &mut dyn TenantRepos,
    linked: Uuid,
    person: PersonId,
) -> Result<bool, AppError> {
    let mut id = PersonId(linked);
    for _ in 0..MAX_MERGE_HOPS {
        if id == person {
            return Ok(true);
        }
        match r.people().get(id).await?.and_then(|p| p.merged_into) {
            Some(next) => id = next,
            None => return Ok(false),
        }
    }
    Ok(false)
}

/// Redacts the materials that show `person` and unlinks the olays naming them, under the Studio
/// control lock, in the caller's transaction; the files of the materials redacted now, whose bytes
/// the caller deletes once it has committed. Idempotent: an erased material or an unlinked olay is
/// left as it is.
pub(crate) async fn erase_person(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
) -> Result<Vec<FileId>, AppError> {
    r.studio_control().lock_control().await?;
    let mut files = Vec::new();
    for m in r.studio_materials().list_materials().await? {
        if m.erased_at.is_some() {
            continue;
        }
        let mut shows = false;
        for p in &m.people {
            if erased_with(r, *p, person).await? {
                shows = true;
                break;
            }
        }
        if !shows {
            continue;
        }
        let erased = m.redacted(ctx.now);
        r.studio_materials()
            .update_material(erased.clone(), m.revision)
            .await?;
        r.ledger()
            .append(ledger_entry(
                ctx,
                "studio.material.erased",
                "studio_material",
                erased.id,
                json!({"file_id":erased.file_id,"reason":"person_erased"}),
            )?)
            .await?;
        files.push(erased.file_id);
    }
    for o in r.studio_materials().list_olays().await? {
        let Some(linked) = o.client.as_ref().and_then(|c| c.person_id) else {
            continue;
        };
        if !erased_with(r, linked, person).await? {
            continue;
        }
        let organization = o.client.as_ref().and_then(|c| c.organization.clone());
        let revision = o
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?;
        let unlinked = Olay {
            client: organization.map(|organization| OlayClient {
                person_id: None,
                organization: Some(organization),
            }),
            revision,
            ..o.clone()
        };
        r.studio_materials()
            .update_olay(unlinked.clone(), o.revision)
            .await?;
        r.ledger()
            .append(ledger_entry(
                ctx,
                "studio.olay.updated",
                "studio_olay",
                unlinked.id,
                json!({"olay_id":unlinked.id,"fields":["client"],"reason":"person_erased",
                    "revision":unlinked.revision}),
            )?)
            .await?;
    }
    Ok(files)
}
