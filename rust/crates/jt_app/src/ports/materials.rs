//! The materials library's storage (spec `2026-11-03-studio-materials-design.md` §5.1, §6): olays,
//! materials, the materials each piece revision shows, the workspace's calendar rows, the çekim
//! listesi, the materials policy and the caption-check releases. The rules live in `jt_studio` and
//! are re-exported here.
//!
//! Calls run in the caller's tenant transaction; file bytes are never read or written under it
//! (they are stored before and deleted after, as `studio.file_upload` does). Use cases that change a
//! material or an olay take the Studio control lock first, as the publisher's fence does, so a
//! change and a publish never interleave.
//!
//! A material's title, an olay's title, place, notes and client, and a request's text are the
//! owner's words: log ids and codes, never them.
pub use jt_studio::{
    Binding, Calendar, CalendarEntry, ContentType, Depicts, Door, HumanMark, Material, MaterialId,
    MaterialPolicy, MaterialUsage, OccasionKind, Olay, OlayClient, OlayId, OlayKind, OlayStatus,
    Origin, PieceMaterial, ProductGroup, Quality, Refusal, ShareDecision, SharePermission,
    ShootReason, ShootRequest, ShootRequestId, ShootStatus, Subject, Tags, UseRole,
};

use async_trait::async_trait;
use jt_studio::{FileId, SlotId};
use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::AppError;

/// A human's release of one slot revision's caption findings (spec §7, D19): it holds while the
/// findings' digest is the same.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaterialRelease {
    pub slot_id: SlotId,
    pub revision: u64,
    pub digest: String,
    pub by: UserId,
    #[serde(with = "jt_studio::time_compat")]
    pub at: OffsetDateTime,
}

/// What one piece revision shows: its subject and its materials, each with its role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PieceMaterials {
    pub subject: Subject,
    pub uses: Vec<PieceMaterial>,
}

#[async_trait]
pub trait MaterialRepo: Send + Sync {
    /// `CONFLICT` when the id is taken.
    async fn insert_olay(&mut self, olay: Olay) -> Result<(), AppError>;
    /// Replaces the olay stored at `expected_revision` (`CONFLICT` otherwise) by `olay`, whose
    /// revision is one more.
    async fn update_olay(&mut self, olay: Olay, expected_revision: u64) -> Result<(), AppError>;
    async fn get_olay(&mut self, id: OlayId) -> Result<Option<Olay>, AppError>;
    /// Every olay of the workspace, newest start first.
    async fn list_olays(&mut self) -> Result<Vec<Olay>, AppError>;

    /// `CONFLICT` when the id is taken or the file is another material's already. The file must
    /// be a Studio file of the workspace (`NOT_FOUND`), and a bound material's olay one of its
    /// olays (`NOT_FOUND`).
    async fn insert_material(&mut self, material: Material) -> Result<(), AppError>;
    /// Replaces the material stored at `expected_revision` (`CONFLICT` otherwise) by `material`,
    /// whose revision is one more. Its file, origin and generator never change (`INTERNAL`, as
    /// the table's trigger answers).
    async fn update_material(
        &mut self,
        material: Material,
        expected_revision: u64,
    ) -> Result<(), AppError>;
    async fn get_material(&mut self, id: MaterialId) -> Result<Option<Material>, AppError>;
    async fn material_by_file(&mut self, file: FileId) -> Result<Option<Material>, AppError>;
    /// Every material of the workspace, erased ones included, newest first.
    async fn list_materials(&mut self) -> Result<Vec<Material>, AppError>;

    /// Records what one piece revision shows, once: the rows are never changed or removed. Every
    /// use names the same piece, slot and revision; the piece must be stored (`NOT_FOUND`).
    async fn record_piece_materials(
        &mut self,
        subject: Subject,
        uses: Vec<PieceMaterial>,
    ) -> Result<(), AppError>;
    /// What the piece of slot `slot` at `revision` shows; `None` when nothing was recorded (a
    /// piece submitted before the materials library).
    async fn piece_materials(
        &mut self,
        slot: SlotId,
        revision: u64,
    ) -> Result<Option<PieceMaterials>, AppError>;
    /// Every piece revision that showed `material`, oldest first.
    async fn uses_of(&mut self, material: MaterialId) -> Result<Vec<PieceMaterial>, AppError>;

    /// The workspace's calendar rows (its edits and the dates it entered), by year and key.
    async fn calendar_rows(&mut self) -> Result<Vec<CalendarEntry>, AppError>;
    /// Stores the row of its key and year, replacing the one there.
    async fn save_calendar_row(&mut self, row: CalendarEntry) -> Result<(), AppError>;

    /// Adds the request unless one with its key exists: `false` then, and nothing is written.
    async fn insert_shoot_request(&mut self, request: ShootRequest) -> Result<bool, AppError>;
    /// Replaces the stored request of the same id (`NOT_FOUND` when there is none); its key never
    /// changes.
    async fn update_shoot_request(&mut self, request: ShootRequest) -> Result<(), AppError>;
    async fn get_shoot_request(
        &mut self,
        id: ShootRequestId,
    ) -> Result<Option<ShootRequest>, AppError>;
    /// Every request, newest week first, then newest first.
    async fn list_shoot_requests(&mut self) -> Result<Vec<ShootRequest>, AppError>;

    /// The workspace's materials policy; the defaults when it never set one.
    async fn material_policy(&mut self) -> Result<MaterialPolicy, AppError>;
    async fn save_material_policy(&mut self, policy: MaterialPolicy) -> Result<(), AppError>;

    /// Stores the release of its slot and revision, replacing the one there.
    async fn save_release(&mut self, release: MaterialRelease) -> Result<(), AppError>;
    async fn get_release(
        &mut self,
        slot: SlotId,
        revision: u64,
    ) -> Result<Option<MaterialRelease>, AppError>;
}
