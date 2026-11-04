//! The in-memory materials library, with the constraints migration `0021_studio_materials`
//! enforces: one olay or material per id and one material per file across workspaces, a
//! material's file a Studio file and its olay an olay of the same workspace, a material's file,
//! origin and generator never changing, revision-checked replacements, piece uses recorded once
//! and never changed, one shoot request per key, and one calendar row per key and year.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::materials::*;
use jt_studio::{FileId, SlotId};
use jt_tenancy::WorkspaceId;

use super::state::{MemBundle, exists, unique};
use super::tenant::MemTenant;

/// The workspaces' materials library, as the fake stores it.
#[derive(Clone, Debug, Default)]
pub struct MemMaterials {
    pub olays: Vec<Olay>,
    pub materials: Vec<Material>,
    /// Each piece revision's subject with one of its uses.
    pub piece_uses: Vec<(WorkspaceId, Subject, PieceMaterial)>,
    pub calendar: Vec<(WorkspaceId, CalendarEntry)>,
    pub shoot_requests: Vec<ShootRequest>,
    pub policies: Vec<(WorkspaceId, MaterialPolicy)>,
    pub releases: Vec<(WorkspaceId, MaterialRelease)>,
}

fn conflict(message: &str) -> AppError {
    AppError::conflict(message.to_owned())
}

impl MemTenant {
    fn lib(&self) -> &MemMaterials {
        &self.state().materials
    }
}

#[async_trait]
impl MaterialRepo for MemTenant {
    async fn insert_olay(&mut self, olay: Olay) -> Result<(), AppError> {
        self.call(|this| {
            if olay.workspace_id != this.ws {
                return Err(AppError::internal("olay of another workspace"));
            }
            olay.validate()
                .map_err(|e| AppError::internal(format!("studio_olays check: {e}")))?;
            unique(
                !this.lib().olays.iter().any(|o| o.id == olay.id),
                "insert olay: the value is already taken",
            )?;
            this.tx.write(move |s| s.materials.olays.push(olay.clone()));
            Ok(())
        })
    }

    async fn update_olay(&mut self, olay: Olay, expected_revision: u64) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            olay.validate()
                .map_err(|e| AppError::internal(format!("studio_olays check: {e}")))?;
            let current = this
                .lib()
                .olays
                .iter()
                .find(|o| o.workspace_id == ws && o.id == olay.id)
                .ok_or_else(|| AppError::not_found("olay"))?;
            if current.revision != expected_revision
                || olay.revision != expected_revision.saturating_add(1)
                || olay.workspace_id != ws
            {
                return Err(conflict("olay revision changed"));
            }
            this.tx.write(move |s| {
                if let Some(o) = s
                    .materials
                    .olays
                    .iter_mut()
                    .find(|o| o.workspace_id == ws && o.id == olay.id)
                {
                    *o = olay.clone();
                }
            });
            Ok(())
        })
    }

    async fn get_olay(&mut self, id: OlayId) -> Result<Option<Olay>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .olays
            .iter()
            .find(|o| o.workspace_id == ws && o.id == id)
            .cloned())
    }

    async fn list_olays(&mut self) -> Result<Vec<Olay>, AppError> {
        let ws = self.ws;
        let mut out: Vec<Olay> = self
            .lib()
            .olays
            .iter()
            .filter(|o| o.workspace_id == ws)
            .cloned()
            .collect();
        out.sort_by_key(|o| std::cmp::Reverse((o.starts_on, o.id)));
        Ok(out)
    }

    async fn insert_material(&mut self, material: Material) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if material.workspace_id != ws {
                return Err(AppError::internal("material of another workspace"));
            }
            material
                .validate()
                .map_err(|e| AppError::internal(format!("studio_materials check: {e}")))?;
            exists(
                this.state()
                    .studio
                    .files
                    .iter()
                    .any(|f| f.workspace_id == ws && f.id == material.file_id),
                "studio_materials.file_id",
            )
            .map_err(|_| AppError::not_found("file"))?;
            if let Some(olay) = material.olay_id()
                && !this
                    .lib()
                    .olays
                    .iter()
                    .any(|o| o.workspace_id == ws && o.id == olay)
            {
                return Err(AppError::not_found("olay"));
            }
            unique(
                !this
                    .lib()
                    .materials
                    .iter()
                    .any(|m| m.id == material.id || m.file_id == material.file_id),
                "insert material: the value is already taken",
            )?;
            this.tx
                .write(move |s| s.materials.materials.push(material.clone()));
            Ok(())
        })
    }

    async fn update_material(
        &mut self,
        material: Material,
        expected_revision: u64,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            material
                .validate()
                .map_err(|e| AppError::internal(format!("studio_materials check: {e}")))?;
            let current = this
                .lib()
                .materials
                .iter()
                .find(|m| m.workspace_id == ws && m.id == material.id)
                .ok_or_else(|| AppError::not_found("material"))?;
            if current.file_id != material.file_id || current.origin != material.origin {
                return Err(AppError::internal(
                    "studio_materials: file, origin and generator never change",
                ));
            }
            if current.revision != expected_revision
                || material.revision != expected_revision.saturating_add(1)
            {
                return Err(conflict("material revision changed"));
            }
            if let Some(olay) = material.olay_id()
                && !this
                    .lib()
                    .olays
                    .iter()
                    .any(|o| o.workspace_id == ws && o.id == olay)
            {
                return Err(AppError::not_found("olay"));
            }
            this.tx.write(move |s| {
                if let Some(m) = s
                    .materials
                    .materials
                    .iter_mut()
                    .find(|m| m.workspace_id == ws && m.id == material.id)
                {
                    *m = material.clone();
                }
            });
            Ok(())
        })
    }

    async fn get_material(&mut self, id: MaterialId) -> Result<Option<Material>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .materials
            .iter()
            .find(|m| m.workspace_id == ws && m.id == id)
            .cloned())
    }

    async fn material_by_file(&mut self, file: FileId) -> Result<Option<Material>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .materials
            .iter()
            .find(|m| m.workspace_id == ws && m.file_id == file)
            .cloned())
    }

    async fn material_by_sha256(&mut self, sha256: &str) -> Result<Option<Material>, AppError> {
        let ws = self.ws;
        let files: Vec<FileId> = self
            .state()
            .studio
            .files
            .iter()
            .filter(|f| f.workspace_id == ws && f.sha256 == sha256)
            .map(|f| f.id)
            .collect();
        Ok(self
            .lib()
            .materials
            .iter()
            .filter(|m| m.workspace_id == ws && files.contains(&m.file_id))
            .min_by_key(|m| (m.created_at, m.id))
            .cloned())
    }

    async fn list_materials(&mut self) -> Result<Vec<Material>, AppError> {
        let ws = self.ws;
        let mut out: Vec<Material> = self
            .lib()
            .materials
            .iter()
            .filter(|m| m.workspace_id == ws)
            .cloned()
            .collect();
        out.sort_by_key(|m| std::cmp::Reverse((m.created_at, m.id)));
        Ok(out)
    }

    async fn record_piece_materials(
        &mut self,
        subject: Subject,
        uses: Vec<PieceMaterial>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let Some(first) = uses.first() else {
                return Ok(());
            };
            if uses.iter().any(|u| {
                (u.piece_id, u.slot_id, u.revision)
                    != (first.piece_id, first.slot_id, first.revision)
            }) {
                return Err(AppError::internal("piece uses of more than one piece"));
            }
            exists(
                this.state().studio.pieces.iter().any(|(slot, p)| {
                    p.chain.workspace_id == ws && p.id == first.piece_id && *slot == first.slot_id
                }),
                "studio_piece_materials.piece_id",
            )
            .map_err(|_| AppError::not_found("piece"))?;
            for u in &uses {
                exists(
                    this.lib()
                        .materials
                        .iter()
                        .any(|m| m.workspace_id == ws && m.id == u.material_id),
                    "studio_piece_materials.material_id",
                )
                .map_err(|_| AppError::not_found("material"))?;
                unique(
                    !this.lib().piece_uses.iter().any(|(w, _, p)| {
                        *w == ws && p.piece_id == u.piece_id && p.material_id == u.material_id
                    }),
                    "record piece materials: the value is already taken",
                )?;
            }
            this.tx.write(move |s| {
                for u in &uses {
                    s.materials.piece_uses.push((ws, subject, u.clone()));
                }
            });
            Ok(())
        })
    }

    async fn piece_materials(
        &mut self,
        slot: SlotId,
        revision: u64,
    ) -> Result<Option<PieceMaterials>, AppError> {
        let ws = self.ws;
        let rows: Vec<_> = self
            .lib()
            .piece_uses
            .iter()
            .filter(|(w, _, u)| *w == ws && u.slot_id == slot && u.revision == revision)
            .collect();
        Ok(rows.first().map(|(_, subject, _)| PieceMaterials {
            subject: *subject,
            uses: rows.iter().map(|(_, _, u)| u.clone()).collect(),
        }))
    }

    async fn uses_of(&mut self, material: MaterialId) -> Result<Vec<PieceMaterial>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .piece_uses
            .iter()
            .filter(|(w, _, u)| *w == ws && u.material_id == material)
            .map(|(_, _, u)| u.clone())
            .collect())
    }

    async fn calendar_rows(&mut self) -> Result<Vec<CalendarEntry>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<CalendarEntry> = self
            .lib()
            .calendar
            .iter()
            .filter(|(w, _)| *w == ws)
            .map(|(_, e)| e.clone())
            .collect();
        rows.sort_by(|a, b| (a.year, &a.key).cmp(&(b.year, &b.key)));
        Ok(rows)
    }

    async fn save_calendar_row(&mut self, row: CalendarEntry) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            row.validate()
                .map_err(|e| AppError::internal(format!("studio_calendar_entries check: {e}")))?;
            this.tx.write(move |s| {
                s.materials
                    .calendar
                    .retain(|(w, e)| !(*w == ws && e.key == row.key && e.year == row.year));
                s.materials.calendar.push((ws, row.clone()));
            });
            Ok(())
        })
    }

    async fn insert_shoot_request(&mut self, request: ShootRequest) -> Result<bool, AppError> {
        self.call(|this| {
            let ws = this.ws;
            if request.workspace_id != ws {
                return Err(AppError::internal("request of another workspace"));
            }
            request
                .validate()
                .map_err(|e| AppError::internal(format!("studio_shoot_requests check: {e}")))?;
            if this
                .lib()
                .shoot_requests
                .iter()
                .any(|r| r.workspace_id == ws && r.key == request.key)
            {
                return Ok(false);
            }
            unique(
                !this.lib().shoot_requests.iter().any(|r| r.id == request.id),
                "insert shoot request: the value is already taken",
            )?;
            this.tx
                .write(move |s| s.materials.shoot_requests.push(request.clone()));
            Ok(true)
        })
    }

    async fn update_shoot_request(&mut self, request: ShootRequest) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            request
                .validate()
                .map_err(|e| AppError::internal(format!("studio_shoot_requests check: {e}")))?;
            let current = this
                .lib()
                .shoot_requests
                .iter()
                .find(|r| r.workspace_id == ws && r.id == request.id)
                .ok_or_else(|| AppError::not_found("shoot request"))?;
            if current.key != request.key {
                return Err(AppError::internal(
                    "studio_shoot_requests: the key never changes",
                ));
            }
            this.tx.write(move |s| {
                if let Some(r) = s
                    .materials
                    .shoot_requests
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == request.id)
                {
                    *r = request.clone();
                }
            });
            Ok(())
        })
    }

    async fn get_shoot_request(
        &mut self,
        id: ShootRequestId,
    ) -> Result<Option<ShootRequest>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .shoot_requests
            .iter()
            .find(|r| r.workspace_id == ws && r.id == id)
            .cloned())
    }

    async fn list_shoot_requests(&mut self) -> Result<Vec<ShootRequest>, AppError> {
        let ws = self.ws;
        let mut out: Vec<ShootRequest> = self
            .lib()
            .shoot_requests
            .iter()
            .filter(|r| r.workspace_id == ws)
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            (b.week_start, b.created_at, b.id).cmp(&(a.week_start, a.created_at, a.id))
        });
        Ok(out)
    }

    async fn material_policy(&mut self) -> Result<MaterialPolicy, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .policies
            .iter()
            .find(|(w, _)| *w == ws)
            .map(|(_, p)| *p)
            .unwrap_or_default())
    }

    async fn save_material_policy(&mut self, policy: MaterialPolicy) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            policy
                .validate()
                .map_err(|e| AppError::internal(format!("studio_material_policy check: {e}")))?;
            this.tx.write(move |s| {
                s.materials.policies.retain(|(w, _)| *w != ws);
                s.materials.policies.push((ws, policy));
            });
            Ok(())
        })
    }

    async fn save_release(&mut self, release: MaterialRelease) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            exists(
                this.state()
                    .studio
                    .slots
                    .iter()
                    .any(|s| s.chain.workspace_id == ws && s.id == release.slot_id),
                "studio_material_releases.slot_id",
            )
            .map_err(|_| AppError::not_found("slot"))?;
            this.tx.write(move |s| {
                s.materials.releases.retain(|(w, r)| {
                    !(*w == ws && r.slot_id == release.slot_id && r.revision == release.revision)
                });
                s.materials.releases.push((ws, release.clone()));
            });
            Ok(())
        })
    }

    async fn get_release(
        &mut self,
        slot: SlotId,
        revision: u64,
    ) -> Result<Option<MaterialRelease>, AppError> {
        let ws = self.ws;
        Ok(self
            .lib()
            .releases
            .iter()
            .find(|(w, r)| *w == ws && r.slot_id == slot && r.revision == revision)
            .map(|(_, r)| r.clone()))
    }
}
