//! `budget_items`, `capability_budget_links` and `budget_spend_entries`: the workspace's budget
//! items, which capabilities spend from them, and the append-only ledger of what was spent. A
//! retired item keeps its row (`retired_at` set) and its spend; its links are deleted.
//!
//! `unit` and `source` are the JSON of `jt_capability::Unit` and `SpendSource`; `kind` and
//! `period` hold their keys. Links and spend entries reference their rows together with the
//! workspace (composite foreign keys), and writes check first that the rows are this workspace's,
//! so another workspace's capability or item is `NOT_FOUND` (Review Focus 3) before a foreign key
//! would refuse it. A trigger refuses every update and delete of a spend entry.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{BudgetRepo, MAX_SPEND_PAGE};
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, CapabilityId, Period,
    SpendSource, Unit,
};
use jt_tenancy::WorkspaceId;
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capabilities::ensure_capability;
use super::{map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

#[derive(sqlx::FromRow)]
struct ItemRecord {
    id: Uuid,
    workspace_id: Uuid,
    name: String,
    kind: String,
    unit: serde_json::Value,
    cap: i64,
    unit_cost_minor: Option<i64>,
    period: String,
    strategy_version_id: Option<Uuid>,
    created_at: OffsetDateTime,
    retired_at: Option<OffsetDateTime>,
}

/// The columns an [`ItemRecord`] is read from.
const ITEM_COLUMNS: &str = "id, workspace_id, name, kind, unit, cap, unit_cost_minor, period, strategy_version_id, created_at, retired_at";

impl ItemRecord {
    fn into_item(self) -> Result<BudgetItem, AppError> {
        let unit: Unit = serde_json::from_value(self.unit)
            .map_err(|_| AppError::internal("stored budget item unit cannot be read"))?;
        Ok(BudgetItem {
            unit_cost_minor: self.unit_cost_minor,
            id: BudgetItemId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            name: self.name,
            kind: stored(BudgetKind::parse(&self.kind), "budget_items.kind")?,
            unit,
            cap: self.cap,
            period: stored(Period::parse(&self.period), "budget_items.period")?,
            strategy_version_id: self.strategy_version_id,
            created_at: self.created_at,
            retired_at: self.retired_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct SpendRecord {
    id: Uuid,
    workspace_id: Uuid,
    budget_item_id: Uuid,
    at: OffsetDateTime,
    amount: i64,
    source: serde_json::Value,
    reference: Option<String>,
}

impl SpendRecord {
    fn into_spend(self) -> Result<BudgetSpend, AppError> {
        let source: SpendSource = serde_json::from_value(self.source)
            .map_err(|_| AppError::internal("stored spend source cannot be read"))?;
        Ok(BudgetSpend {
            id: BudgetSpendId(self.id),
            budget_item_id: BudgetItemId(self.budget_item_id),
            workspace_id: WorkspaceId(self.workspace_id),
            at: self.at,
            amount: self.amount,
            source,
            reference: self.reference,
        })
    }
}

/// `NOT_FOUND` unless budget item `id` belongs to workspace `ws`.
async fn ensure_item(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: BudgetItemId,
) -> Result<(), AppError> {
    let found: Option<i32> =
        sqlx::query_scalar("select 1 from budget_items where workspace_id = $1 and id = $2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(conn)
            .await
            .map_err(|e| map_sqlx(e, "find budget item"))?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such budget item"))
}

#[async_trait]
impl BudgetRepo for PgTenantRepos {
    async fn insert_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, item.workspace_id)?;
        let unit = serde_json::to_value(&item.unit)
            .map_err(|e| AppError::internal(format!("a budget unit cannot be stored: {e}")))?;
        let done = sqlx::query(
            "insert into budget_items (id, workspace_id, name, kind, unit, cap, period, \
             strategy_version_id, created_at, retired_at, unit_cost_minor) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict do nothing",
        )
        .bind(item.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(&item.name)
        .bind(item.kind.key())
        .bind(unit)
        .bind(item.cap)
        .bind(item.period.key())
        .bind(item.strategy_version_id)
        .bind(item.created_at)
        .bind(item.retired_at)
        .bind(item.unit_cost_minor)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert budget item"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the budget item id is already taken"));
        }
        Ok(())
    }

    async fn list_items(&mut self) -> Result<Vec<BudgetItem>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<ItemRecord> = sqlx::query_as(&format!(
            "select {ITEM_COLUMNS} from budget_items where workspace_id = $1 \
             order by created_at, id"
        ))
        .bind(ws.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list budget items"))?;
        records.into_iter().map(ItemRecord::into_item).collect()
    }

    async fn find_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        let ws = self.workspace_id();
        let record: Option<ItemRecord> = sqlx::query_as(&format!(
            "select {ITEM_COLUMNS} from budget_items where workspace_id = $1 and id = $2"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find budget item"))?;
        record.map(ItemRecord::into_item).transpose()
    }

    /// `find_item` with `for update`: a second locker waits until this transaction ends, then
    /// reads the row as it was committed.
    async fn lock_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        let ws = self.workspace_id();
        let record: Option<ItemRecord> = sqlx::query_as(&format!(
            "select {ITEM_COLUMNS} from budget_items where workspace_id = $1 and id = $2 \
             for update"
        ))
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock budget item"))?;
        record.map(ItemRecord::into_item).transpose()
    }

    async fn update_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, item.workspace_id)?;
        let done = sqlx::query(
            "update budget_items set name = $3, cap = $4, period = $5, retired_at = $6, unit_cost_minor = $7 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(item.id.as_uuid())
        .bind(&item.name)
        .bind(item.cap)
        .bind(item.period.key())
        .bind(item.retired_at)
        .bind(item.unit_cost_minor)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "change budget item"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such budget item"));
        }
        Ok(())
    }

    async fn unlink_item(&mut self, item: BudgetItemId) -> Result<u64, AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "delete from capability_budget_links where workspace_id = $1 and budget_item_id = $2",
        )
        .bind(ws.as_uuid())
        .bind(item.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "unlink budget item"))?;
        Ok(done.rows_affected())
    }

    async fn link(&mut self, capability: CapabilityId, item: BudgetItemId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        ensure_capability(self.tx.conn(), ws, capability).await?;
        ensure_item(self.tx.conn(), ws, item).await?;
        sqlx::query(
            "insert into capability_budget_links (workspace_id, capability_id, budget_item_id) \
             values ($1, $2, $3) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(capability.as_uuid())
        .bind(item.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "link budget item"))?;
        Ok(())
    }

    async fn unlink(
        &mut self,
        capability: CapabilityId,
        item: BudgetItemId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let done = sqlx::query(
            "delete from capability_budget_links \
             where workspace_id = $1 and capability_id = $2 and budget_item_id = $3",
        )
        .bind(ws.as_uuid())
        .bind(capability.as_uuid())
        .bind(item.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "unlink budget item"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found(
                "the capability is not linked to the budget item",
            ));
        }
        Ok(())
    }

    async fn append_spend(&mut self, spend: BudgetSpend) -> Result<BudgetSpendId, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, spend.workspace_id)?;
        ensure_item(self.tx.conn(), ws, spend.budget_item_id).await?;
        let source = serde_json::to_value(&spend.source)
            .map_err(|e| AppError::internal(format!("a spend source cannot be stored: {e}")))?;
        let done = sqlx::query(
            "insert into budget_spend_entries (id, workspace_id, budget_item_id, at, amount, \
             source, reference) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing",
        )
        .bind(spend.id.as_uuid())
        .bind(ws.as_uuid())
        .bind(spend.budget_item_id.as_uuid())
        .bind(spend.at)
        .bind(spend.amount)
        .bind(source)
        .bind(&spend.reference)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "append budget spend"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict("the spend entry id is already taken"));
        }
        Ok(spend.id)
    }

    /// `sum` of `bigint` is `numeric` in Postgres, so the cap at `i64::MAX` happens before the
    /// cast back.
    async fn spent_between(
        &mut self,
        item: BudgetItemId,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<i64, AppError> {
        let ws = self.workspace_id();
        sqlx::query_scalar(
            "select least(coalesce(sum(amount), 0), 9223372036854775807)::bigint \
             from budget_spend_entries \
             where workspace_id = $1 and budget_item_id = $2 and at >= $3 and at < $4",
        )
        .bind(ws.as_uuid())
        .bind(item.as_uuid())
        .bind(from)
        .bind(to)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "sum budget spend"))
    }

    async fn list_spend(
        &mut self,
        item: BudgetItemId,
        limit: u32,
        before: Option<(OffsetDateTime, BudgetSpendId)>,
    ) -> Result<Vec<BudgetSpend>, AppError> {
        let ws = self.workspace_id();
        let records: Vec<SpendRecord> = sqlx::query_as(
            "select id, workspace_id, budget_item_id, at, amount, source, reference \
             from budget_spend_entries where workspace_id = $1 and budget_item_id = $2 \
             and ($3::timestamptz is null or (at, id) < ($3::timestamptz, $4::uuid)) \
             order by at desc, id desc \
             limit $5",
        )
        .bind(ws.as_uuid())
        .bind(item.as_uuid())
        .bind(before.map(|(at, _)| at))
        .bind(before.map(|(_, id)| id.as_uuid()))
        .bind(i64::from(limit.clamp(1, MAX_SPEND_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list budget spend"))?;
        records.into_iter().map(SpendRecord::into_spend).collect()
    }
}
