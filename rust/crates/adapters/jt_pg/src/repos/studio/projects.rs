use super::{PgTenantRepos, decode, encode, map_sqlx, revision};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::production_projects::{
        AreaCount, AreaOlay, AreaPost, AreaPosts, DoneCursor, MAX_REFUSALS, ProductionProject,
        ProjectRepo,
    },
};
use jt_studio::{MaterialId, OlayId, SlotId};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use uuid::Uuid;

/// One planned post of an area as `area_posts` reads it out of the document.
#[derive(Deserialize)]
struct PostRow {
    version_id: Uuid,
    slot_id: Uuid,
    current: bool,
}

// An area's planned posts, read out of its document in package then version order: each version
// with a slot, and whether its package is the last one. The areas listed are those not archived
// that are held (refused `$2` times) or have such a version.
const AREA_POSTS: &str = r#"select p.id, p.olay_id,
    coalesce((p.data->>'refused')::int, 0) >= $2 as held,
    p.done_at is not null as done,
    coalesce((select jsonb_agg(jsonb_build_object(
                  'version_id', v.value->'id', 'slot_id', v.value->'slot_id',
                  'current', k.ord = jsonb_array_length(p.data->'packages'))
                  order by k.ord, v.ord)
             from jsonb_array_elements(coalesce(p.data->'packages', '[]'::jsonb))
                  with ordinality as k(value, ord)
             cross join lateral jsonb_array_elements(coalesce(k.value->'versions', '[]'::jsonb))
                  with ordinality as v(value, ord)
             where nullif(v.value->'slot_id', 'null'::jsonb) is not null), '[]'::jsonb) as posts
    from studio_production_projects p
    where p.workspace_id = $1 and not p.archived
      and (coalesce((p.data->>'refused')::int, 0) >= $2
           or jsonb_path_exists(p.data, '$.packages[*].versions[*] ? (@.slot_id != null)'))
    order by p.id"#;

// The materials among `$2` that some area of the workspace holds, archived or not: its sources'
// materials and those its packages' versions show, read out of its document.
const MATERIALS_IN_AREAS: &str = r#"select distinct u.id
    from studio_production_projects p
    cross join lateral (
        select (x #>> '{}')::uuid as id
          from jsonb_path_query(p.data, '$.sources[*].material_id') as x
        union
        select (x #>> '{}')::uuid
          from jsonb_path_query(p.data, '$.packages[*].versions[*].material_ids[*]') as x
    ) as u
    where p.workspace_id = $1 and u.id = any($2)"#;

/// The binds of an olay filter: whether one is given, and its olay (`None` with a filter: the
/// areas of no olay). `olay_id` is a column generated from the document (migration 0044).
fn olay_binds(olay: Option<AreaOlay>) -> (bool, Option<Uuid>) {
    match olay {
        None => (false, None),
        Some(AreaOlay::Genel) => (true, None),
        Some(AreaOlay::Olay(id)) => (true, Some(id.0)),
    }
}

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
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let (filtered, olay) = olay_binds(olay);
        let rows: Vec<Value> = sqlx::query_scalar("select data from studio_production_projects where workspace_id=$1 and archived=$2 and ($3::uuid is null or id<$3) and (not $4 or olay_id is not distinct from $5) order by id desc limit 101")
            .bind(self.workspace_id().0).bind(archived).bind(before).bind(filtered).bind(olay).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"list production projects"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn list_areas(
        &mut self,
        done: bool,
        before: Option<DoneCursor>,
        olay: Option<AreaOlay>,
    ) -> Result<Vec<ProductionProject>, AppError> {
        let (filtered, olay) = olay_binds(olay);
        let rows: Vec<Value> = if done {
            sqlx::query_scalar(
                "select data from studio_production_projects \
                 where workspace_id=$1 and not archived and done_at is not null \
                   and ($2::timestamptz is null or (done_at,id)<($2,$3)) \
                   and (not $4 or olay_id is not distinct from $5) \
                 order by done_at desc,id desc limit 51",
            )
            .bind(self.workspace_id().0)
            .bind(before.map(|c| c.at))
            .bind(before.map(|c| c.id))
            .bind(filtered)
            .bind(olay)
            .fetch_all(self.tx.conn())
            .await
        } else {
            sqlx::query_scalar(
                "select data from studio_production_projects \
                 where workspace_id=$1 and not archived and done_at is null \
                   and (not $2 or olay_id is not distinct from $3) \
                 order by start_at,id limit 200",
            )
            .bind(self.workspace_id().0)
            .bind(filtered)
            .bind(olay)
            .fetch_all(self.tx.conn())
            .await
        }
        .map_err(|e| map_sqlx(e, "list production areas"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn area_counts(&mut self) -> Result<Vec<AreaCount>, AppError> {
        let rows: Vec<(Option<Uuid>, i64, i64)> = sqlx::query_as(
            r#"select olay_id, count(*)::bigint,
                      coalesce(sum(jsonb_array_length(jsonb_path_query_array(
                          data, '$.requests[*] ? (@.status == "open")'))), 0)::bigint
               from studio_production_projects
               where workspace_id=$1 and not archived
               group by olay_id
               order by olay_id nulls first"#,
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count production areas"))?;
        Ok(rows
            .into_iter()
            .map(|(olay_id, areas, open_requests)| AreaCount {
                olay_id: olay_id.map(OlayId),
                areas: u64::try_from(areas).unwrap_or(0),
                open_requests: u64::try_from(open_requests).unwrap_or(0),
            })
            .collect())
    }
    async fn area_posts(&mut self) -> Result<Vec<AreaPosts>, AppError> {
        let rows: Vec<(Uuid, Option<Uuid>, bool, bool, Value)> = sqlx::query_as(AREA_POSTS)
            .bind(self.workspace_id().0)
            .bind(i32::from(MAX_REFUSALS))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list production area posts"))?;
        rows.into_iter()
            .map(|(id, olay_id, held, done, posts)| {
                let posts: Vec<PostRow> = decode(posts)?;
                Ok(AreaPosts {
                    id,
                    olay_id: olay_id.map(OlayId),
                    held,
                    done,
                    posts: posts
                        .into_iter()
                        .map(|p| AreaPost {
                            version_id: p.version_id,
                            slot_id: SlotId(p.slot_id),
                            current: p.current,
                        })
                        .collect(),
                })
            })
            .collect()
    }
    async fn materials_in_areas(
        &mut self,
        ids: &[MaterialId],
    ) -> Result<BTreeSet<MaterialId>, AppError> {
        if ids.is_empty() {
            return Ok(BTreeSet::new());
        }
        let ids: Vec<Uuid> = ids.iter().map(|m| m.0).collect();
        let rows: Vec<Uuid> = sqlx::query_scalar(MATERIALS_IN_AREAS)
            .bind(self.workspace_id().0)
            .bind(&ids)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list materials held by production areas"))?;
        Ok(rows.into_iter().map(MaterialId).collect())
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
    async fn list_live_areas(&mut self) -> Result<Vec<ProductionProject>, AppError> {
        // Served by 0031's `studio_projects_recent (workspace_id, archived, id desc)`.
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_production_projects \
             where workspace_id=$1 and not archived order by id desc",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list live production areas"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn find_area_by_version(
        &mut self,
        version_id: Uuid,
    ) -> Result<Option<ProductionProject>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            r#"select data from studio_production_projects
               where workspace_id=$1
                 and jsonb_path_exists(data, '$.packages[*].versions[*] ? (@.id == $v)',
                                       jsonb_build_object('v', $2::text))
               order by id limit 1"#,
        )
        .bind(self.workspace_id().0)
        .bind(version_id.to_string())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find production area by version"))?;
        row.map(decode).transpose()
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
