//! `call_sessions`, `call_turns` and the `calls` column of `workspace_policies` (migration
//! `0015_voice_calls`). A session is stored whole in `data` (the domain's encoding) beside the
//! columns its reads filter on, which every write keeps in step. A turn keeps its text in its own
//! column (the person-erasure flow empties it) and its kind and measurements in `data`.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::calls::{
    CallFilter, CallId, CallPolicy, CallRepo, CallSession, MAX_CALL_PAGE, Speaker, Turn, TurnKind,
};
use jt_capability::CapabilityId;
use jt_inbox::PersonId;
use serde_json::{Value, json};
use time::OffsetDateTime;

use super::{map_sqlx, same_workspace};
use crate::uow::PgTenantRepos;

/// The longest turn text the table keeps.
const MAX_TURN_TEXT: usize = 2000;

fn encode<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|_| AppError::internal("cannot encode a call record"))
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, AppError> {
    serde_json::from_value(value).map_err(|_| AppError::internal("invalid stored call record"))
}

/// The stored name of an enum the domain serialises as a string.
fn key<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    encode(value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::internal("a call field is not a name"))
}

fn speaker(kind: &TurnKind) -> &'static str {
    match kind {
        TurnKind::Utterance | TurnKind::Dtmf => "counterpart",
        TurnKind::Say { by: Speaker::Agent } => "agent",
        TurnKind::Say {
            by: Speaker::Script,
        }
        | TurnKind::Holding
        | TurnKind::Fallback => "script",
        TurnKind::Event { .. } => "",
    }
}

#[async_trait]
impl CallRepo for PgTenantRepos {
    async fn insert(&mut self, session: CallSession, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, session.workspace_id)?;
        let done = sqlx::query(
            "insert into call_sessions (workspace_id, id, capability_id, person_id, journey_id, \
             direction, purpose, mode, state, counterpart_e164, bridge_call_id, pbx_unique_id, \
             crm_id, agent_connection_id, started_at, ended_at, end_cause, outcome, data, \
             created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, \
             $13, $14, $15, $16, $17, $18, $19, $20, $20) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(session.id.as_uuid())
        .bind(session.capability_id.as_uuid())
        .bind(session.person_id.map(|p| p.as_uuid()))
        .bind(session.journey_id.map(|j| j.as_uuid()))
        .bind(key(&session.direction)?)
        .bind(key(&session.purpose)?)
        .bind(session.mode.key())
        .bind(session.state.key())
        .bind(&session.counterpart_e164)
        .bind(&session.bridge_call_id)
        .bind(&session.pbx_unique_id)
        .bind(&session.crm_id)
        .bind(session.agent_connection_id.map(|c| c.as_uuid()))
        .bind(session.started_at)
        .bind(session.ended_at)
        .bind(session.end_cause.as_ref().map(|c| c.key()))
        .bind(session.outcome.map(|o| o.key()))
        .bind(encode(&session)?)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert call session"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::conflict(
                "the call id or its provider id is already taken",
            ));
        }
        Ok(())
    }

    async fn get(&mut self, id: CallId) -> Result<Option<CallSession>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from call_sessions where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read call session"))?;
        row.map(decode).transpose()
    }

    async fn lock(&mut self, id: CallId) -> Result<Option<CallSession>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from call_sessions where workspace_id = $1 and id = $2 for update",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock call session"))?;
        row.map(decode).transpose()
    }

    async fn lock_by_crm_id(&mut self, crm_id: &str) -> Result<Option<CallSession>, AppError> {
        let row: Option<Value> = sqlx::query_scalar(
            "select data from call_sessions where workspace_id = $1 and crm_id = $2 for update",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(crm_id)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock call session by crm id"))?;
        row.map(decode).transpose()
    }

    async fn update(&mut self, session: CallSession, at: OffsetDateTime) -> Result<(), AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, session.workspace_id)?;
        let done = sqlx::query(
            "update call_sessions set person_id = $3, journey_id = $4, state = $5, \
             counterpart_e164 = $6, bridge_call_id = $7, pbx_unique_id = $8, crm_id = $9, \
             ended_at = $10, end_cause = $11, outcome = $12, data = $13, updated_at = $14 \
             where workspace_id = $1 and id = $2",
        )
        .bind(ws.as_uuid())
        .bind(session.id.as_uuid())
        .bind(session.person_id.map(|p| p.as_uuid()))
        .bind(session.journey_id.map(|j| j.as_uuid()))
        .bind(session.state.key())
        .bind(&session.counterpart_e164)
        .bind(&session.bridge_call_id)
        .bind(&session.pbx_unique_id)
        .bind(&session.crm_id)
        .bind(session.ended_at)
        .bind(session.end_cause.as_ref().map(|c| c.key()))
        .bind(session.outcome.map(|o| o.key()))
        .bind(encode(&session)?)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update call session"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such call"));
        }
        Ok(())
    }

    async fn list(&mut self, filter: CallFilter) -> Result<Vec<CallSession>, AppError> {
        let state = filter.state.map(|s| s.key());
        let direction = filter.direction.map(|d| key(&d)).transpose()?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select data from call_sessions where workspace_id = $1 \
             and ($2::uuid is null or person_id = $2) and ($3::text is null or state = $3) \
             and ($4::text is null or direction = $4) \
             and ($5::timestamptz is null or started_at >= $5) \
             and ($6::timestamptz is null or (started_at, id) < ($6, $7)) \
             order by started_at desc, id desc limit $8",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(filter.person_id.map(|p| p.as_uuid()))
        .bind(state)
        .bind(direction)
        .bind(filter.since)
        .bind(filter.before.map(|(at, _)| at))
        .bind(filter.before.map(|(_, id)| id.as_uuid()))
        .bind(i64::from(filter.limit.clamp(1, MAX_CALL_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list call sessions"))?;
        rows.into_iter().map(decode).collect()
    }

    async fn count_started(
        &mut self,
        capability: CapabilityId,
        from: OffsetDateTime,
        to: OffsetDateTime,
        except: Option<CallId>,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from call_sessions where workspace_id = $1 and capability_id = $2 \
             and direction = 'outbound' and started_at >= $3 and started_at < $4 \
             and end_cause is distinct from 'refused' and ($5::uuid is null or id <> $5)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(capability.as_uuid())
        .bind(from)
        .bind(to)
        .bind(except.map(|c| c.as_uuid()))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count calls"))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn extension_busy(
        &mut self,
        rep_extension: &str,
        except: Option<CallId>,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar(
            "select exists (select 1 from call_sessions where workspace_id = $1 and mode = 'human' \
             and state <> 'ended' and data -> 'mode' ->> 'rep_extension' = $2 \
             and ($3::uuid is null or id <> $3))",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(rep_extension)
        .bind(except.map(|c| c.as_uuid()))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read a busy extension"))
    }

    async fn inbound_since(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar(
            "select exists (select 1 from call_sessions where workspace_id = $1 and person_id = $2 \
             and direction = 'inbound' and started_at >= $3)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(person.as_uuid())
        .bind(since)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read inbound calls"))
    }

    async fn append_turns(&mut self, call: CallId, turns: Vec<Turn>) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let known: bool = sqlx::query_scalar(
            "select exists (select 1 from call_sessions where workspace_id = $1 and id = $2)",
        )
        .bind(ws.as_uuid())
        .bind(call.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read call session"))?;
        if !known {
            return Err(AppError::not_found("no such call"));
        }
        for turn in turns {
            let mut data = encode(&turn)?;
            if let Some(fields) = data.as_object_mut() {
                for k in ["seq", "at", "text"] {
                    fields.remove(k);
                }
            }
            let text: String = turn.text.chars().take(MAX_TURN_TEXT).collect();
            let done = sqlx::query(
                "insert into call_turns (workspace_id, call_id, seq, at, kind, speaker, text, data) \
                 values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing",
            )
            .bind(ws.as_uuid())
            .bind(call.as_uuid())
            .bind(i32::try_from(turn.seq).map_err(|_| AppError::internal("turn number overflow"))?)
            .bind(turn.at)
            .bind(turn.kind.key())
            .bind(speaker(&turn.kind))
            .bind(text)
            .bind(data)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "append call turn"))?;
            if done.rows_affected() == 0 {
                return Err(AppError::conflict("the turn number is already taken"));
            }
        }
        Ok(())
    }

    async fn turns(
        &mut self,
        call: CallId,
        after_seq: Option<u32>,
        limit: u32,
    ) -> Result<Vec<Turn>, AppError> {
        let rows: Vec<(i32, OffsetDateTime, String, Value)> = sqlx::query_as(
            "select seq, at, text, data from call_turns where workspace_id = $1 and call_id = $2 \
             and ($3::int is null or seq > $3) order by seq limit $4",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(call.as_uuid())
        .bind(after_seq.map(|s| i32::try_from(s).unwrap_or(i32::MAX)))
        .bind(i64::from(limit.clamp(1, MAX_CALL_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list call turns"))?;
        rows.into_iter()
            .map(|(seq, at, text, mut data)| {
                data["seq"] = json!(seq);
                data["at"] = json!(
                    at.format(&time::format_description::well_known::Rfc3339)
                        .map_err(|_| AppError::internal("unformattable turn time"))?
                );
                data["text"] = json!(text);
                decode(data)
            })
            .collect()
    }

    async fn policy(&mut self) -> Result<CallPolicy, AppError> {
        let ws = self.workspace_id();
        // The same lock as `WorkspacePolicyRepo::get`: policy edits take turns.
        sqlx::query(
            "select pg_advisory_xact_lock(hashtextextended('workspace-policy:' || $1::uuid::text, 0))",
        )
        .bind(ws.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock workspace policies"))?;
        let row: Option<Value> =
            sqlx::query_scalar("select calls from workspace_policies where workspace_id = $1")
                .bind(ws.as_uuid())
                .fetch_optional(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "read call policy"))?;
        match row {
            None => Ok(CallPolicy::default()),
            Some(value) => decode(value),
        }
    }

    async fn set_policy(&mut self, policy: CallPolicy, at: OffsetDateTime) -> Result<(), AppError> {
        sqlx::query(
            "insert into workspace_policies (workspace_id, updated_at, calls) values ($1, $2, $3) \
             on conflict (workspace_id) do update set calls = excluded.calls, \
             updated_at = excluded.updated_at",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(at)
        .bind(encode(&policy)?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "store call policy"))?;
        Ok(())
    }
}
