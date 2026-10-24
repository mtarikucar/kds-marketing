//! Tenant-transaction Studio storage. The control row serializes request receipts and claims;
//! callers commit the frozen Sending snapshot before doing any provider I/O.
mod control;
mod paid;
mod queue;
mod records;
use crate::{
    repos::{map_sqlx, same_workspace},
    uow::PgTenantRepos,
};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{files::StoredFile, studio::*},
};
use jt_studio::{RetirementReason, SlotEvent, StudioError, StudioPolicy, transition_slot};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use uuid::Uuid;

fn encode<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|_| AppError::internal("invalid Studio record"))
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, AppError> {
    serde_json::from_value(value).map_err(|_| AppError::internal("invalid stored Studio record"))
}
fn invalid(error: StudioError) -> AppError {
    AppError::conflict(error.to_string())
}
fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}
fn key_valid(key: &str) -> Result<(), AppError> {
    if key.trim().is_empty() {
        Err(AppError::validation("request key is required", json!({})))
    } else {
        Ok(())
    }
}
fn revision(value: u64) -> Result<i64, AppError> {
    i64::try_from(value).map_err(|_| AppError::conflict("revision overflow"))
}
impl PgTenantRepos {
    async fn studio_replay<T: DeserializeOwned>(
        &mut self,
        action: &str,
        key: &str,
        payload: &Value,
    ) -> Result<Option<T>, AppError> {
        key_valid(key)?;
        StudioControlRepo::lock_control(self).await?;
        let row:Option<(String,Value)>=sqlx::query_as("select payload_digest,response from studio_request_keys where workspace_id=$1 and action=$2 and key=$3")
            .bind(self.workspace_id().0).bind(action).bind(key).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"read Studio request key"))?;
        match row {
            None => Ok(None),
            Some((hash, response)) if hash == digest(payload) => decode(response).map(Some),
            Some(_) => Err(AppError::conflict("request key payload mismatch")),
        }
    }
    async fn studio_receipt<T: Serialize>(
        &mut self,
        action: &str,
        key: &str,
        payload: &Value,
        response: &T,
    ) -> Result<(), AppError> {
        sqlx::query("insert into studio_request_keys(workspace_id,action,key,payload_digest,response) values($1,$2,$3,$4,$5)")
            .bind(self.workspace_id().0).bind(action).bind(key).bind(digest(payload)).bind(encode(response)?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"store Studio receipt"))?;
        Ok(())
    }
    async fn studio_record<T: DeserializeOwned>(
        &mut self,
        table: &str,
        id: Uuid,
    ) -> Result<Option<T>, AppError> {
        // Table names are private constants, never user input.
        let row: Option<Value> = sqlx::query_scalar(&format!(
            "select data from {table} where workspace_id=$1 and id=$2"
        ))
        .bind(self.workspace_id().0)
        .bind(id)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read Studio record"))?;
        row.map(decode).transpose()
    }
    async fn studio_write_slot(&mut self, slot: &Slot) -> Result<(), AppError> {
        sqlx::query(
            "update studio_slots set data=$3,state=$4,revision=$5 where workspace_id=$1 and id=$2",
        )
        .bind(self.workspace_id().0)
        .bind(slot.id.0)
        .bind(encode(slot)?)
        .bind(encode(&slot.state)?.as_str())
        .bind(revision(slot.revision)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update Studio slot"))?;
        Ok(())
    }
}
#[async_trait]
impl StudioRepo for PgTenantRepos {
    async fn insert_arm(&mut self, arm: Arm) -> Result<Arm, AppError> {
        same_workspace(self.workspace_id(), arm.workspace_id)?;
        arm.validate().map_err(invalid)?;
        StudioControlRepo::lock_control(self).await?;
        let exists:bool=sqlx::query_scalar("select exists(select 1 from strategy_hypotheses where workspace_id=$1 and hypothesis_id=$2)")
            .bind(self.workspace_id().0).bind(arm.key.hypothesis_id.0).fetch_one(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find arm hypothesis"))?;
        if !exists {
            return Err(AppError::not_found("arm hypothesis"));
        }
        let row:Option<Value>=sqlx::query_scalar("select data from studio_arms where workspace_id=$1 and hypothesis_id=$2 and content_type=$3 and channel=$4 and lane=$5")
            .bind(self.workspace_id().0).bind(arm.key.hypothesis_id.0).bind(&arm.key.content_type).bind(&arm.key.channel).bind(encode(&arm.key.lane)?.as_str()).fetch_optional(self.tx.conn()).await.map_err(|e|map_sqlx(e,"find stable arm"))?;
        if let Some(row) = row {
            return decode(row);
        }
        sqlx::query("insert into studio_arms(workspace_id,id,hypothesis_id,content_type,channel,lane,data,born_version_id) values($1,$2,$3,$4,$5,$6,$7,(select version_id from strategy_hypotheses where workspace_id=$1 and hypothesis_id=$3 order by version_id limit 1))")
            .bind(self.workspace_id().0).bind(arm.id.0).bind(arm.key.hypothesis_id.0).bind(&arm.key.content_type).bind(&arm.key.channel).bind(encode(&arm.key.lane)?.as_str()).bind(encode(&arm)?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert Studio arm"))?;
        Ok(arm)
    }
    async fn get_slot(&mut self, id: SlotId) -> Result<Option<Slot>, AppError> {
        self.studio_record("studio_slots", id.0).await
    }
    async fn list_slots(&mut self, q: SlotQuery) -> Result<Vec<Slot>, AppError> {
        let rows:Vec<Value>=sqlx::query_scalar("select s.data from studio_slots s join studio_arms a on a.workspace_id=s.workspace_id and a.id=s.arm_id where s.workspace_id=$1 and s.scheduled_at >= $2 and s.scheduled_at < $3 and ($4::uuid is null or s.hypothesis_id=$4) and ($5::text is null or a.lane=$5) order by s.scheduled_at,s.id")
            .bind(self.workspace_id().0).bind(q.from).bind(q.until).bind(q.hypothesis_id.map(|h|h.0)).bind(q.lane.map(|l|encode(&l)).transpose()?.and_then(|v|v.as_str().map(str::to_owned))).fetch_all(self.tx.conn()).await.map_err(|e|map_sqlx(e,"list Studio slots"))?;
        rows.into_iter().map(decode).collect()
    }
    async fn insert_slots(&mut self, key: &str, slots: Vec<Slot>) -> Result<Vec<Slot>, AppError> {
        let payload = encode(&slots)?;
        if let Some(saved) = self.studio_replay("slots.insert", key, &payload).await? {
            return Ok(saved);
        }
        for (ordinal, slot) in slots.iter().enumerate() {
            same_workspace(self.workspace_id(), slot.chain.workspace_id)?;
            slot.validate().map_err(invalid)?;
            if slot.state != SlotState::Planned || slot.revision != 0 {
                return Err(AppError::conflict(
                    "new slot must be planned at revision zero",
                ));
            }
            sqlx::query("insert into studio_slots(workspace_id,id,data,born_version_id,hypothesis_id,arm_id,capability_id,scheduled_at,state,revision,run_key,ordinal) values($1,$2,$3,$4,$5,$6,$7,$8,'planned',0,$9,$10)")
                .bind(self.workspace_id().0).bind(slot.id.0).bind(encode(slot)?).bind(slot.chain.born_version_id.0).bind(slot.chain.hypothesis_id.0).bind(slot.chain.arm_id.0).bind(slot.capability_id.0).bind(slot.scheduled_at).bind(key).bind(i32::try_from(ordinal).map_err(|_|AppError::conflict("too many slots"))?).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert Studio slot"))?;
        }
        self.studio_receipt("slots.insert", key, &payload, &slots)
            .await?;
        Ok(slots)
    }
    async fn save_piece(
        &mut self,
        id: SlotId,
        expected: u64,
        piece: Piece,
        key: &str,
    ) -> Result<Slot, AppError> {
        let payload = json!([id, expected, piece]);
        if let Some(saved) = self.studio_replay("piece.save", key, &payload).await? {
            return Ok(saved);
        }
        let slot = StudioRepo::get_slot(self, id)
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        let next = transition_slot(
            &slot,
            &SlotEvent::PieceSubmitted {
                piece: piece.clone(),
            },
            &StudioPolicy {
                expected_revision: expected,
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        self.studio_check_files(&piece).await?;
        sqlx::query("insert into studio_pieces(workspace_id,id,data,slot_id,revision,born_version_id,hypothesis_id,arm_id) values($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(self.workspace_id().0).bind(piece.id.0).bind(encode(&piece)?).bind(id.0).bind(revision(piece.revision)?).bind(piece.chain.born_version_id.0).bind(piece.chain.hypothesis_id.0).bind(piece.chain.arm_id.0).execute(self.tx.conn()).await.map_err(|e|map_sqlx(e,"insert Studio piece"))?;
        self.studio_write_slot(&next).await?;
        self.studio_receipt("piece.save", key, &payload, &next)
            .await?;
        Ok(next)
    }
    async fn retire_slot(
        &mut self,
        id: SlotId,
        expected: u64,
        reason: &str,
    ) -> Result<Slot, AppError> {
        StudioControlRepo::lock_control(self).await?;
        let reason: RetirementReason = serde_json::from_value(json!(reason))
            .map_err(|_| AppError::validation("unknown retirement reason", json!({})))?;
        let slot = StudioRepo::get_slot(self, id)
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        let next = transition_slot(
            &slot,
            &SlotEvent::Retire { reason },
            &StudioPolicy {
                expected_revision: expected,
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        self.studio_write_slot(&next).await?;
        Ok(next)
    }
    async fn claim_publication(
        &mut self,
        now: OffsetDateTime,
    ) -> Result<Option<PublishAttempt>, AppError> {
        self.studio_claim(now).await
    }
    async fn finish_publication(
        &mut self,
        id: PublishAttemptId,
        outcome: PublishOutcome,
    ) -> Result<(), AppError> {
        self.studio_finish(id, outcome).await
    }
    async fn save_file(&mut self, file: StoredFile) -> Result<(), AppError> {
        self.studio_save_file(file).await
    }
    async fn get_file(&mut self, id: FileId) -> Result<Option<StoredFile>, AppError> {
        self.studio_record("studio_files", id.0).await
    }
    async fn save_trend(
        &mut self,
        signal: TrendSignal,
        key: &str,
    ) -> Result<TrendSignal, AppError> {
        self.studio_trend(signal, key).await
    }
    async fn bind_adset(
        &mut self,
        binding: AdSetBinding,
        key: &str,
    ) -> Result<AdSetBinding, AppError> {
        self.studio_bind(binding, key).await
    }
    async fn save_budget_move(&mut self, m: BudgetMove, key: &str) -> Result<BudgetMove, AppError> {
        self.studio_move(m, key).await
    }
    async fn record_measurement(&mut self, m: Measurement) -> Result<bool, AppError> {
        self.studio_measure(m).await
    }
    async fn apply_learning(&mut self, u: LearningUpdate) -> Result<bool, AppError> {
        self.studio_learn(u).await
    }
}
