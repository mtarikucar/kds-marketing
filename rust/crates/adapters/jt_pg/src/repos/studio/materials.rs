//! The materials library's storage (migration `0021_studio_materials`). Records are kept whole in
//! `data`; the columns are what the checks, keys and indexes need, written from the same record.
use super::{decode, encode, revision};
use crate::{
    repos::{map_sqlx, same_workspace},
    uow::PgTenantRepos,
};
use async_trait::async_trait;
use jt_app::{error::AppError, ports::materials::*};
use jt_studio::{FileId, SlotId};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

/// The serde name of a unit enum value (`kind`, `status`, `role`…).
fn name<T: Serialize>(value: &T) -> Result<String, AppError> {
    match encode(value)? {
        Value::String(s) => Ok(s),
        _ => Err(AppError::internal("invalid Studio record")),
    }
}

fn checked<E: std::fmt::Display>(table: &str, result: Result<(), E>) -> Result<(), AppError> {
    result.map_err(|e| AppError::internal(format!("{table} check: {e}")))
}

/// The columns of a material, from its record.
struct MaterialColumns {
    binding: &'static str,
    olay_id: Option<Uuid>,
    origin: &'static str,
    generator: Option<String>,
    share: Option<String>,
    freed_at: Option<OffsetDateTime>,
}

fn material_columns(m: &Material) -> Result<MaterialColumns, AppError> {
    let (origin, generator) = match &m.origin {
        Origin::Real => ("real", None),
        Origin::AiGenerated { generator } => ("ai_generated", Some(generator.clone())),
    };
    Ok(MaterialColumns {
        binding: match m.binding {
            Binding::Olay { .. } => "olay",
            Binding::Genel => "genel",
        },
        olay_id: m.olay_id().map(|o| o.0),
        origin,
        generator,
        share: m.share.as_ref().map(|s| name(&s.permission)).transpose()?,
        freed_at: m.freed.as_ref().map(|f| f.at),
    })
}

impl PgTenantRepos {
    async fn olay_exists(&mut self, id: OlayId) -> Result<bool, AppError> {
        sqlx::query_scalar::<_, bool>(
            "select exists(select 1 from studio_olays where workspace_id=$1 and id=$2)",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read olay"))
    }

    async fn material_rows(
        &mut self,
        filter: &str,
        id: Option<Uuid>,
    ) -> Result<Vec<Material>, AppError> {
        // `filter` is a private constant, never user input.
        let rows: Vec<Value> = sqlx::query_scalar(&format!(
            "select data from studio_materials where workspace_id=$1 {filter} \
             order by created_at desc, id desc"
        ))
        .bind(self.workspace_id().0)
        .bind(id)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read materials"))?;
        rows.into_iter().map(decode).collect()
    }
}

#[async_trait]
impl MaterialRepo for PgTenantRepos {
    async fn get_intelligence(
        &mut self,
        id: MaterialId,
    ) -> Result<Option<MaterialAnalysisRecord>, AppError> {
        let row: Option<Value> = sqlx::query_scalar("select data from studio_material_intelligence where workspace_id=$1 and material_id=$2")
            .bind(self.workspace_id().0).bind(id.0).fetch_optional(self.tx.conn()).await
            .map_err(|e| map_sqlx(e, "read material intelligence"))?;
        row.map(decode).transpose()
    }
    async fn list_intelligence(&mut self) -> Result<Vec<MaterialAnalysisRecord>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar("select i.data from studio_material_intelligence i join studio_materials m on m.workspace_id=i.workspace_id and m.id=i.material_id where i.workspace_id=$1 and m.erased_at is null order by i.material_id")
            .bind(self.workspace_id().0).fetch_all(self.tx.conn()).await
            .map_err(|e| map_sqlx(e, "list material intelligence"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn save_intelligence(&mut self, row: MaterialAnalysisRecord) -> Result<(), AppError> {
        let done = sqlx::query("insert into studio_material_intelligence(workspace_id,material_id,data) select $1,$2,$3 where exists(select 1 from studio_materials where workspace_id=$1 and id=$2 and erased_at is null) on conflict(workspace_id,material_id) do update set data=excluded.data")
            .bind(self.workspace_id().0).bind(row.material_id.0).bind(encode(&row)?)
            .execute(self.tx.conn()).await.map_err(|e| map_sqlx(e, "save material intelligence"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("material"));
        }
        Ok(())
    }
    async fn delete_intelligence(&mut self, id: MaterialId) -> Result<(), AppError> {
        sqlx::query(
            "delete from studio_material_intelligence where workspace_id=$1 and material_id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "delete material intelligence"))?;
        Ok(())
    }

    async fn insert_olay(&mut self, olay: Olay) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), olay.workspace_id)?;
        checked("studio_olays", olay.validate())?;
        let done = sqlx::query(
            "insert into studio_olays(workspace_id,id,data,kind,status,starts_on,ends_on,occasion,revision) \
             values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing",
        )
        .bind(self.workspace_id().0)
        .bind(olay.id.0)
        .bind(encode(&olay)?)
        .bind(name(&olay.kind)?)
        .bind(name(&olay.status)?)
        .bind(olay.starts_on)
        .bind(olay.ends_on)
        .bind(olay.occasion.as_deref())
        .bind(revision(olay.revision)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert olay"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "insert olay: the value is already taken",
            ));
        }
        Ok(())
    }

    async fn update_olay(&mut self, olay: Olay, expected_revision: u64) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), olay.workspace_id)?;
        checked("studio_olays", olay.validate())?;
        if olay.revision != expected_revision.saturating_add(1) {
            return Err(AppError::conflict("olay revision changed"));
        }
        let done = sqlx::query(
            "update studio_olays set data=$3,kind=$4,status=$5,starts_on=$6,ends_on=$7,occasion=$8,revision=$9 \
             where workspace_id=$1 and id=$2 and revision=$10",
        )
        .bind(self.workspace_id().0)
        .bind(olay.id.0)
        .bind(encode(&olay)?)
        .bind(name(&olay.kind)?)
        .bind(name(&olay.status)?)
        .bind(olay.starts_on)
        .bind(olay.ends_on)
        .bind(olay.occasion.as_deref())
        .bind(revision(olay.revision)?)
        .bind(revision(expected_revision)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update olay"))?;
        if done.rows_affected() == 0 {
            return Err(if self.olay_exists(olay.id).await? {
                AppError::conflict("olay revision changed")
            } else {
                AppError::not_found("olay")
            });
        }
        Ok(())
    }

    async fn get_olay(&mut self, id: OlayId) -> Result<Option<Olay>, AppError> {
        let row: Option<Value> =
            sqlx::query_scalar("select data from studio_olays where workspace_id=$1 and id=$2")
                .bind(self.workspace_id().0)
                .bind(id.0)
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read olay"))?;
        row.map(decode).transpose()
    }

    async fn list_olays(&mut self) -> Result<Vec<Olay>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_olays where workspace_id=$1 order by starts_on desc, id desc",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read olays"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn insert_material(&mut self, m: Material) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), m.workspace_id)?;
        checked("studio_materials", m.validate())?;
        let file: bool = sqlx::query_scalar(
            "select exists(select 1 from studio_files where workspace_id=$1 and id=$2)",
        )
        .bind(self.workspace_id().0)
        .bind(m.file_id.0)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read file"))?;
        if !file {
            return Err(AppError::not_found("file"));
        }
        if let Some(olay) = m.olay_id()
            && !self.olay_exists(olay).await?
        {
            return Err(AppError::not_found("olay"));
        }
        let c = material_columns(&m)?;
        let done = sqlx::query(
            "insert into studio_materials(workspace_id,id,data,file_id,binding,olay_id,origin,generator,share,freed_at,erased_at,revision,created_at) \
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict do nothing",
        )
        .bind(self.workspace_id().0)
        .bind(m.id.0)
        .bind(encode(&m)?)
        .bind(m.file_id.0)
        .bind(c.binding)
        .bind(c.olay_id)
        .bind(c.origin)
        .bind(c.generator)
        .bind(c.share)
        .bind(c.freed_at)
        .bind(m.erased_at)
        .bind(revision(m.revision)?)
        .bind(m.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert material"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "insert material: the value is already taken",
            ));
        }
        Ok(())
    }

    async fn update_material(
        &mut self,
        m: Material,
        expected_revision: u64,
    ) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), m.workspace_id)?;
        checked("studio_materials", m.validate())?;
        let current = self
            .get_material(m.id)
            .await?
            .ok_or_else(|| AppError::not_found("material"))?;
        if current.file_id != m.file_id || current.origin != m.origin {
            return Err(AppError::internal(
                "studio_materials: file, origin and generator never change",
            ));
        }
        if current.erased_at.is_some() {
            return Err(AppError::internal(
                "studio_materials: an erased material never changes",
            ));
        }
        if current.revision != expected_revision
            || m.revision != expected_revision.saturating_add(1)
        {
            return Err(AppError::conflict("material revision changed"));
        }
        if let Some(olay) = m.olay_id()
            && !self.olay_exists(olay).await?
        {
            return Err(AppError::not_found("olay"));
        }
        let c = material_columns(&m)?;
        let done = sqlx::query(
            "update studio_materials set data=$3,binding=$4,olay_id=$5,share=$6,freed_at=$7,erased_at=$8,revision=$9 \
             where workspace_id=$1 and id=$2 and revision=$10",
        )
        .bind(self.workspace_id().0)
        .bind(m.id.0)
        .bind(encode(&m)?)
        .bind(c.binding)
        .bind(c.olay_id)
        .bind(c.share)
        .bind(c.freed_at)
        .bind(m.erased_at)
        .bind(revision(m.revision)?)
        .bind(revision(expected_revision)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update material"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("material revision changed"));
        }
        Ok(())
    }

    async fn get_material(&mut self, id: MaterialId) -> Result<Option<Material>, AppError> {
        Ok(self
            .material_rows("and id=$2", Some(id.0))
            .await?
            .into_iter()
            .next())
    }

    async fn material_by_file(&mut self, file: FileId) -> Result<Option<Material>, AppError> {
        Ok(self
            .material_rows("and file_id=$2", Some(file.0))
            .await?
            .into_iter()
            .next())
    }

    async fn material_by_sha256(&mut self, sha256: &str) -> Result<Option<Material>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select m.data from studio_materials m join studio_files f \
             on f.workspace_id=m.workspace_id and f.id=m.file_id \
             where m.workspace_id=$1 and f.data->>'sha256'=$2 \
             order by m.created_at, m.id limit 1",
        )
        .bind(self.workspace_id().0)
        .bind(sha256)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read materials"))?;
        row.map(decode).transpose()
    }

    async fn list_materials(&mut self) -> Result<Vec<Material>, AppError> {
        self.material_rows("and ($2::uuid is null or id=$2)", None)
            .await
    }

    async fn record_piece_materials(
        &mut self,
        subject: Subject,
        uses: Vec<PieceMaterial>,
    ) -> Result<(), AppError> {
        let Some(first) = uses.first().cloned() else {
            return Ok(());
        };
        if uses.iter().any(|u| {
            (u.piece_id, u.slot_id, u.revision) != (first.piece_id, first.slot_id, first.revision)
        }) {
            return Err(AppError::internal("piece uses of more than one piece"));
        }
        let piece: bool = sqlx::query_scalar(
            "select exists(select 1 from studio_pieces where workspace_id=$1 and id=$2 and slot_id=$3)",
        )
        .bind(self.workspace_id().0)
        .bind(first.piece_id.0)
        .bind(first.slot_id.0)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read piece"))?;
        if !piece {
            return Err(AppError::not_found("piece"));
        }
        let subject = encode(&subject)?;
        for u in uses {
            if self.get_material(u.material_id).await?.is_none() {
                return Err(AppError::not_found("material"));
            }
            let done = sqlx::query(
                "insert into studio_piece_materials(workspace_id,piece_id,material_id,slot_id,revision,role,subject) \
                 values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing",
            )
            .bind(self.workspace_id().0)
            .bind(u.piece_id.0)
            .bind(u.material_id.0)
            .bind(u.slot_id.0)
            .bind(revision(u.revision)?)
            .bind(name(&u.role)?)
            .bind(&subject)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "record piece materials"))?;
            if done.rows_affected() == 0 {
                return Err(AppError::conflict(
                    "record piece materials: the value is already taken",
                ));
            }
        }
        Ok(())
    }

    async fn piece_materials(
        &mut self,
        slot: SlotId,
        rev: u64,
    ) -> Result<Option<PieceMaterials>, AppError> {
        let rows: Vec<(Uuid, Uuid, String, Value)> = sqlx::query_as(
            "select piece_id,material_id,role,subject from studio_piece_materials \
             where workspace_id=$1 and slot_id=$2 and revision=$3 order by material_id",
        )
        .bind(self.workspace_id().0)
        .bind(slot.0)
        .bind(revision(rev)?)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read piece materials"))?;
        let Some((_, _, _, subject)) = rows.first() else {
            return Ok(None);
        };
        let subject: Subject = decode(subject.clone())?;
        let uses = rows
            .into_iter()
            .map(|(piece, material, role, _)| {
                Ok(PieceMaterial {
                    piece_id: jt_studio::PieceId(piece),
                    slot_id: slot,
                    revision: rev,
                    material_id: MaterialId(material),
                    role: decode(Value::String(role))?,
                })
            })
            .collect::<Result<_, AppError>>()?;
        Ok(Some(PieceMaterials { subject, uses }))
    }

    async fn uses_of(&mut self, material: MaterialId) -> Result<Vec<PieceMaterial>, AppError> {
        let rows: Vec<(Uuid, Uuid, i64, String)> = sqlx::query_as(
            "select piece_id,slot_id,revision,role from studio_piece_materials \
             where workspace_id=$1 and material_id=$2 order by slot_id, revision",
        )
        .bind(self.workspace_id().0)
        .bind(material.0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read material uses"))?;
        rows.into_iter()
            .map(|(piece, slot, rev, role)| {
                Ok(PieceMaterial {
                    piece_id: jt_studio::PieceId(piece),
                    slot_id: SlotId(slot),
                    revision: u64::try_from(rev)
                        .map_err(|_| AppError::internal("invalid stored revision"))?,
                    material_id: material,
                    role: decode(Value::String(role))?,
                })
            })
            .collect()
    }

    async fn calendar_rows(&mut self) -> Result<Vec<CalendarEntry>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_calendar_entries where workspace_id=$1 order by year, key",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read calendar"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn save_calendar_row(&mut self, row: CalendarEntry) -> Result<(), AppError> {
        checked("studio_calendar_entries", row.validate())?;
        sqlx::query(
            "insert into studio_calendar_entries(workspace_id,key,year,data,kind,window_start,window_end,lead_days,enabled) \
             values($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             on conflict (workspace_id,key,year) do update set data=excluded.data,kind=excluded.kind,\
             window_start=excluded.window_start,window_end=excluded.window_end,\
             lead_days=excluded.lead_days,enabled=excluded.enabled",
        )
        .bind(self.workspace_id().0)
        .bind(&row.key)
        .bind(row.year)
        .bind(encode(&row)?)
        .bind(name(&row.kind)?)
        .bind(row.window_start)
        .bind(row.window_end)
        .bind(row.lead_days.map(i32::from))
        .bind(row.enabled)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save calendar row"))?;
        Ok(())
    }

    async fn insert_shoot_request(&mut self, r: ShootRequest) -> Result<bool, AppError> {
        same_workspace(self.workspace_id(), r.workspace_id)?;
        checked("studio_shoot_requests", r.validate())?;
        let done = sqlx::query(
            "insert into studio_shoot_requests(workspace_id,id,key,data,status,week_start,created_at) \
             values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing",
        )
        .bind(self.workspace_id().0)
        .bind(r.id.0)
        .bind(&r.key)
        .bind(encode(&r)?)
        .bind(r.status.key())
        .bind(r.week_start)
        .bind(r.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert shoot request"))?;
        if done.rows_affected() == 1 {
            return Ok(true);
        }
        let keyed: bool = sqlx::query_scalar(
            "select exists(select 1 from studio_shoot_requests where workspace_id=$1 and key=$2)",
        )
        .bind(self.workspace_id().0)
        .bind(&r.key)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read shoot request"))?;
        if keyed {
            Ok(false)
        } else {
            Err(AppError::conflict(
                "insert shoot request: the value is already taken",
            ))
        }
    }

    async fn update_shoot_request(&mut self, r: ShootRequest) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), r.workspace_id)?;
        checked("studio_shoot_requests", r.validate())?;
        let current = self
            .get_shoot_request(r.id)
            .await?
            .ok_or_else(|| AppError::not_found("shoot request"))?;
        if current.key != r.key {
            return Err(AppError::internal(
                "studio_shoot_requests: the key never changes",
            ));
        }
        sqlx::query(
            "update studio_shoot_requests set data=$3,status=$4,week_start=$5 where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(r.id.0)
        .bind(encode(&r)?)
        .bind(r.status.key())
        .bind(r.week_start)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update shoot request"))?;
        Ok(())
    }

    async fn get_shoot_request(
        &mut self,
        id: ShootRequestId,
    ) -> Result<Option<ShootRequest>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from studio_shoot_requests where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read shoot request"))?;
        row.map(decode).transpose()
    }

    async fn list_shoot_requests(&mut self) -> Result<Vec<ShootRequest>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_shoot_requests where workspace_id=$1 \
             order by week_start desc, created_at desc, id desc",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read shoot requests"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn material_policy(&mut self) -> Result<MaterialPolicy, AppError> {
        let row: Option<(i32, i32, i32, bool)> = sqlx::query_as(
            "select lead_days,reuse_days,recap_days,ai_standalone from studio_material_policy \
             where workspace_id=$1",
        )
        .bind(self.workspace_id().0)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read materials policy"))?;
        let Some((lead, reuse, recap, ai_standalone)) = row else {
            return Ok(MaterialPolicy::default());
        };
        let days =
            |d: i32| u16::try_from(d).map_err(|_| AppError::internal("invalid stored policy"));
        Ok(MaterialPolicy {
            lead_days: days(lead)?,
            reuse_days: days(reuse)?,
            recap_days: days(recap)?,
            ai_standalone,
        })
    }

    async fn save_material_policy(&mut self, p: MaterialPolicy) -> Result<(), AppError> {
        checked("studio_material_policy", p.validate())?;
        sqlx::query(
            "insert into studio_material_policy\
             (workspace_id,lead_days,reuse_days,recap_days,ai_standalone) values($1,$2,$3,$4,$5) \
             on conflict (workspace_id) do update set lead_days=excluded.lead_days,\
             reuse_days=excluded.reuse_days,recap_days=excluded.recap_days,\
             ai_standalone=excluded.ai_standalone",
        )
        .bind(self.workspace_id().0)
        .bind(i32::from(p.lead_days))
        .bind(i32::from(p.reuse_days))
        .bind(i32::from(p.recap_days))
        .bind(p.ai_standalone)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save materials policy"))?;
        Ok(())
    }

    async fn save_release(&mut self, r: MaterialRelease) -> Result<(), AppError> {
        let slot: bool = sqlx::query_scalar(
            "select exists(select 1 from studio_slots where workspace_id=$1 and id=$2)",
        )
        .bind(self.workspace_id().0)
        .bind(r.slot_id.0)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read slot"))?;
        if !slot {
            return Err(AppError::not_found("slot"));
        }
        sqlx::query(
            "insert into studio_material_releases(workspace_id,slot_id,revision,digest,released_by,released_at) \
             values($1,$2,$3,$4,$5,$6) on conflict (workspace_id,slot_id,revision) do update set \
             digest=excluded.digest,released_by=excluded.released_by,released_at=excluded.released_at",
        )
        .bind(self.workspace_id().0)
        .bind(r.slot_id.0)
        .bind(revision(r.revision)?)
        .bind(&r.digest)
        .bind(r.by.0)
        .bind(r.at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save material release"))?;
        Ok(())
    }

    async fn get_release(
        &mut self,
        slot: SlotId,
        rev: u64,
    ) -> Result<Option<MaterialRelease>, AppError> {
        let row: Option<(String, Uuid, OffsetDateTime)> = sqlx::query_as(
            "select digest,released_by,released_at from studio_material_releases \
             where workspace_id=$1 and slot_id=$2 and revision=$3",
        )
        .bind(self.workspace_id().0)
        .bind(slot.0)
        .bind(revision(rev)?)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read material release"))?;
        Ok(row.map(|(digest, by, at)| MaterialRelease {
            slot_id: slot,
            revision: rev,
            digest,
            by: jt_tenancy::UserId(by),
            at,
        }))
    }
}
