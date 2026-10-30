//! `prospects`, `prospect_keys`, `prospect_scores` and `prospect_blocklist` (migration
//! `0020_prospects`). A prospect's listed and filtered facts are columns; the rest of the record
//! (contact fields with their evidence, size, signals, notes, origin, decision) is `data`, read
//! tolerantly. Hard keys are checked before a write, under the pool lock the use cases take; a
//! racing writer without it is caught by the `prospect_keys_hard` unique index.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::prospects::{
    BlockReason, BlocklistRepo, Inserted, ListCursor, MAX_PROSPECT_PAGE, Page, ProspectQuery,
    ProspectRepo, ProspectRow, ScoreRow, Updated, is_key_hash,
};
use jt_inbox::{JourneyId, PersonId};
use jt_prospects::{
    ContactFields, Decision, EntityKind, Field, Key, KeyKind, Origin, Promotion, Prospect,
    ProspectId, ProspectStatus, ResearchTaskId, ScoreSummary, Signal, SizeHint, bucket,
};
use jt_strategy::StrategyVersionId;
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, same_workspace, stored};
use crate::uow::PgTenantRepos;

/// The columns a [`Record`] is read from.
const COLUMNS: &str = "workspace_id, id, status, business_name, entity_kind, sector, city, \
                       district, country, language, segment_key, labels, data, research_task_id, \
                       latest_score, latest_digest, latest_scored_at, promoted_person_id, \
                       promoted_journey_id, promoted_at, promoted_score, purge_after, revision, \
                       created_at, updated_at";

/// What `data` holds: the record but its columns.
#[derive(Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    contact: ContactFields,
    #[serde(default)]
    size: Option<Field<SizeHint>>,
    #[serde(default)]
    signals: Vec<Signal>,
    #[serde(default)]
    notes: String,
    origin: Origin,
    #[serde(default)]
    decision: Option<Decision>,
}

#[derive(sqlx::FromRow)]
struct Record {
    workspace_id: Uuid,
    id: Uuid,
    status: String,
    business_name: String,
    entity_kind: String,
    sector: Option<String>,
    city: Option<String>,
    district: Option<String>,
    country: String,
    language: Option<String>,
    segment_key: Option<String>,
    labels: Vec<String>,
    data: Value,
    research_task_id: Option<Uuid>,
    latest_score: Option<i16>,
    latest_digest: Option<String>,
    latest_scored_at: Option<OffsetDateTime>,
    promoted_person_id: Option<Uuid>,
    promoted_journey_id: Option<Uuid>,
    promoted_at: Option<OffsetDateTime>,
    promoted_score: Option<i16>,
    purge_after: Option<OffsetDateTime>,
    revision: i64,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

fn score_of(raw: i16, column: &str) -> Result<u8, AppError> {
    stored(u8::try_from(raw).ok().filter(|s| *s <= 100), column)
}

impl Record {
    fn into_prospect(self) -> Result<Prospect, AppError> {
        let data: Data = serde_json::from_value(self.data)
            .map_err(|_| AppError::internal("invalid stored prospect data"))?;
        let latest_score = match (self.latest_score, self.latest_digest, self.latest_scored_at) {
            (Some(score), Some(digest), Some(at)) => Some(ScoreSummary {
                score: score_of(score, "prospects.latest_score")?,
                digest,
                at,
            }),
            _ => None,
        };
        let promoted = match (
            self.promoted_person_id,
            self.promoted_journey_id,
            self.promoted_at,
        ) {
            (Some(person), Some(journey), Some(at)) => {
                let score = self
                    .promoted_score
                    .map(|s| score_of(s, "prospects.promoted_score"))
                    .transpose()?;
                Some(Promotion {
                    person_id: PersonId(person),
                    journey_id: JourneyId(journey),
                    at,
                    score,
                    bucket: score.map(bucket),
                })
            }
            _ => None,
        };
        Ok(Prospect {
            id: ProspectId(self.id),
            workspace_id: WorkspaceId(self.workspace_id),
            status: stored(ProspectStatus::parse(&self.status), "prospects.status")?,
            business_name: self.business_name,
            entity_kind: stored(
                EntityKind::parse(&self.entity_kind),
                "prospects.entity_kind",
            )?,
            sector: self.sector,
            city: self.city,
            district: self.district,
            country: self.country,
            language: self.language,
            segment_key: self.segment_key,
            labels: self.labels,
            contact: data.contact,
            size: data.size,
            signals: data.signals,
            notes: data.notes,
            origin: data.origin,
            research_task_id: self.research_task_id.map(ResearchTaskId),
            latest_score,
            decision: data.decision,
            promoted,
            purge_after: self.purge_after,
            revision: stored(u32::try_from(self.revision).ok(), "prospects.revision")?,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

fn data_of(p: &Prospect) -> Result<Value, AppError> {
    serde_json::to_value(Data {
        contact: p.contact.clone(),
        size: p.size.clone(),
        signals: p.signals.clone(),
        notes: p.notes.clone(),
        origin: p.origin.clone(),
        decision: p.decision.clone(),
    })
    .map_err(|_| AppError::internal("cannot encode prospect data"))
}

fn json<T: Serialize>(v: &T, what: &str) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| AppError::internal(format!("cannot encode {what}")))
}

/// `keys` without repeats, in key order, as the two arrays `unnest` reads.
fn key_arrays(keys: &[Key]) -> (Vec<String>, Vec<String>) {
    let set: BTreeSet<&Key> = keys.iter().collect();
    set.into_iter()
        .map(|k| (k.kind.key().to_owned(), k.value.clone()))
        .unzip()
}

fn kind_of(raw: &str) -> Result<KeyKind, AppError> {
    stored(KeyKind::parse(raw), "prospect_keys.kind")
}

impl PgTenantRepos {
    /// The first of `keys`' hard keys (in key order) another prospect than `except` holds.
    async fn hard_holder(
        &mut self,
        keys: &[Key],
        except: Option<ProspectId>,
    ) -> Result<Option<(KeyKind, ProspectId)>, AppError> {
        let hard: Vec<Key> = keys.iter().filter(|k| k.kind.hard()).cloned().collect();
        if hard.is_empty() {
            return Ok(None);
        }
        let (kinds, values) = key_arrays(&hard);
        let rows: Vec<(String, String, Uuid)> = sqlx::query_as(
            "select pk.kind, pk.value, pk.prospect_id from prospect_keys pk \
             join unnest($2::text[], $3::text[]) as k(kind, value) \
               on pk.kind = k.kind and pk.value = k.value \
             where pk.workspace_id = $1 and ($4::uuid is null or pk.prospect_id <> $4)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(&kinds)
        .bind(&values)
        .bind(except.map(|e| e.as_uuid()))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find hard prospect keys"))?;
        let mut held = Vec::with_capacity(rows.len());
        for (kind, value, id) in rows {
            held.push((
                Key {
                    kind: kind_of(&kind)?,
                    value,
                },
                ProspectId(id),
            ));
        }
        held.sort();
        Ok(held.into_iter().next().map(|(k, id)| (k.kind, id)))
    }

    /// Inserts `keys` for prospect `id`; how many were stored (a hard key another prospect
    /// holds is skipped).
    async fn insert_keys(&mut self, id: ProspectId, keys: &[Key]) -> Result<usize, AppError> {
        let (kinds, values) = key_arrays(keys);
        let stored = sqlx::query(
            "insert into prospect_keys (workspace_id, prospect_id, kind, value) \
             select $1, $2, k.kind, k.value from unnest($3::text[], $4::text[]) as k(kind, value) \
             on conflict do nothing",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(&kinds)
        .bind(&values)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert prospect keys"))?;
        Ok(stored.rows_affected() as usize)
    }

    /// The stored revision of prospect `id`, holding the row; `None` when there is none.
    async fn revision_of(&mut self, id: ProspectId) -> Result<Option<u32>, AppError> {
        let rev: Option<i64> = sqlx::query_scalar(
            "select revision from prospects where workspace_id = $1 and id = $2 for update",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read prospect revision"))?;
        rev.map(|r| stored(u32::try_from(r).ok(), "prospects.revision"))
            .transpose()
    }

    async fn one_prospect(
        &mut self,
        filter: &str,
        id: Uuid,
        lock: bool,
    ) -> Result<Option<Prospect>, AppError> {
        let sql = format!(
            "select {COLUMNS} from prospects where workspace_id = $1 and {filter} = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read prospect"))?;
        row.map(Record::into_prospect).transpose()
    }

    async fn count(&mut self, sql: &str, what: &str, text: Option<&str>) -> Result<u32, AppError> {
        let mut q = sqlx::query_scalar::<_, i64>(sql).bind(self.workspace_id().as_uuid());
        if let Some(t) = text {
            q = q.bind(t);
        }
        let n = q
            .fetch_one(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, what))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }
}

#[async_trait]
impl ProspectRepo for PgTenantRepos {
    async fn lock_pool(&mut self) -> Result<(), AppError> {
        sqlx::query(
            "select pg_advisory_xact_lock(hashtextextended('prospect_pool:' || $1::text, 0))",
        )
        .bind(self.workspace_id().as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lock the prospect pool"))?;
        Ok(())
    }

    async fn insert(&mut self, p: &Prospect, keys: &[Key]) -> Result<Inserted, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, p.workspace_id)?;
        if p.status == ProspectStatus::Promoted {
            return Err(AppError::internal("a new prospect is never promoted"));
        }
        if let Some((kind, prospect_id)) = self.hard_holder(keys, None).await? {
            return Ok(Inserted::DuplicateKey { kind, prospect_id });
        }
        let latest = p.latest_score.as_ref();
        let inserted = sqlx::query(
            "insert into prospects (workspace_id, id, status, business_name, entity_kind, sector, \
             city, district, country, language, segment_key, labels, data, research_task_id, \
             latest_score, latest_digest, latest_scored_at, purge_after, revision, created_at, \
             updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, \
             $15, $16, $17, $18, $19, $20, $21) on conflict do nothing",
        )
        .bind(ws.as_uuid())
        .bind(p.id.as_uuid())
        .bind(p.status.key())
        .bind(&p.business_name)
        .bind(p.entity_kind.key())
        .bind(&p.sector)
        .bind(&p.city)
        .bind(&p.district)
        .bind(&p.country)
        .bind(&p.language)
        .bind(&p.segment_key)
        .bind(&p.labels)
        .bind(data_of(p)?)
        .bind(p.research_task_id.map(|t| t.as_uuid()))
        .bind(latest.map(|s| i16::from(s.score)))
        .bind(latest.map(|s| s.digest.clone()))
        .bind(latest.map(|s| s.at))
        .bind(p.purge_after)
        .bind(i64::from(p.revision))
        .bind(p.created_at)
        .bind(p.updated_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert prospect"))?;
        if inserted.rows_affected() == 0 {
            return Err(AppError::conflict("the prospect id is already taken"));
        }
        let wanted = key_arrays(keys).0.len();
        if self.insert_keys(p.id, keys).await? < wanted {
            // A writer without the pool lock took a hard key in between: undo this prospect.
            let holder = self.hard_holder(keys, Some(p.id)).await?;
            sqlx::query("delete from prospects where workspace_id = $1 and id = $2")
                .bind(ws.as_uuid())
                .bind(p.id.as_uuid())
                .execute(self.tx.conn())
                .await
                .map_err(|e| map_sqlx(e, "undo prospect insert"))?;
            let (kind, prospect_id) = holder
                .ok_or_else(|| AppError::internal("a prospect key was skipped with no holder"))?;
            return Ok(Inserted::DuplicateKey { kind, prospect_id });
        }
        Ok(Inserted::Ok)
    }

    async fn update(
        &mut self,
        p: &Prospect,
        keys: &[Key],
        expected_revision: u32,
    ) -> Result<Updated, AppError> {
        let ws = self.workspace_id();
        same_workspace(ws, p.workspace_id)?;
        match self.revision_of(p.id).await? {
            None => return Err(AppError::not_found("no such prospect")),
            Some(r) if r != expected_revision => return Ok(Updated::Stale),
            Some(_) => {}
        }
        if let Some((kind, prospect_id)) = self.hard_holder(keys, Some(p.id)).await? {
            return Ok(Updated::DuplicateKey { kind, prospect_id });
        }
        let latest = p.latest_score.as_ref();
        let promoted = p.promoted.as_ref();
        sqlx::query(
            "update prospects set status = $3, business_name = $4, entity_kind = $5, sector = $6, \
             city = $7, district = $8, country = $9, language = $10, segment_key = $11, \
             labels = $12, data = $13, research_task_id = $14, latest_score = $15, \
             latest_digest = $16, latest_scored_at = $17, promoted_person_id = $18, \
             promoted_journey_id = $19, promoted_at = $20, promoted_score = $21, \
             purge_after = $22, updated_at = $23, revision = revision + 1 \
             where workspace_id = $1 and id = $2 and revision = $24",
        )
        .bind(ws.as_uuid())
        .bind(p.id.as_uuid())
        .bind(p.status.key())
        .bind(&p.business_name)
        .bind(p.entity_kind.key())
        .bind(&p.sector)
        .bind(&p.city)
        .bind(&p.district)
        .bind(&p.country)
        .bind(&p.language)
        .bind(&p.segment_key)
        .bind(&p.labels)
        .bind(data_of(p)?)
        .bind(p.research_task_id.map(|t| t.as_uuid()))
        .bind(latest.map(|s| i16::from(s.score)))
        .bind(latest.map(|s| s.digest.clone()))
        .bind(latest.map(|s| s.at))
        .bind(promoted.map(|x| x.person_id.as_uuid()))
        .bind(promoted.map(|x| x.journey_id.as_uuid()))
        .bind(promoted.map(|x| x.at))
        .bind(promoted.and_then(|x| x.score).map(i16::from))
        .bind(p.purge_after)
        .bind(p.updated_at)
        .bind(i64::from(expected_revision))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update prospect"))?;
        sqlx::query("delete from prospect_keys where workspace_id = $1 and prospect_id = $2")
            .bind(ws.as_uuid())
            .bind(p.id.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "replace prospect keys"))?;
        if self.insert_keys(p.id, keys).await? < key_arrays(keys).0.len() {
            // A writer without the pool lock took a hard key in between: the caller drops the
            // bundle, which undoes this update.
            return Err(AppError::conflict(
                "a prospect key was taken by a concurrent write",
            ));
        }
        Ok(Updated::Ok)
    }

    async fn get(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError> {
        self.one_prospect("id", id.as_uuid(), false).await
    }

    async fn lock(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError> {
        self.one_prospect("id", id.as_uuid(), true).await
    }

    async fn list(&mut self, q: &ProspectQuery) -> Result<Page<ProspectRow>, AppError> {
        let limit = q.limit.clamp(1, MAX_PROSPECT_PAGE);
        let range = q.bucket.map(|b| b.range());
        let sql = format!(
            "select {COLUMNS} from prospects where workspace_id = $1 \
             and ($2::text is null or status = $2) \
             and ($3::uuid is null or research_task_id = $3) \
             and ($4::text is null or city = $4) \
             and ($5::text is null or segment_key = $5) \
             and ($6::smallint is null or latest_score between $6 and $7) \
             and ($8::timestamptz is null or (created_at, id) < ($8, $9)) \
             order by created_at desc, id desc limit $10"
        );
        let rows: Vec<Record> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(q.status.map(|s| s.key()))
            .bind(q.research_task_id.map(|t| t.as_uuid()))
            .bind(&q.city)
            .bind(&q.segment_key)
            .bind(range.map(|r| i16::from(r.0)))
            .bind(range.map(|r| i16::from(r.1)))
            .bind(q.after.map(|c| c.created_at))
            .bind(q.after.map(|c| c.id))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list prospects"))?;
        let mut items = Vec::with_capacity(rows.len());
        for r in rows {
            items.push(ProspectRow::of(&r.into_prospect()?));
        }
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| ListCursor {
                created_at: r.created_at,
                id: r.id.as_uuid(),
            })
        } else {
            None
        };
        Ok(Page { items, next })
    }

    async fn find_by_keys(&mut self, keys: &[Key]) -> Result<Vec<(KeyKind, ProspectId)>, AppError> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let (kinds, values) = key_arrays(keys);
        let rows: Vec<(String, Uuid)> = sqlx::query_as(
            "select distinct pk.kind, pk.prospect_id from prospect_keys pk \
             join unnest($2::text[], $3::text[]) as k(kind, value) \
               on pk.kind = k.kind and pk.value = k.value \
             where pk.workspace_id = $1",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(&kinds)
        .bind(&values)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "find prospects by keys"))?;
        let mut out = Vec::with_capacity(rows.len());
        for (kind, id) in rows {
            out.push((kind_of(&kind)?, ProspectId(id)));
        }
        out.sort();
        out.dedup();
        Ok(out)
    }

    async fn keys_of(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "select kind, value from prospect_keys where workspace_id = $1 and prospect_id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read prospect keys"))?;
        let mut keys = Vec::with_capacity(rows.len());
        for (kind, value) in rows {
            keys.push(Key {
                kind: kind_of(&kind)?,
                value,
            });
        }
        keys.sort();
        Ok(keys)
    }

    async fn record_score(&mut self, row: &ScoreRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        if row.score > 100 {
            return Err(AppError::internal("a score is 0..=100"));
        }
        let found: Option<Uuid> = sqlx::query_scalar(
            "update prospects set latest_score = case when latest_scored_at is null \
               or latest_scored_at <= $3 then $4 else latest_score end, \
             latest_digest = case when latest_scored_at is null or latest_scored_at <= $3 \
               then $5 else latest_digest end, \
             latest_scored_at = greatest(latest_scored_at, $3) \
             where workspace_id = $1 and id = $2 returning id",
        )
        .bind(ws.as_uuid())
        .bind(row.prospect_id.as_uuid())
        .bind(row.at)
        .bind(i16::from(row.score))
        .bind(&row.rubric_digest)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set the latest prospect score"))?;
        if found.is_none() {
            return Err(AppError::not_found("no such prospect"));
        }
        sqlx::query(
            "insert into prospect_scores (workspace_id, id, prospect_id, score, reasons, \
             rubric_digest, strategy_version_id, recorder, at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(ws.as_uuid())
        .bind(row.id)
        .bind(row.prospect_id.as_uuid())
        .bind(i16::from(row.score))
        .bind(json(&row.reasons, "score reasons")?)
        .bind(&row.rubric_digest)
        .bind(row.strategy_version_id.map(|v| v.as_uuid()))
        .bind(json(&row.recorder, "score recorder")?)
        .bind(row.at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert prospect score"))?;
        Ok(())
    }

    async fn scores(&mut self, id: ProspectId, limit: u32) -> Result<Vec<ScoreRow>, AppError> {
        type Raw = (
            Uuid,
            Uuid,
            i16,
            Value,
            String,
            Option<Uuid>,
            Value,
            OffsetDateTime,
        );
        let rows: Vec<Raw> = sqlx::query_as(
            "select id, prospect_id, score, reasons, rubric_digest, strategy_version_id, \
             recorder, at from prospect_scores where workspace_id = $1 and prospect_id = $2 \
             order by at desc, id desc limit $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(i64::from(limit.clamp(1, MAX_PROSPECT_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list prospect scores"))?;
        rows.into_iter()
            .map(
                |(id, prospect, score, reasons, digest, version, recorder, at)| {
                    Ok(ScoreRow {
                        id,
                        prospect_id: ProspectId(prospect),
                        score: score_of(score, "prospect_scores.score")?,
                        reasons: serde_json::from_value(reasons)
                            .map_err(|_| AppError::internal("invalid stored score reasons"))?,
                        rubric_digest: digest,
                        strategy_version_id: version.map(StrategyVersionId),
                        recorder: serde_json::from_value(recorder)
                            .map_err(|_| AppError::internal("invalid stored score recorder"))?,
                        at,
                    })
                },
            )
            .collect()
    }

    async fn set_status(
        &mut self,
        id: ProspectId,
        status: ProspectStatus,
        decision: Option<&Decision>,
        purge_after: Option<OffsetDateTime>,
        at: OffsetDateTime,
        expected_revision: u32,
    ) -> Result<Updated, AppError> {
        if status == ProspectStatus::Promoted {
            return Err(AppError::internal("a promotion is set with set_promoted"));
        }
        match self.revision_of(id).await? {
            None => return Err(AppError::not_found("no such prospect")),
            Some(r) if r != expected_revision => return Ok(Updated::Stale),
            Some(_) => {}
        }
        let decision = decision.map(|d| json(d, "prospect decision")).transpose()?;
        sqlx::query(
            "update prospects set status = $3, \
             data = case when $4::jsonb is null then data - 'decision' \
                    else jsonb_set(data, '{decision}', $4::jsonb) end, \
             purge_after = $5, updated_at = $6, revision = revision + 1 \
             where workspace_id = $1 and id = $2 and revision = $7",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(status.key())
        .bind(decision)
        .bind(purge_after)
        .bind(at)
        .bind(i64::from(expected_revision))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set prospect status"))?;
        Ok(Updated::Ok)
    }

    async fn set_promoted(
        &mut self,
        id: ProspectId,
        promotion: &Promotion,
    ) -> Result<(), AppError> {
        let done = sqlx::query(
            "update prospects set status = 'promoted', promoted_person_id = $3, \
             promoted_journey_id = $4, promoted_at = $5, promoted_score = $6, purge_after = null, \
             updated_at = $5, revision = revision + 1 where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(promotion.person_id.as_uuid())
        .bind(promotion.journey_id.as_uuid())
        .bind(promotion.at)
        .bind(promotion.score.map(i16::from))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "promote prospect"))?;
        if done.rows_affected() == 0 {
            return Err(AppError::not_found("no such prospect"));
        }
        Ok(())
    }

    async fn by_person(&mut self, person: PersonId) -> Result<Option<Prospect>, AppError> {
        self.one_prospect("promoted_person_id", person.as_uuid(), false)
            .await
    }

    async fn delete(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError> {
        let keys = self.keys_of(id).await?;
        sqlx::query("delete from prospects where workspace_id = $1 and id = $2")
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "delete prospect"))?;
        Ok(keys)
    }

    async fn due_for_purge(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ProspectId>, AppError> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select id from prospects where workspace_id = $1 and purge_after <= $2 \
             order by purge_after, id limit $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(now)
        .bind(i64::from(limit))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list prospects due for purge"))?;
        Ok(ids.into_iter().map(ProspectId).collect())
    }

    async fn created_between(
        &mut self,
        task: Option<ResearchTaskId>,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from prospects where workspace_id = $1 and created_at >= $2 \
             and created_at < $3 and ($4::uuid is null or research_task_id = $4)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(from)
        .bind(to)
        .bind(task.map(|t| t.as_uuid()))
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count prospects created"))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn promoted_between(
        &mut self,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from prospects where workspace_id = $1 and promoted_at >= $2 \
             and promoted_at < $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(from)
        .bind(to)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count prospects promoted"))?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn count_unscored(&mut self, digest: &str) -> Result<u32, AppError> {
        self.count(
            "select count(*) from prospects where workspace_id = $1 and status = 'new' \
             and (latest_digest is null or latest_digest <> $2)",
            "count unscored prospects",
            Some(digest),
        )
        .await
    }

    async fn count_qualified_unpromoted(&mut self) -> Result<u32, AppError> {
        self.count(
            "select count(*) from prospects where workspace_id = $1 and status = 'qualified'",
            "count qualified prospects",
            None,
        )
        .await
    }

    async fn backlog(&mut self, segment_key: &str) -> Result<u32, AppError> {
        self.count(
            "select count(*) from prospects where workspace_id = $1 \
             and status in ('new', 'qualified') and segment_key = $2",
            "count the segment's backlog",
            Some(segment_key),
        )
        .await
    }
}

#[async_trait]
impl BlocklistRepo for PgTenantRepos {
    async fn contains(
        &mut self,
        kind: KeyKind,
        hash: &str,
        now: OffsetDateTime,
    ) -> Result<Option<BlockReason>, AppError> {
        let reason: Option<String> = sqlx::query_scalar(
            "select reason from prospect_blocklist where workspace_id = $1 and kind = $2 \
             and key_hash = $3 and (expires_at is null or expires_at > $4)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(kind.key())
        .bind(hash)
        .bind(now)
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read the prospect blocklist"))?;
        reason
            .map(|r| stored(BlockReason::parse(&r), "prospect_blocklist.reason"))
            .transpose()
    }

    async fn insert(
        &mut self,
        kind: KeyKind,
        hash: &str,
        reason: BlockReason,
        at: OffsetDateTime,
        expires_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        if !is_key_hash(hash) {
            return Err(AppError::internal(
                "a blocklist hash is 64 lowercase hex digits",
            ));
        }
        if (reason == BlockReason::Rejected) != expires_at.is_some() {
            return Err(AppError::internal(
                "a rejection expires, an objection or an erasure does not",
            ));
        }
        // The stronger reason wins (rejected < do_not_contact < erased); in the SET list the
        // table's name reads the stored row, `excluded` the new one.
        sqlx::query(
            "insert into prospect_blocklist (workspace_id, kind, key_hash, reason, created_at, \
             expires_at) values ($1, $2, $3, $4, $5, $6) \
             on conflict (workspace_id, kind, key_hash) do update set \
             reason = case when array_position(array['rejected', 'do_not_contact', 'erased'], excluded.reason) \
                 > array_position(array['rejected', 'do_not_contact', 'erased'], prospect_blocklist.reason) \
                 then excluded.reason else prospect_blocklist.reason end, \
             expires_at = case \
                 when array_position(array['rejected', 'do_not_contact', 'erased'], excluded.reason) \
                   > array_position(array['rejected', 'do_not_contact', 'erased'], prospect_blocklist.reason) \
                   then excluded.expires_at \
                 when prospect_blocklist.reason = 'rejected' and excluded.reason = 'rejected' \
                   then greatest(prospect_blocklist.expires_at, excluded.expires_at) \
                 else prospect_blocklist.expires_at end",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(kind.key())
        .bind(hash)
        .bind(reason.key())
        .bind(at)
        .bind(expires_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert into the prospect blocklist"))?;
        Ok(())
    }

    async fn lift(&mut self, kind: KeyKind, hash: &str) -> Result<bool, AppError> {
        let done = sqlx::query(
            "delete from prospect_blocklist where workspace_id = $1 and kind = $2 \
             and key_hash = $3 and reason = 'do_not_contact'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(kind.key())
        .bind(hash)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "lift a blocklist entry"))?;
        Ok(done.rows_affected() > 0)
    }

    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let done = sqlx::query(
            "delete from prospect_blocklist where workspace_id = $1 and reason = 'rejected' \
             and expires_at <= $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(now)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "purge expired blocklist entries"))?;
        Ok(done.rows_affected())
    }
}
