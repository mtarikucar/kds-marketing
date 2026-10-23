//! `inbound_events`: what webhooks and polls brought in, once per provider id.
//!
//! `provider` and `kind` hold their keys, `payload` the parsed body and `raw` the body as
//! received. `(workspace_id, provider, external_id)` is unique, so a replayed delivery is skipped
//! by `on conflict do nothing` without aborting the transaction (Review Focus 2). A trigger lets
//! only `processed_at` change and `raw` be removed, and refuses every delete; no statement here
//! reads `raw` back. Listings page by the key `(received_at, id)` in either direction.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{EventOrder, EventQuery, InboundEventRepo, MAX_EVENT_PAGE};
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
    async fn call_events(
        &mut self,
        unique_id: &str,
        until: OffsetDateTime,
    ) -> Result<Vec<InboundEvent>, AppError> {
        let records: Vec<EventRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from inbound_events where workspace_id=$1 and provider='netgsm' \
             and kind='call_event' and call_unique_id=$2 and received_at<=$3 \
             order by received_at,id"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(unique_id)
        .bind(until)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list call events"))?;
        records.into_iter().map(EventRecord::into_event).collect()
    }

    async fn list_for_consumer(
        &mut self,
        consumer: &str,
        cursor: Option<(OffsetDateTime, InboundEventId)>,
        limit: u32,
    ) -> Result<Vec<InboundEvent>, AppError> {
        let records: Vec<EventRecord> = sqlx::query_as(&format!(
            "select {COLUMNS} from inbound_events e where workspace_id=$1 and ($3::timestamptz is null or (received_at,id)>($3,$4)) and not exists (select 1 from event_consumption c where c.workspace_id=e.workspace_id and c.event_id=e.id and c.consumer=$2 and not (c.consumer='inbox@2' and e.provider='meta' and e.kind='lead_gen' and c.outcome is not distinct from 'deferred')) order by received_at,id limit $5"
        )).bind(self.workspace_id().as_uuid()).bind(consumer).bind(cursor.map(|(at,_)|at)).bind(cursor.map(|(_,id)|id.as_uuid())).bind(i64::from(limit.clamp(1,MAX_EVENT_PAGE)))
        .fetch_all(self.tx.conn()).await.map_err(|e| map_sqlx(e,"list events for consumer"))?;
        records.into_iter().map(EventRecord::into_event).collect()
    }

    /// `on conflict do nothing` covers both the id and the provider id. When it skipped the row,
    /// a second statement tells a replay (`None`) from a taken id (`CONFLICT`). That statement
    /// sees whatever committed meanwhile because tenant transactions run at READ COMMITTED (each
    /// statement takes a fresh snapshot); under a stricter isolation it would not see a racing
    /// bundle's row and would answer `CONFLICT` for a replay.
    async fn insert_if_new(
        &mut self,
        mut event: InboundEvent,
        mut raw: Option<Vec<u8>>,
    ) -> Result<Option<InboundEventId>, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, event.workspace_id)?;
        if let Some(capability) = event.capability_id {
            ensure_capability(self.tx.conn(), ws, capability).await?;
        }
        jt_app::ports::inbox::PersonRepo::lock_workspace(self).await?;
        if jt_app::usecases::inbox::erasure::scrub_inbound(
            self,
            event.capability_id,
            &mut event.payload,
        )
        .await?
        {
            raw = None;
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

    /// One statement per order; every filter is a bind parameter that is `null` when unset, and
    /// the cursor is a row comparison on `(received_at, id)`, which the order shares.
    async fn list(&mut self, query: EventQuery) -> Result<Vec<InboundEvent>, AppError> {
        let ws = self.workspace_id();
        let (sql, cursor) = match query.order {
            EventOrder::OldestFirst { after } => (
                format!(
                    "select {COLUMNS} from inbound_events \
                     where workspace_id = $1 \
                     and (not $2 or processed_at is null) \
                     and ($3::text is null or provider = $3) \
                     and ($4::text is null or kind = $4) \
                     and ($5::timestamptz is null or (received_at, id) > ($5, $6)) \
                     order by received_at, id limit $7"
                ),
                after,
            ),
            EventOrder::NewestFirst { before } => (
                format!(
                    "select {COLUMNS} from inbound_events \
                     where workspace_id = $1 \
                     and (not $2 or processed_at is null) \
                     and ($3::text is null or provider = $3) \
                     and ($4::text is null or kind = $4) \
                     and ($5::timestamptz is null or (received_at, id) < ($5, $6)) \
                     order by received_at desc, id desc limit $7"
                ),
                before,
            ),
        };
        let records: Vec<EventRecord> = sqlx::query_as(&sql)
            .bind(ws.as_uuid())
            .bind(query.pending_only)
            .bind(query.provider.map(|p| p.key()))
            .bind(query.kind.as_ref().map(EventKind::key))
            .bind(cursor.map(|(at, _)| at))
            .bind(cursor.map(|(_, id)| id.as_uuid()))
            .bind(i64::from(query.limit.clamp(1, MAX_EVENT_PAGE)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list inbound events"))?;
        records.into_iter().map(EventRecord::into_event).collect()
    }

    async fn count_pending(&mut self, cap: u32) -> Result<u32, AppError> {
        let ws = self.workspace_id();
        let n: i64 = sqlx::query_scalar(
            "select count(*) from (select 1 from inbound_events \
             where workspace_id = $1 and processed_at is null limit $2) pending",
        )
        .bind(ws.as_uuid())
        .bind(i64::from(cap))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count pending inbound events"))?;
        // At most `cap`, which fits.
        Ok(u32::try_from(n).unwrap_or(cap))
    }
}
