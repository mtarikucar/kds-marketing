//! Billing SQL shared by tenant and explicit-workspace platform bundles.
use super::{map_sqlx, same_workspace, stored, workspaces};
use crate::tx::PlatformTx;
use crate::uow::PgTenantRepos;
use async_trait::async_trait;
use jt_app::{error::AppError, ports::billing::*};
use jt_tenancy::{OperatorId, UserId, WorkspaceId};
use sqlx::PgConnection;
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct PaymentRecord {
    id: Uuid,
    workspace_id: Uuid,
    reported_by: Uuid,
    reference_sealed: Vec<u8>,
    request_key: String,
    amount_minor: i64,
    currency: String,
    paid_at: OffsetDateTime,
    reported_at: OffsetDateTime,
}
impl PaymentRecord {
    fn into_row(self) -> Result<PaymentNotification, AppError> {
        Ok(PaymentNotification {
            id: PaymentId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            reported_by: UserId(self.reported_by),
            reference_sealed: self.reference_sealed,
            request_key: self.request_key,
            amount_minor: self.amount_minor,
            currency: self.currency,
            paid_at: self.paid_at,
            reported_at: self.reported_at,
        })
    }
}

#[derive(sqlx::FromRow)]
struct EntitlementRecord {
    id: Uuid,
    workspace_id: Uuid,
    source: String,
    payment_id: Option<Uuid>,
    confirmed_by: Option<Uuid>,
    confirmed_at: OffsetDateTime,
    activated_at: Option<OffsetDateTime>,
    redeemed_by: Option<Uuid>,
    revoked_at: Option<OffsetDateTime>,
    reason: Option<String>,
}
impl EntitlementRecord {
    fn into_row(self) -> Result<WorkspaceEntitlement, AppError> {
        Ok(WorkspaceEntitlement {
            id: EntitlementId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            source: stored(EntitlementSource::parse(&self.source), "entitlement source")?,
            payment_id: self.payment_id.map(PaymentId),
            confirmed_by: self.confirmed_by.map(OperatorId),
            confirmed_at: self.confirmed_at,
            activated_at: self.activated_at,
            redeemed_by: self.redeemed_by.map(UserId),
            revoked_at: self.revoked_at,
            reason: self.reason,
        })
    }
}

#[derive(sqlx::FromRow)]
struct CodeRecord {
    id: Uuid,
    workspace_id: Uuid,
    entitlement_id: Uuid,
    action: String,
    digest: Vec<u8>,
    issued_by: Uuid,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
    attempts: i32,
    invalidated_at: Option<OffsetDateTime>,
    consumed_at: Option<OffsetDateTime>,
    redeemed_by: Option<Uuid>,
}
impl CodeRecord {
    fn into_row(self) -> Result<ActivationCodeRow, AppError> {
        Ok(ActivationCodeRow {
            id: ActivationCodeId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            entitlement_id: EntitlementId(self.entitlement_id),
            action: self.action,
            digest: self.digest,
            issued_by: OperatorId(self.issued_by),
            created_at: self.created_at,
            expires_at: self.expires_at,
            attempts: self.attempts,
            invalidated_at: self.invalidated_at,
            consumed_at: self.consumed_at,
            redeemed_by: self.redeemed_by.map(UserId),
        })
    }
}
pub(crate) async fn payment_get(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: PaymentId,
) -> Result<Option<PaymentNotification>, AppError> {
    let rows = sqlx::query_as::<_, PaymentRecord>(
        "select * from payment_notifications where workspace_id=$1 and id=$2",
    )
    .bind(ws.as_uuid())
    .bind(id.as_uuid())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "payment_get"))?;
    rows.map(PaymentRecord::into_row).transpose()
}
pub(crate) async fn payment_request(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    key: &str,
) -> Result<Option<PaymentNotification>, AppError> {
    let rows = sqlx::query_as::<_, PaymentRecord>(
        "select * from payment_notifications where workspace_id=$1 and request_key=$2",
    )
    .bind(ws.as_uuid())
    .bind(key)
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "payment_request"))?;
    rows.map(PaymentRecord::into_row).transpose()
}
pub(crate) async fn payments_list(
    tx: &mut PlatformTx<'_>,
) -> Result<Vec<PaymentNotification>, AppError> {
    let rows = sqlx::query_as::<_, PaymentRecord>(
        // archtest: platform-wide
        "select * from payment_notifications order by reported_at,id",
    )
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "payments_list"))?;
    rows.into_iter().map(PaymentRecord::into_row).collect()
}
pub(crate) async fn payment_entitlements_latest(
    tx: &mut PlatformTx<'_>,
) -> Result<Vec<WorkspaceEntitlement>, AppError> {
    let rows = sqlx::query_as::<_, EntitlementRecord>(
        // archtest: platform-wide
        "select distinct on (workspace_id, payment_id) * from workspace_entitlements \
         where payment_id is not null \
         order by workspace_id, payment_id, confirmed_at desc, id desc",
    )
    .fetch_all(tx.conn())
    .await
    .map_err(|e| map_sqlx(e, "payment_entitlements_latest"))?;
    rows.into_iter().map(EntitlementRecord::into_row).collect()
}
pub(crate) async fn entitlement_get(
    conn: &mut PgConnection,
    ws: WorkspaceId,
) -> Result<Option<WorkspaceEntitlement>, AppError> {
    let rows = sqlx::query_as::<_, EntitlementRecord>(
        "select * from workspace_entitlements where workspace_id=$1 and revoked_at is null",
    )
    .bind(ws.as_uuid())
    .fetch_optional(conn)
    .await
    .map_err(|e| map_sqlx(e, "entitlement_get"))?;
    rows.map(EntitlementRecord::into_row).transpose()
}
pub(crate) async fn code_current(
    conn: &mut PgConnection,
    ws: WorkspaceId,
) -> Result<Option<ActivationCodeRow>, AppError> {
    workspaces::lock(conn, ws).await?;
    let rows = sqlx::query_as::<_,CodeRecord>(
"select * from activation_codes where workspace_id=$1 and invalidated_at is null order by created_at desc,id desc limit 1 for update").bind(ws.as_uuid()).fetch_optional(conn).await.map_err(|e|map_sqlx(e,"code_current"))?;
    rows.map(CodeRecord::into_row).transpose()
}
pub(crate) async fn payment_insert(
    conn: &mut PgConnection,
    row: PaymentNotification,
) -> Result<(), AppError> {
    workspaces::lock(conn, row.workspace_id).await?;
    let n=sqlx::query("insert into payment_notifications (id,workspace_id,reported_by,reference_sealed,request_key,amount_minor,currency,paid_at,reported_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing")
.bind(row.id.as_uuid()).bind(row.workspace_id.as_uuid()).bind(row.reported_by.as_uuid()).bind(row.reference_sealed).bind(row.request_key).bind(row.amount_minor).bind(row.currency).bind(row.paid_at).bind(row.reported_at).execute(conn).await.map_err(|e|map_sqlx(e,"payment_insert"))?.rows_affected();
    if n == 0 {
        return Err(AppError::conflict("billing row already exists"));
    }
    Ok(())
}
pub(crate) async fn entitlement_insert(
    conn: &mut PgConnection,
    row: WorkspaceEntitlement,
) -> Result<(), AppError> {
    workspaces::lock(conn, row.workspace_id).await?;
    let n=sqlx::query("insert into workspace_entitlements (id,workspace_id,source,payment_id,confirmed_by,confirmed_at,activated_at,redeemed_by,revoked_at,reason) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing")
.bind(row.id.as_uuid()).bind(row.workspace_id.as_uuid()).bind(row.source.key()).bind(row.payment_id.map(|id|id.as_uuid())).bind(row.confirmed_by.map(|id|id.as_uuid())).bind(row.confirmed_at).bind(row.activated_at).bind(row.redeemed_by.map(|id|id.as_uuid())).bind(row.revoked_at).bind(row.reason).execute(conn).await.map_err(|e|map_sqlx(e,"entitlement_insert"))?.rows_affected();
    if n == 0 {
        return Err(AppError::conflict("billing row already exists"));
    }
    Ok(())
}
pub(crate) async fn code_insert(
    conn: &mut PgConnection,
    row: ActivationCodeRow,
) -> Result<(), AppError> {
    workspaces::lock(conn, row.workspace_id).await?;
    let open:bool=sqlx::query_scalar("select exists(select 1 from workspace_entitlements where workspace_id=$1 and id=$2 and revoked_at is null and activated_at is null)").bind(row.workspace_id.as_uuid()).bind(row.entitlement_id.as_uuid()).fetch_one(&mut *conn).await.map_err(|e|map_sqlx(e,"check grant"))?;
    if !open {
        return Err(AppError::conflict(
            "activation requires an unactivated open grant",
        ));
    }
    let n=sqlx::query("insert into activation_codes (id,workspace_id,entitlement_id,action,digest,issued_by,created_at,expires_at,attempts,invalidated_at,consumed_at,redeemed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing")
.bind(row.id.as_uuid()).bind(row.workspace_id.as_uuid()).bind(row.entitlement_id.as_uuid()).bind(row.action).bind(row.digest).bind(row.issued_by.as_uuid()).bind(row.created_at).bind(row.expires_at).bind(row.attempts).bind(row.invalidated_at).bind(row.consumed_at).bind(row.redeemed_by.map(|id|id.as_uuid())).execute(conn).await.map_err(|e|map_sqlx(e,"code_insert"))?.rows_affected();
    if n == 0 {
        return Err(AppError::conflict("billing row already exists"));
    }
    Ok(())
}
pub(crate) async fn entitlement_revoke(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: EntitlementId,
    at: OffsetDateTime,
    reason: &str,
) -> Result<(), AppError> {
    workspaces::lock(conn, ws).await?;
    if reason.trim().is_empty() {
        return Err(AppError::validation(
            "reason is required",
            serde_json::json!({"field":"reason"}),
        ));
    }
    let n=sqlx::query("update workspace_entitlements set revoked_at=$3,reason=$4 where workspace_id=$1 and id=$2 and revoked_at is null")
        .bind(ws.as_uuid()).bind(id.as_uuid()).bind(at).bind(reason).execute(conn).await.map_err(|e|map_sqlx(e,"revoke grant"))?.rows_affected();
    changed(n)
}
pub(crate) async fn activate(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: EntitlementId,
    at: OffsetDateTime,
    by: UserId,
) -> Result<(), AppError> {
    workspaces::lock(conn, ws).await?;
    let n=sqlx::query("update workspace_entitlements set activated_at=$3,redeemed_by=$4 where workspace_id=$1 and id=$2 and revoked_at is null and activated_at is null")
        .bind(ws.as_uuid()).bind(id.as_uuid()).bind(at).bind(by.as_uuid()).execute(conn).await.map_err(|e|map_sqlx(e,"activate grant"))?.rows_affected();
    changed(n)
}
pub(crate) async fn code_fail(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: ActivationCodeId,
) -> Result<(), AppError> {
    workspaces::lock(conn, ws).await?;
    let n=sqlx::query("update activation_codes set attempts=least(attempts+1,5) where workspace_id=$1 and id=$2 and invalidated_at is null and consumed_at is null")
        .bind(ws.as_uuid()).bind(id.as_uuid()).execute(conn).await.map_err(|e|map_sqlx(e,"record failed attempt"))?.rows_affected();
    changed(n)
}
pub(crate) async fn code_invalidate(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    at: OffsetDateTime,
) -> Result<(), AppError> {
    workspaces::lock(conn, ws).await?;
    sqlx::query("update activation_codes set invalidated_at=$2 where workspace_id=$1 and invalidated_at is null")
        .bind(ws.as_uuid()).bind(at).execute(conn).await.map_err(|e|map_sqlx(e,"invalidate challenges"))?;
    Ok(())
}
pub(crate) async fn code_consume(
    conn: &mut PgConnection,
    ws: WorkspaceId,
    id: ActivationCodeId,
    at: OffsetDateTime,
    by: UserId,
) -> Result<(), AppError> {
    workspaces::lock(conn, ws).await?;
    let n=sqlx::query("update activation_codes c set consumed_at=$3,redeemed_by=$4 where c.workspace_id=$1 and c.id=$2 and c.invalidated_at is null and c.consumed_at is null and c.attempts<5 and c.expires_at>$3 and c.created_at<=$3 and exists(select 1 from workspace_entitlements e where e.workspace_id=c.workspace_id and e.id=c.entitlement_id and e.revoked_at is null and e.activated_at is null)")
        .bind(ws.as_uuid()).bind(id.as_uuid()).bind(at).bind(by.as_uuid()).execute(conn).await.map_err(|e|map_sqlx(e,"consume challenge"))?.rows_affected();
    changed(n)
}
fn changed(n: u64) -> Result<(), AppError> {
    if n == 0 {
        Err(AppError::conflict("billing row is not open"))
    } else {
        Ok(())
    }
}
#[async_trait]
impl BillingRepo for PgTenantRepos {
    async fn get_payment(
        &mut self,
        id: PaymentId,
    ) -> Result<Option<PaymentNotification>, AppError> {
        let ws = self.workspace_id();
        payment_get(self.tx.conn(), ws, id).await
    }
    async fn find_request(&mut self, key: &str) -> Result<Option<PaymentNotification>, AppError> {
        let ws = self.workspace_id();
        payment_request(self.tx.conn(), ws, key).await
    }
    async fn insert_payment(&mut self, row: PaymentNotification) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), row.workspace_id)?;
        payment_insert(self.tx.conn(), row).await
    }
    async fn reference_get_or_create(&mut self) -> Result<String, AppError> {
        let ws = self.workspace_id();
        workspaces::lock(self.tx.conn(), ws).await?;
        if let Some(r) =
            sqlx::query_scalar("select reference from workspace_billing where workspace_id=$1")
                .bind(ws.as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read billing reference"))?
        {
            return Ok(r);
        }
        loop {
            let r = format!(
                "JEETA-{}-{:06}",
                &ws.as_uuid().simple().to_string()[..8].to_uppercase(),
                rand::random_range(0..1_000_000u32)
            );
            let n=sqlx::query("insert into workspace_billing(workspace_id,reference) values($1,$2) on conflict do nothing").bind(ws.as_uuid()).bind(&r).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"create billing reference"))?.rows_affected();
            if n == 1 {
                return Ok(r);
            }
        }
    }
    async fn entitlement(&mut self) -> Result<Option<WorkspaceEntitlement>, AppError> {
        let ws = self.workspace_id();
        entitlement_get(self.tx.conn(), ws).await
    }
    async fn latest_entitlement(&mut self) -> Result<Option<WorkspaceEntitlement>, AppError> {
        let ws = self.workspace_id();
        sqlx::query_as::<_, EntitlementRecord>("select * from workspace_entitlements where workspace_id=$1 order by confirmed_at desc,id desc limit 1")
            .bind(ws.as_uuid()).fetch_optional(self.tx.conn()).await.map_err(|e| map_sqlx(e,"latest entitlement"))?.map(EntitlementRecord::into_row).transpose()
    }
    async fn latest_payment(&mut self) -> Result<Option<PaymentNotification>, AppError> {
        let ws = self.workspace_id();
        sqlx::query_as::<_, PaymentRecord>("select * from payment_notifications where workspace_id=$1 order by reported_at desc,id desc limit 1")
            .bind(ws.as_uuid()).fetch_optional(self.tx.conn()).await.map_err(|e| map_sqlx(e,"latest payment"))?.map(PaymentRecord::into_row).transpose()
    }
    async fn payment_confirmed(&mut self, id: PaymentId) -> Result<bool, AppError> {
        let ws = self.workspace_id();
        payment_get(self.tx.conn(), ws, id)
            .await?
            .ok_or_else(|| AppError::not_found("payment"))?;
        sqlx::query_scalar("select exists(select 1 from workspace_entitlements where workspace_id=$1 and payment_id=$2 and source='paid')")
            .bind(ws.as_uuid()).bind(id.as_uuid()).fetch_one(self.tx.conn()).await.map_err(|e| map_sqlx(e,"payment confirmed"))
    }
    async fn activate_entitlement(
        &mut self,
        id: EntitlementId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        activate(self.tx.conn(), ws, id, at, by).await
    }
}
#[async_trait]
impl ActivationCodeRepo for PgTenantRepos {
    async fn insert(&mut self, row: ActivationCodeRow) -> Result<(), AppError> {
        same_workspace(self.workspace_id(), row.workspace_id)?;
        code_insert(self.tx.conn(), row).await
    }
    async fn lock_current_by_workspace(&mut self) -> Result<Option<ActivationCodeRow>, AppError> {
        let ws = self.workspace_id();
        code_current(self.tx.conn(), ws).await
    }
    async fn record_failed_attempt(&mut self, id: ActivationCodeId) -> Result<(), AppError> {
        let ws = self.workspace_id();
        code_fail(self.tx.conn(), ws, id).await
    }
    async fn invalidate_current(&mut self, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        code_invalidate(self.tx.conn(), ws, at).await
    }
    async fn consume(
        &mut self,
        id: ActivationCodeId,
        at: OffsetDateTime,
        by: UserId,
    ) -> Result<(), AppError> {
        let ws = self.workspace_id();
        code_consume(self.tx.conn(), ws, id, at, by).await
    }
}
