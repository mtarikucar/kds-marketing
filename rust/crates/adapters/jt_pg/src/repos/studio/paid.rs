use super::*;
use jt_app::ports::StrategyRepo;
#[async_trait]
impl StudioBudgetRepo for PgTenantRepos {
    async fn list_reservations(
        &mut self,
    ) -> Result<Vec<(SpendReservation, Option<SpendOutcome>)>, AppError> {
        let rows: Vec<(Value, Option<Value>)> = sqlx::query_as("select data,outcome from studio_spend_reservations where workspace_id=$1 order by at,id")
            .bind(self.workspace_id().0).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"list reservations"))?;
        rows.into_iter()
            .map(|(r, o)| Ok((decode(r)?, o.map(decode).transpose()?)))
            .collect()
    }

    async fn find_reservation(&mut self, key: &str) -> Result<Option<SpendReservation>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from studio_spend_reservations where workspace_id=$1 and evidence_key=$2",
        )
        .bind(self.workspace_id().0)
        .bind(key)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find reservation"))?;
        row.map(decode).transpose()
    }
    async fn reserve(&mut self, mut r: ReserveSpend) -> Result<SpendReservation, AppError> {
        same_workspace(self.workspace_id(), r.workspace_id)?;
        if r.amount_minor < 0
            || r.budget_item_ids.is_empty()
            || jt_strategy::validate_currency(&r.currency).is_err()
        {
            return Err(AppError::validation(
                "known cost, currency and budget items required",
                json!({}),
            ));
        }
        r.budget_item_ids.sort();
        r.budget_item_ids.dedup();
        let frame = StrategyRepo::lock_execution_frame(self).await?;
        let payload = encode(&r)?;
        if let Some(saved) = self
            .studio_replay("spend.reserve", &r.evidence_key, &payload)
            .await?
        {
            return Ok(saved);
        }
        let _ = frame;
        let reservation = jt_app::usecases::studio::budget::validate_reservation(self, &r).await?;
        sqlx::query("insert into studio_spend_reservations(workspace_id,id,data,capability_id,executed_version_id,evidence_key,at,amount_minor) values($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(self.workspace_id().0).bind(reservation.id.0).bind(encode(&reservation)?).bind(r.capability_id.0).bind(r.executed_version_id.0).bind(&r.evidence_key).bind(r.at).bind(r.amount_minor).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"reserve Studio spend"))?;
        self.studio_receipt("spend.reserve", &r.evidence_key, &payload, &reservation)
            .await?;
        Ok(reservation)
    }
    async fn settle(&mut self, id: ReservationId, outcome: SpendOutcome) -> Result<(), AppError> {
        StudioControlRepo::lock_control(self).await?;
        if let SpendOutcome::Settled {
            actual_minor,
            evidence_key,
        } = &outcome
            && (*actual_minor < 0 || evidence_key.trim().is_empty())
        {
            return Err(AppError::validation("invalid settlement", json!({})));
        }
        let old:Option<Option<Value>>=sqlx::query_scalar("select outcome from studio_spend_reservations where workspace_id=$1 and id=$2 for update").bind(self.workspace_id().0).bind(id.0).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"lock spend reservation"))?;
        let old = old.ok_or_else(|| AppError::not_found("reservation"))?;
        if let Some(old) = old {
            let old: SpendOutcome = decode(old)?;
            if old == outcome {
                return Ok(());
            }
            if old != SpendOutcome::Unknown {
                return Err(AppError::conflict("reservation already settled"));
            }
        }
        sqlx::query(
            "update studio_spend_reservations set outcome=$3 where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .bind(encode(&outcome)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "settle spend reservation"))?;
        Ok(())
    }
}
