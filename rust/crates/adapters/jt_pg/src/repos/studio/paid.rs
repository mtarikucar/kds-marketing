use super::*;
use jt_app::ports::{BudgetRepo, CapabilityRepo, StrategyRepo};
use jt_capability::{Unit, period_window};
#[async_trait]
impl StudioBudgetRepo for PgTenantRepos {
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
        let frame = StrategyRepo::lock_execution_frame(self)
            .await?
            .ok_or_else(AppError::strategy_required)?;
        let payload = encode(&r)?;
        if let Some(saved) = self
            .studio_replay("spend.reserve", &r.evidence_key, &payload)
            .await?
        {
            return Ok(saved);
        }
        if frame.id != r.executed_version_id {
            return Err(AppError::conflict("strategy changed"));
        }
        let control = StudioControlRepo::lock_control(self).await?;
        if control.is_braked(r.lane) {
            return Err(AppError::conflict("lane is braked"));
        }
        let cap = CapabilityRepo::find(self, r.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        if cap
            .budget_item_ids
            .iter()
            .any(|id| !r.budget_item_ids.contains(id))
        {
            return Err(AppError::conflict(
                "reservation must include every linked budget cap",
            ));
        }
        let lane = frame
            .sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == r.lane && l.currency == r.currency)
            .ok_or_else(|| AppError::conflict("strategy lane has no matching currency cap"))?;
        let period = match lane.period {
            jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
            jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
        };
        let (from, until) = period_window(period, r.at);
        let held = self
            .studio_reserved(from, until, None, Some(r.lane), &r.currency)
            .await?;
        check_cap(held, r.amount_minor, lane.cap_minor)?;
        for id in &r.budget_item_ids {
            let item = BudgetRepo::lock_item(self, *id)
                .await?
                .ok_or_else(|| AppError::not_found("budget item"))?;
            if item.retired_at.is_some() || item.unit != Unit::Currency(r.currency.clone()) {
                return Err(AppError::conflict(
                    "budget item is retired or currency differs",
                ));
            }
            let (from, until) = period_window(item.period, r.at);
            let spent = BudgetRepo::spent_between(self, *id, from, until).await?;
            let held = self
                .studio_reserved(from, until, Some(id.0), None, &r.currency)
                .await?;
            check_cap(i128::from(spent) + held, r.amount_minor, item.cap)?;
        }
        let reservation = SpendReservation {
            id: ReservationId::new_v7(),
            request: r.clone(),
        };
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
impl PgTenantRepos {
    async fn studio_reserved(
        &mut self,
        from: OffsetDateTime,
        until: OffsetDateTime,
        item: Option<Uuid>,
        lane: Option<jt_strategy::LaneKind>,
        currency: &str,
    ) -> Result<i128, AppError> {
        let rows:Vec<(Value,Option<Value>)>=sqlx::query_as("select data,outcome from studio_spend_reservations where workspace_id=$1 and at >= $2 and at < $3")
            .bind(self.workspace_id().0).bind(from).bind(until).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"sum Studio reservations"))?;
        let mut total = 0i128;
        for (data, outcome) in rows {
            let r: SpendReservation = decode(data)?;
            if r.request.currency != currency
                || item.is_some_and(|id| !r.request.budget_item_ids.iter().any(|i| i.0 == id))
                || lane.is_some_and(|l| r.request.lane != l)
            {
                continue;
            }
            let amount = match outcome.map(decode).transpose()? {
                Some(SpendOutcome::Refused) => 0,
                Some(SpendOutcome::Settled { actual_minor, .. }) => actual_minor,
                _ => r.request.amount_minor,
            };
            total += i128::from(amount);
        }
        Ok(total)
    }
}
fn check_cap(used: i128, amount: i64, cap: i64) -> Result<(), AppError> {
    if used + i128::from(amount) > i128::from(cap) {
        Err(AppError::budget_cap(
            json!({"cap_minor":cap,"requested_minor":amount}),
        ))
    } else {
        Ok(())
    }
}
