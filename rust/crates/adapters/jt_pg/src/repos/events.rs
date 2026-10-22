//! `inbound_events`: what webhooks and polls brought in, once per provider id.
//!
//! `provider` and `kind` hold their keys, `payload` the parsed body and `raw` the body as
//! received. `(workspace_id, provider, external_id)` is unique, so a replayed delivery is skipped
//! by `on conflict do nothing` without aborting the transaction (Review Focus 2). A trigger lets
//! only `processed_at` change and `raw` be removed, and refuses every delete; no statement here
//! reads `raw` back.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{InboundEventRepo, MAX_EVENT_PAGE};
use jt_capability::CapabilityId;
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capabilities::ensure_capability;
use super::{map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

/// The columns every read selects.
const COLUMNS: &str = "id, workspace_id, provider, capability_id, external_id, kind, payload, received_at, \
     processed_at";

#[derive(sqlx::FromRow)]
struct EventRecord {
    id: Uuid,
    workspace_id: Uuid,
    provider: String,
    capability_id: Option<Uuid>,
    external_id: String,
    kind: String,
    payload: serde_json::Value,
    received_at: OffsetDateTime,
    processed_at: Option<OffsetDateTime>,
}

impl EventRecord {
    fn into_event(self) -> Result<InboundEvent, AppError> {
        Ok(InboundEvent {
            id: InboundEventId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            provider: stored(Provider::parse(&self.provider), "inbound_events.provider")?,
            capability_id: self.capability_id.map(CapabilityId),
            external_id: self.external_id,
            kind: EventKind::parse(&self.kind),
            payload: self.payload,
            received_at: self.received_at,
            processed_at: self.processed_at,
        })
    }
}

#[async_trait]
impl InboundEventRepo for PgTenantRepos {
    /// `on conflict do nothing` covers both the id and the provider id. When it skipped the row,
    /// a second statement (which sees whatever committed meanwhile) tells a replay (`None`) from
    /// a taken id (`CONFLICT`).
    async fn insert_if_new(
        &mut self,
        event: InboundEvent,
        raw: Option<Vec<u8>>,
    ) -> Result<Option<InboundEventId>, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, event.workspace_id)?;
        if let Some(capability) = event.capability_id {
            ensure_capability(self.tx.conn(), ws, capability).await?;
        }
        let done = sqlx::query(
            "insert into inbound_events (id, workspace_id, provider, capability_id, external_id, \
             kind, payload, raw, received_at, processed_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             on conflict do nothing",
        )
        .bind(event.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(event.provider.key())
        .bind(event.capability_id.map(|c| c.as_uuid()))
        .bind(&event.external_id)
        .bind(event.kind.key())
        .bind(&event.payload)
        .bind(raw)
        .bind(event.received_at)
        .bind(event.processed_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert inbound event"))?;
        if done.rows_affected() == 1 {
            return Ok(Some(event.id));
        }
        let replay: bool = sqlx::query_scalar(
            "select exists (select 1 from inbound_events \
             where workspace_id = $1 and provider = $2 and external_id = $3)",
        )
        .bind(ws.as_uuid())
        .bind(event.provider.key())
        .bind(&event.external_id)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find inbound event"))?;
        if replay {
            Ok(None)
        } else {
            Err(AppError::conflict("the inbound event id is already taken"))
        }
    }

    async fn list_pending(&mut self, limit: u32) -> Result<Vec<InboundEvent>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<EventRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from inbound_events \
             where workspace_id = $1 and processed_at is null \
             order by received_at, id limit $2"
        ))
        .bind(ws.as_uuid())
        .bind(i64::from(limit.clamp(1, MAX_EVENT_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list pending inbound events"))?;
        records.into_iter().map(EventRecord::into_event).collect()
    }

    async fn mark_processed(
        &mut self,
        id: InboundEventId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update inbound_events set processed_at = $3 \
             where workspace_id = $1 and id = $2 and processed_at is null",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "mark inbound event processed"))?;
        if done.rows_affected() == 1 {
            return Ok(true);
        }
        let found: Option<i32> =
            sqlx::query_scalar("select 1 from inbound_events where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(id.as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "find inbound event"))?;
        match found {
            Some(_) => Ok(false),
            None => Err(AppError::not_found("no such inbound event")),
        }
    }

    async fn purge_raw_before(&mut self, cutoff: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "update inbound_events set raw = null \
             where workspace_id = $1 and received_at < $2 and raw is not null",
        )
        .bind(ws.as_uuid())
        .bind(cutoff)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "purge inbound event bodies"))?;
        Ok(done.rows_affected())
    }
}
