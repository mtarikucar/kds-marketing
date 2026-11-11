//! Olay-driven publishing's storage (migration `0022_studio_posts`): each slot's planned post, the
//! package requests the triggers write and the workspace's posting policy with its time zone.
//! Records are kept whole in `data`; the columns are what the checks, keys and indexes need,
//! written from the same record.
use super::{decode, encode};
use crate::{
    repos::{map_sqlx, same_workspace},
    uow::PgTenantRepos,
};
use async_trait::async_trait;
use jt_app::{error::AppError, ports::posts::*};
use jt_studio::SlotId;
use serde_json::Value;
use uuid::Uuid;

fn checked<E: std::fmt::Display>(table: &str, result: Result<(), E>) -> Result<(), AppError> {
    result.map_err(|e| AppError::internal(format!("{table} check: {e}")))
}

/// Whether the workspace has the slot of id `$2`.
const SLOT_STORED: &str =
    "select exists(select 1 from studio_slots where workspace_id=$1 and id=$2)";
/// Whether the workspace has the olay of id `$2`.
const OLAY_STORED: &str =
    "select exists(select 1 from studio_olays where workspace_id=$1 and id=$2)";
/// Whether the workspace has the package request of id `$2`.
const REQUEST_STORED: &str =
    "select exists(select 1 from studio_package_requests where workspace_id=$1 and id=$2)";
/// Whether the workspace has a post for the slot of id `$2`.
const POST_STORED: &str =
    "select exists(select 1 from studio_posts where workspace_id=$1 and slot_id=$2)";

impl PgTenantRepos {
    /// Runs one of the `*_STORED` statements for `id`.
    async fn posts_ref_stored(
        &mut self,
        statement: &'static str,
        id: Uuid,
        what: &str,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar::<_, bool>(statement)
            .bind(self.workspace_id().0)
            .bind(id)
            .fetch_one(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, what))
    }
}

#[async_trait]
impl PostRepo for PgTenantRepos {
    async fn insert_post(&mut self, post: PlannedPost) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), post.workspace_id)?;
        checked("studio_posts", post.validate())?;
        if post.retired.is_some() {
            return Err(AppError::internal("studio_posts: a post is stored live"));
        }
        if !self
            .posts_ref_stored(SLOT_STORED, post.slot_id.0, "read slot")
            .await?
        {
            return Err(AppError::not_found("slot"));
        }
        if !self
            .posts_ref_stored(
                REQUEST_STORED,
                post.package_request_id.0,
                "read package request",
            )
            .await?
        {
            return Err(AppError::not_found("package request"));
        }
        if let Some(olay) = post.olay_id
            && !self
                .posts_ref_stored(OLAY_STORED, olay.0, "read olay")
                .await?
        {
            return Err(AppError::not_found("olay"));
        }
        let done = sqlx::query(
            "insert into studio_posts(workspace_id,slot_id,data,format,capability_id,publish_at,\
             prep_start_at,grace_until,olay_id,package_request_id,retired_reason,retired_at,created_at) \
             values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,null,$11) on conflict do nothing",
        )
        .bind(self.workspace_id().0)
        .bind(post.slot_id.0)
        .bind(encode(&post)?)
        .bind(post.format.key())
        .bind(post.capability_id.0)
        .bind(post.publish_at)
        .bind(post.prep_start_at)
        .bind(post.grace_until)
        .bind(post.olay_id.map(|o| o.0))
        .bind(post.package_request_id.0)
        .bind(post.created_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert post"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "insert post: the value is already taken",
            ));
        }
        Ok(())
    }

    async fn get_post(&mut self, slot: SlotId) -> Result<Option<PlannedPost>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from studio_posts where workspace_id=$1 and slot_id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(slot.0)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read post"))?;
        row.map(decode).transpose()
    }

    async fn list_posts(&mut self) -> Result<Vec<PlannedPost>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_posts where workspace_id=$1 order by publish_at, slot_id",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read posts"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn retire_post(
        &mut self,
        slot: SlotId,
        retired: PostRetirement,
    ) -> Result<bool, AppError> {
        // One statement: only a post not retired yet takes the retirement, in its record too.
        let done = sqlx::query(
            "update studio_posts set data=jsonb_set(data,'{retired}',$3),retired_reason=$4,retired_at=$5 \
             where workspace_id=$1 and slot_id=$2 and retired_at is null",
        )
        .bind(self.workspace_id().0)
        .bind(slot.0)
        .bind(encode(&retired)?)
        .bind(retired.reason.code())
        .bind(retired.at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "retire post"))?;
        if done.rows_affected() == 1 {
            return Ok(true);
        }
        if self
            .posts_ref_stored(POST_STORED, slot.0, "read post")
            .await?
        {
            Ok(false)
        } else {
            Err(AppError::not_found("post"))
        }
    }

    async fn insert_package_request(&mut self, request: PackageRequest) -> Result<bool, AppError> {
        same_workspace(self.workspace_id(), request.workspace_id)?;
        checked("studio_package_requests", request.validate())?;
        let done = sqlx::query(
            "insert into studio_package_requests(workspace_id,id,key,trigger,status,data,created_at,\
             answered_at,closed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing",
        )
        .bind(self.workspace_id().0)
        .bind(request.id.0)
        .bind(&request.key)
        .bind(request.trigger.key())
        .bind(request.status.key())
        .bind(encode(&request)?)
        .bind(request.created_at)
        .bind(request.answered_at)
        .bind(request.closed_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert package request"))?;
        if done.rows_affected() == 1 {
            return Ok(true);
        }
        // Skipped: its key is taken (nothing written), or else its id.
        let keyed: bool = sqlx::query_scalar(
            "select exists(select 1 from studio_package_requests where workspace_id=$1 and key=$2)",
        )
        .bind(self.workspace_id().0)
        .bind(&request.key)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read package request"))?;
        if keyed {
            Ok(false)
        } else {
            Err(AppError::conflict(
                "insert package request: the value is already taken",
            ))
        }
    }

    async fn update_package_request(&mut self, request: PackageRequest) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), request.workspace_id)?;
        checked("studio_package_requests", request.validate())?;
        let current = PostRepo::get_package_request(self, request.id)
            .await?
            .ok_or_else(|| AppError::not_found("package request"))?;
        if current.key != request.key
            || current.trigger != request.trigger
            || current.created_at != request.created_at
        {
            return Err(AppError::internal(
                "studio_package_requests: the key, trigger and creation never change",
            ));
        }
        if current.status != PackageStatus::Open {
            return Err(AppError::conflict("the package request is closed"));
        }
        let done = sqlx::query(
            "update studio_package_requests set data=$3,status=$4,answered_at=$5,closed_at=$6 \
             where workspace_id=$1 and id=$2 and status='open'",
        )
        .bind(self.workspace_id().0)
        .bind(request.id.0)
        .bind(encode(&request)?)
        .bind(request.status.key())
        .bind(request.answered_at)
        .bind(request.closed_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update package request"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the package request is closed"));
        }
        Ok(())
    }

    async fn get_package_request(
        &mut self,
        id: PackageRequestId,
    ) -> Result<Option<PackageRequest>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from studio_package_requests where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read package request"))?;
        row.map(decode).transpose()
    }

    async fn list_package_requests(&mut self) -> Result<Vec<PackageRequest>, AppError> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from studio_package_requests where workspace_id=$1 \
             order by created_at desc, id desc",
        )
        .bind(self.workspace_id().0)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read package requests"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn posting_settings(&mut self) -> Result<PostingSettings, AppError> {
        let row: Option<(Value, String)> =
            sqlx::query_as("select data,tz from studio_posting_policy where workspace_id=$1")
                .bind(self.workspace_id().0)
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read posting policy"))?;
        Ok(match row {
            None => PostingSettings::default(),
            Some((data, tz)) => PostingSettings {
                policy: decode(data)?,
                tz,
            },
        })
    }

    async fn save_posting_settings(&mut self, settings: PostingSettings) -> Result<(), AppError> {
        let p = settings.policy;
        checked("studio_posting_policy", p.validate())?;
        if settings.tz.is_empty() || settings.tz.len() > 64 {
            return Err(AppError::internal("studio_posting_policy check: tz"));
        }
        let debounce = i32::try_from(p.debounce_minutes)
            .map_err(|_| AppError::internal("studio_posting_policy check: debounce_minutes"))?;
        sqlx::query(
            "insert into studio_posting_policy(workspace_id,data,tz,floor_days,debounce_minutes,\
             horizon_days,quiet_start_hour,quiet_end_hour) values($1,$2,$3,$4,$5,$6,$7,$8) \
             on conflict (workspace_id) do update set data=excluded.data,tz=excluded.tz,\
             floor_days=excluded.floor_days,debounce_minutes=excluded.debounce_minutes,\
             horizon_days=excluded.horizon_days,quiet_start_hour=excluded.quiet_start_hour,\
             quiet_end_hour=excluded.quiet_end_hour",
        )
        .bind(self.workspace_id().0)
        .bind(encode(&p)?)
        .bind(&settings.tz)
        .bind(i32::from(p.floor_days))
        .bind(debounce)
        .bind(i32::from(p.horizon_days))
        .bind(i32::from(p.quiet_start_hour))
        .bind(i32::from(p.quiet_end_hour))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "save posting policy"))?;
        Ok(())
    }
}
