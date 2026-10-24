use super::*;
use jt_app::ports::{LedgerRepo, StrategyRepo};
use jt_ledger::{Action, Actor, LedgerEntry, Subject};
use jt_strategy::LaneKind;
impl PgTenantRepos {
    pub(super) async fn studio_claim(
        &mut self,
        now: OffsetDateTime,
        target: Option<SlotId>,
    ) -> Result<Option<PublishAttempt>, AppError> {
        let Some(version) = StrategyRepo::lock_execution_frame(self).await? else {
            return Ok(None);
        };
        let control = StudioControlRepo::lock_control(self).await?;
        if control.is_braked(LaneKind::Organic) {
            return Ok(None);
        }
        let row:Option<Value>=sqlx::query_scalar("select s.data from studio_slots s join studio_arms a on a.workspace_id=s.workspace_id and a.id=s.arm_id where s.workspace_id=$1 and s.state='ready' and s.scheduled_at <= $2 and ($3::uuid is null or s.id=$3) and a.lane='organic' and not exists(select 1 from studio_publish_attempts p where p.workspace_id=s.workspace_id and p.slot_id=s.id) order by s.scheduled_at,s.id for update of s skip locked limit 1")
            .bind(self.workspace_id().0).bind(now).bind(target.map(|id|id.0)).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"claim due Studio slot"))?;
        let Some(row) = row else { return Ok(None) };
        let slot: Slot = decode(row)?;
        let piece: Value = sqlx::query_scalar(
            "select data from studio_pieces where workspace_id=$1 and slot_id=$2 and revision=$3",
        )
        .bind(self.workspace_id().0)
        .bind(slot.id.0)
        .bind(revision(slot.revision)?)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read dispatch piece"))?;
        let account = jt_app::ports::CapabilityRepo::find(self, slot.capability_id)
            .await?
            .and_then(|c| c.external_id);
        let attempt = PublishAttempt::claim(
            PublishAttemptId::new_v7(),
            &slot,
            &decode(piece)?,
            version.id,
            control.revision,
            Actor::System {
                component: "studio.publisher".into(),
            },
            now,
        )
        .map_err(invalid)?
        .with_account(account);
        sqlx::query("insert into studio_publish_attempts(workspace_id,id,data,slot_id,piece_id,executed_version_id,state) values($1,$2,$3,$4,$5,$6,'sending')")
            .bind(self.workspace_id().0).bind(attempt.id().0).bind(encode(&attempt)?).bind(slot.id.0).bind(attempt.piece().id.0).bind(version.id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"persist Studio Sending claim"))?;
        self.studio_attempt_ledger(&attempt, "studio.publish.claimed", now)
            .await?;
        Ok(Some(attempt))
    }
    pub(super) async fn studio_finish(
        &mut self,
        id: PublishAttemptId,
        outcome: PublishOutcome,
        observed_at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let current = StrategyRepo::lock_execution_frame(self).await?;
        let control = StudioControlRepo::lock_control(self).await?;
        let old: PublishAttempt = self
            .studio_record("studio_publish_attempts", id.0)
            .await?
            .ok_or_else(|| AppError::not_found("publish attempt"))?;
        let outcome = outcome.into_redacted();
        let next = old.finish_at(&outcome, observed_at).map_err(invalid)?;
        if old == next {
            return Ok(());
        }
        let mut slot = StudioRepo::get_slot(self, old.slot_id())
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        if next.state() == PublishState::Succeeded {
            let p = next
                .publication(PublicationId::new_v7(), observed_at)
                .map_err(invalid)?;
            p.validate_for_slot(&slot).map_err(invalid)?;
            sqlx::query("insert into studio_publications(workspace_id,id,data,slot_id,attempt_id,piece_id,capability_id,external_id,executed_version_id,born_version_id,hypothesis_id,arm_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)")
                .bind(self.workspace_id().0).bind(p.id.0).bind(encode(&p)?).bind(p.slot_id.0).bind(id.0).bind(p.piece_id.0).bind(p.capability_id.0).bind(&p.external_id).bind(p.executed_version_id.0).bind(p.chain.born_version_id.0).bind(p.chain.hypothesis_id.0).bind(p.chain.arm_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"store publication evidence"))?;
            if slot.state == SlotState::Retired
                || control.is_braked(LaneKind::Organic)
                || current
                    .as_ref()
                    .is_none_or(|v| v.id != next.executed_version_id())
            {
                self.studio_attempt_ledger(&next, "studio.publish.late_completion", observed_at)
                    .await?;
            }
            if slot.state != SlotState::Retired {
                slot.state = SlotState::Published;
                slot.revision = slot
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| AppError::conflict("revision overflow"))?;
                self.studio_write_slot(&slot).await?;
            }
        }
        sqlx::query(
            "update studio_publish_attempts set data=$3,state=$4 where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(id.0)
        .bind(encode(&next)?)
        .bind(encode(&next.state())?.as_str())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "finish Studio claim"))?;
        self.studio_attempt_ledger(&next, "studio.publish.finished", observed_at)
            .await?;
        Ok(())
    }
    async fn studio_attempt_ledger(
        &mut self,
        a: &PublishAttempt,
        action: &str,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let mut entry = LedgerEntry::new(
            self.workspace_id(),
            a.actor().clone(),
            Action::new(action).map_err(|_| AppError::internal("invalid action"))?,
            json!({"attempt_id":a.id(),"slot_id":a.slot_id(),"born_version_id":a.piece().chain.born_version_id,"executed_version_id":a.executed_version_id(),"hypothesis_id":a.piece().chain.hypothesis_id,"arm_id":a.piece().chain.arm_id,"piece_id":a.piece().id,"state":a.state()}),
            at,
        );
        entry.subject = Some(Subject {
            kind: "studio_slot".into(),
            id: a.slot_id().to_string(),
        });
        entry.strategy_version_id = Some(a.executed_version_id().0);
        LedgerRepo::append(self, entry).await?;
        Ok(())
    }
}
