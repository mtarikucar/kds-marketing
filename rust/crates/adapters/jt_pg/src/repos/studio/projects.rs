use super::{PgTenantRepos, decode, encode, map_sqlx, revision};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::production_projects::{DoneCursor, ProductionProject, ProjectRepo},
};
use serde_json::Value;
use uuid::Uuid;

// The mirrored columns `start_at` and `done_at` are computed in SQL from the document being
// stored, by the expressions of the table's checks (migration 0036): the start time (the creation
// time of an area from before), and the delivery time of the current package while no redo
// stands and no requested material is awaited. A stored row therefore satisfies its checks
// whatever precision the document's times carry.
const UPDATE: &str = r#"update studio_production_projects set data=$3,revision=$4,archived=$5,
    start_at=production_area_time(coalesce(nullif($3::jsonb->'start_at','null'::jsonb),
                                           $3::jsonb->'created_at')),
    done_at=case when nullif($3::jsonb->'redo','null'::jsonb) is null
                  and not jsonb_path_exists($3::jsonb, '$.requests[*] ? (@.status == "open")')
                 then production_area_time($3::jsonb->'packages'->-1->'delivered_at') end
    where workspace_id=$1 and id=$2 and revision=$6"#;
const INSERT: &str = r#"insert into studio_production_projects
    (workspace_id,id,revision,archived,data,start_at,done_at) values($1,$2,$3,$4,$5,
    production_area_time(coalesce(nullif($5::jsonb->'start_at','null'::jsonb),
                                  $5::jsonb->'created_at')),
    case when nullif($5::jsonb->'redo','null'::jsonb) is null
          and not jsonb_path_exists($5::jsonb, '$.requests[*] ? (@.status == "open")')
         then production_area_time($5::jsonb->'packages'->-1->'delivered_at') end)
    on conflict do nothing"#;

#[async_trait]
impl ProjectRepo for PgTenantRepos {
    async fn get_project(&mut self, id: Uuid) -> Result<Option<ProductionProject>, AppError> {
        self.studio_record("studio_production_projects", id).await
    }
    async fn list_projects(
        &mut self,
        archived: bool,
        before: Option<Uuid>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar("select data from studio_production_projects where workspace_id=$1 and archived=$2 and ($3::uuid is null or id<$3) order by id desc limit 101")
            .bind(self.workspace_id().0).bind(archived).bind(before).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"list production projects"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn list_areas(
        &mut self,
        done: bool,
        before: Option<DoneCursor>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let rows: Vec<Value> = if done {
            sqlx::query_scalar(
                "select data from studio_production_projects \
                 where workspace_id=$1 and not archived and done_at is not null \
                   and ($2::timestamptz is null or (done_at,id)<($2,$3)) \
                 order by done_at desc,id desc limit 51",
            )
            .bind(self.workspace_id().0)
            .bind(before.map(|c| c.at))
            .bind(before.map(|c| c.id))
            .fetch_all(self.tx.conn())
            .await
        } else {
            sqlx::query_scalar(
                "select data from studio_production_projects \
                 where workspace_id=$1 and not archived and done_at is null \
                 order by start_at,id limit 200",
            )
            .bind(self.workspace_id().0)
            .fetch_all(self.tx.conn())
            .await
        }
        .map_err(|e| map_sqlx(e, "list production areas"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn list_areas_waiting(&mut self) -> Result<Vec<ProductionProject>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            r#"select data from studio_production_projects
               where workspace_id=$1 and not archived and done_at is not null
                 and jsonb_path_exists(data, '$.packages[last].versions[*] ? (@.slot_id == null)')
               order by done_at,id limit 200"#,
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list waiting production areas"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn save_project(
        &mut self,
        mut p: ProductionProject,
        expected: Option<u64>,
    ) -> Result<(), AppError> {
        if p.workspace_id != self.workspace_id() {
            return Err(AppError::internal("project workspace mismatch"));
        }
        if p.revision != expected.unwrap_or(0).saturating_add(1) {
            return Err(AppError::conflict("project revision changed"));
        }
        // The state is an answer's projection of one moment; the document does not carry it.
        p.state = None;
        let count = if let Some(expected) = expected {
            sqlx::query(UPDATE)
                .bind(p.workspace_id.0)
                .bind(p.id)
                .bind(encode(&p)?)
                .bind(revision(p.revision)?)
                .bind(p.archived)
                .bind(revision(expected)?)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "update production project"))?
                .rows_affected()
        } else {
            sqlx::query(INSERT)
                .bind(p.workspace_id.0)
                .bind(p.id)
                .bind(revision(p.revision)?)
                .bind(p.archived)
                .bind(encode(&p)?)
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "insert production project"))?
                .rows_affected()
        };
        if count != 1 {
            return Err(AppError::conflict("project revision changed"));
        }
        Ok(())
    }
}
