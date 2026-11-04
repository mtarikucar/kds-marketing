//! `rep_profiles`, `distribution_rules` and `journey_assignments` (migration
//! `0027_distribution`). A rule's `match` and `pool` and an assignment's `by_actor` keep the
//! domain's encoding as JSON; one live decision per journey is the partial unique index
//! `journey_assignments_live`, and the trigger `journey_assignments_append_only` keeps the log
//! append-only.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::distribution::{
    AssignmentCursor, AssignmentPage, AssignmentQuery, AssignmentRepo, AssignmentRow,
    MAX_ASSIGNMENT_PAGE, MAX_RULES, Ownerless, OwnerlessScope, RepProfileRepo, RuleRepo,
};
use jt_inbox::{AssignmentId, Cause, JourneyId, Method, RepProfile, Rule, RuleId};
use jt_tenancy::UserId;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::{map_sqlx, stored};
use crate::uow::PgTenantRepos;

fn decode<T: DeserializeOwned>(v: Value, column: &str) -> Result<T, AppError> {
    serde_json::from_value(v).map_err(|_| AppError::internal(format!("invalid stored {column}")))
}

fn encode<T: Serialize>(v: &T, what: &str) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| AppError::internal(format!("cannot encode {what}")))
}

fn count(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

const PROFILE_COLUMNS: &str =
    "user_id, accepting, max_open, languages, cities, sectors, hours, away_until, updated_at";

#[derive(sqlx::FromRow)]
struct ProfileRecord {
    user_id: Uuid,
    accepting: bool,
    max_open: Option<i32>,
    languages: Vec<String>,
    cities: Vec<String>,
    sectors: Vec<String>,
    hours: Option<Value>,
    away_until: Option<OffsetDateTime>,
    updated_at: OffsetDateTime,
}

impl ProfileRecord {
    fn into_profile(self) -> Result<RepProfile, AppError> {
        Ok(RepProfile {
            user_id: UserId(self.user_id),
            accepting: self.accepting,
            max_open: self
                .max_open
                .map(|m| stored(u16::try_from(m).ok(), "rep_profiles.max_open"))
                .transpose()?,
            languages: self.languages,
            cities: self.cities,
            sectors: self.sectors,
            hours: self
                .hours
                .map(|h| decode(h, "rep_profiles.hours"))
                .transpose()?,
            away_until: self.away_until,
            updated_at: self.updated_at,
        })
    }
}

const RULE_COLUMNS: &str = "id, name, enabled, match, pool, method, sla_minutes, cursor_user_id";

#[derive(sqlx::FromRow)]
struct RuleRecord {
    id: Uuid,
    name: String,
    enabled: bool,
    #[sqlx(rename = "match")]
    when: Value,
    pool: Value,
    method: String,
    sla_minutes: Option<i32>,
    cursor_user_id: Option<Uuid>,
}

impl RuleRecord {
    fn into_rule(self) -> Result<Rule, AppError> {
        Ok(Rule {
            id: RuleId(self.id),
            name: self.name,
            enabled: self.enabled,
            when: decode(self.when, "distribution_rules.match")?,
            to: decode(self.pool, "distribution_rules.pool")?,
            method: stored(Method::parse(&self.method), "distribution_rules.method")?,
            sla_minutes: self
                .sla_minutes
                .map(|m| stored(u32::try_from(m).ok(), "distribution_rules.sla_minutes"))
                .transpose()?,
            cursor: self.cursor_user_id.map(UserId),
        })
    }
}

const ASSIGNMENT_COLUMNS: &str = "a.id, a.journey_id, a.user_id, a.cause, a.rule_id, \
                                  a.assigned_at, a.sla_due_at, a.acted_at, a.superseded_at, \
                                  a.by_actor";

#[derive(sqlx::FromRow)]
struct AssignmentRecord {
    id: Uuid,
    journey_id: Uuid,
    user_id: Option<Uuid>,
    cause: String,
    rule_id: Option<Uuid>,
    assigned_at: OffsetDateTime,
    sla_due_at: Option<OffsetDateTime>,
    acted_at: Option<OffsetDateTime>,
    superseded_at: Option<OffsetDateTime>,
    by_actor: Value,
}

impl AssignmentRecord {
    fn into_row(self) -> Result<AssignmentRow, AppError> {
        Ok(AssignmentRow {
            id: AssignmentId(self.id),
            journey_id: JourneyId(self.journey_id),
            user_id: self.user_id.map(UserId),
            cause: stored(Cause::parse(&self.cause), "journey_assignments.cause")?,
            rule_id: self.rule_id.map(RuleId),
            assigned_at: self.assigned_at,
            sla_due_at: self.sla_due_at,
            acted_at: self.acted_at,
            superseded_at: self.superseded_at,
            by: decode(self.by_actor, "journey_assignments.by_actor")?,
        })
    }
}

/// Live, unacted decisions of open journeys due at `$2` or before, with the journey's count of
/// SLA reassignments as `n`.
const OVERDUE: &str = "select a.*, (select count(*) from journey_assignments r \
                       where r.workspace_id = a.workspace_id and r.journey_id = a.journey_id \
                       and r.cause = 'sla_reassign') as n \
                       from journey_assignments a join journeys j \
                       on j.workspace_id = a.workspace_id and j.id = a.journey_id \
                       where a.workspace_id = $1 and a.superseded_at is null \
                       and a.acted_at is null and a.sla_due_at is not null \
                       and a.sla_due_at <= $2 and j.closed_at is null";

#[async_trait]
impl RepProfileRepo for PgTenantRepos {
    async fn get(&mut self, user: UserId) -> Result<RepProfile, AppError> {
        let sql = format!(
            "select {PROFILE_COLUMNS} from rep_profiles where workspace_id = $1 and user_id = $2"
        );
        let row: Option<ProfileRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(user.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read rep profile"))?;
        match row {
            Some(r) => r.into_profile(),
            None => Ok(RepProfile::default_for(user)),
        }
    }

    async fn list(&mut self) -> Result<Vec<RepProfile>, AppError> {
        let sql = format!(
            "select {PROFILE_COLUMNS} from rep_profiles where workspace_id = $1 order by user_id"
        );
        let rows: Vec<ProfileRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list rep profiles"))?;
        rows.into_iter().map(ProfileRecord::into_profile).collect()
    }

    async fn set(&mut self, p: &RepProfile) -> Result<(), AppError> {
        sqlx::query(
            "insert into rep_profiles (workspace_id, user_id, accepting, max_open, languages, \
             cities, sectors, hours, away_until, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             on conflict (workspace_id, user_id) do update set accepting = excluded.accepting, \
             max_open = excluded.max_open, languages = excluded.languages, \
             cities = excluded.cities, sectors = excluded.sectors, hours = excluded.hours, \
             away_until = excluded.away_until, updated_at = excluded.updated_at",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(p.user_id.as_uuid())
        .bind(p.accepting)
        .bind(p.max_open.map(i32::from))
        .bind(&p.languages)
        .bind(&p.cities)
        .bind(&p.sectors)
        .bind(
            p.hours
                .as_ref()
                .map(|h| encode(h, "rep hours"))
                .transpose()?,
        )
        .bind(p.away_until)
        .bind(p.updated_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set rep profile"))?;
        Ok(())
    }
}

#[async_trait]
impl RuleRepo for PgTenantRepos {
    async fn list(&mut self) -> Result<Vec<Rule>, AppError> {
        let sql = format!(
            "select {RULE_COLUMNS} from distribution_rules where workspace_id = $1 order by position"
        );
        let rows: Vec<RuleRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list distribution rules"))?;
        rows.into_iter().map(RuleRecord::into_rule).collect()
    }

    async fn replace_all(&mut self, rules: &[Rule], at: OffsetDateTime) -> Result<(), AppError> {
        if rules.len() > MAX_RULES {
            return Err(AppError::internal("more rules than positions"));
        }
        let ws = self.workspace_id();
        sqlx::query("delete from distribution_rules where workspace_id = $1")
            .bind(ws.as_uuid())
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "replace distribution rules"))?;
        for (position, r) in rules.iter().enumerate() {
            sqlx::query(
                "insert into distribution_rules (workspace_id, id, position, name, enabled, \
                 match, pool, method, sla_minutes, cursor_user_id, updated_at) \
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            )
            .bind(ws.as_uuid())
            .bind(r.id.as_uuid())
            .bind(i32::try_from(position).unwrap_or(i32::MAX))
            .bind(&r.name)
            .bind(r.enabled)
            .bind(encode(&r.when, "rule match")?)
            .bind(encode(&r.to, "rule pool")?)
            .bind(r.method.key())
            .bind(r.sla_minutes.map(|m| i32::try_from(m).unwrap_or(i32::MAX)))
            .bind(r.cursor.map(|u| u.as_uuid()))
            .bind(at)
            .execute(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "insert distribution rule"))?;
        }
        Ok(())
    }

    async fn set_cursor(&mut self, id: RuleId, user: UserId) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update distribution_rules set cursor_user_id = $3 where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(user.as_uuid())
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set rule cursor"))?;
        Ok(done.rows_affected() == 1)
    }
}

#[async_trait]
impl AssignmentRepo for PgTenantRepos {
    async fn live(&mut self, journey: JourneyId) -> Result<Option<AssignmentRow>, AppError> {
        let sql = format!(
            "select {ASSIGNMENT_COLUMNS} from journey_assignments a where a.workspace_id = $1 \
             and a.journey_id = $2 and a.superseded_at is null"
        );
        let row: Option<AssignmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(journey.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read live assignment"))?;
        row.map(AssignmentRecord::into_row).transpose()
    }

    async fn insert(&mut self, row: &AssignmentRow) -> Result<(), AppError> {
        let ws = self.workspace_id();
        let journey: bool = sqlx::query_scalar(
            "select exists(select 1 from journeys where workspace_id = $1 and id = $2)",
        )
        .bind(ws.as_uuid())
        .bind(row.journey_id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read journey"))?;
        if !journey {
            return Err(AppError::not_found("no such journey"));
        }
        if row.superseded_at.is_some() {
            return Err(AppError::internal("an assignment is inserted live"));
        }
        sqlx::query(
            "insert into journey_assignments (workspace_id, id, journey_id, user_id, cause, \
             rule_id, assigned_at, sla_due_at, acted_at, superseded_at, by_actor) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)",
        )
        .bind(ws.as_uuid())
        .bind(row.id.as_uuid())
        .bind(row.journey_id.as_uuid())
        .bind(row.user_id.map(|u| u.as_uuid()))
        .bind(row.cause.key())
        .bind(row.rule_id.map(|r| r.as_uuid()))
        .bind(row.assigned_at)
        .bind(row.sla_due_at)
        .bind(row.acted_at)
        .bind(encode(&row.by, "assignment actor")?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert assignment"))?;
        Ok(())
    }

    async fn supersede(
        &mut self,
        journey: JourneyId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update journey_assignments set superseded_at = $3 where workspace_id = $1 \
             and journey_id = $2 and superseded_at is null",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(journey.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "supersede assignment"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn touch(
        &mut self,
        journey: JourneyId,
        user: UserId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update journey_assignments set acted_at = $4 where workspace_id = $1 \
             and journey_id = $2 and superseded_at is null and user_id = $3 \
             and acted_at is null",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(journey.as_uuid())
        .bind(user.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "mark assignment acted"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn due_sla(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
        limit: u32,
    ) -> Result<Vec<AssignmentRow>, AppError> {
        let sql = format!(
            "select {ASSIGNMENT_COLUMNS} from ({OVERDUE}) a where a.n < $3 \
             order by a.sla_due_at, a.id limit $4"
        );
        let rows: Vec<AssignmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(now)
            .bind(i64::from(max_reassignments))
            .bind(i64::from(limit.clamp(1, MAX_ASSIGNMENT_PAGE)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list due assignments"))?;
        rows.into_iter().map(AssignmentRecord::into_row).collect()
    }

    async fn count_stalled(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
    ) -> Result<u32, AppError> {
        let sql =
            format!("select count(*) from ({OVERDUE}) a where a.workspace_id = $1 and a.n >= $3");
        let n: i64 = sqlx::query_scalar(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(now)
            .bind(i64::from(max_reassignments))
            .fetch_one(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "count stalled assignments"))?;
        Ok(count(n))
    }

    async fn ownerless_open(
        &mut self,
        scope: OwnerlessScope,
        limit: u32,
    ) -> Result<Vec<JourneyId>, AppError> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select j.id from journeys j where j.workspace_id = $1 and j.closed_at is null \
             and j.owner_id is null and ($2 or not exists (select 1 from journey_assignments a \
             where a.workspace_id = j.workspace_id and a.journey_id = j.id \
             and a.superseded_at is null and a.cause <> 'member_left')) \
             order by j.opened_at, j.id limit $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(scope == OwnerlessScope::All)
        .bind(i64::from(limit.clamp(1, MAX_ASSIGNMENT_PAGE)))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list ownerless journeys"))?;
        Ok(ids.into_iter().map(JourneyId).collect())
    }

    async fn count_ownerless(&mut self) -> Result<Ownerless, AppError> {
        let (n, oldest): (i64, Option<Uuid>) = sqlx::query_as(
            "select count(*), (select o.id from journeys o where o.workspace_id = $1 \
             and o.closed_at is null and o.owner_id is null order by o.opened_at, o.id limit 1) \
             from journeys j where j.workspace_id = $1 and j.closed_at is null \
             and j.owner_id is null",
        )
        .bind(self.workspace_id().as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count ownerless journeys"))?;
        Ok(Ownerless {
            count: count(n),
            oldest_journey_id: oldest.map(JourneyId),
        })
    }

    async fn previous_assignees(&mut self, journey: JourneyId) -> Result<Vec<UserId>, AppError> {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "select distinct user_id from journey_assignments where workspace_id = $1 \
             and journey_id = $2 and user_id is not null order by user_id",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(journey.as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "list previous assignees"))?;
        Ok(ids.into_iter().map(UserId).collect())
    }

    async fn reassignments(&mut self, journey: JourneyId) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from journey_assignments where workspace_id = $1 \
             and journey_id = $2 and cause = 'sla_reassign'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(journey.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count reassignments"))?;
        Ok(count(n))
    }

    async fn default_cursor(&mut self) -> Result<Option<UserId>, AppError> {
        let user: Option<Option<Uuid>> = sqlx::query_scalar(
            "select user_id from journey_assignments where workspace_id = $1 \
             and cause = 'default' order by assigned_at desc, id desc limit 1",
        )
        .bind(self.workspace_id().as_uuid())
        .fetch_optional(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read default cursor"))?;
        Ok(user.flatten().map(UserId))
    }

    async fn open_owned(&mut self) -> Result<Vec<(UserId, u32)>, AppError> {
        let rows: Vec<(Uuid, i64)> = sqlx::query_as(
            "select owner_id, count(*) from journeys where workspace_id = $1 \
             and closed_at is null and owner_id is not null group by owner_id order by owner_id",
        )
        .bind(self.workspace_id().as_uuid())
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count owned journeys"))?;
        Ok(rows
            .into_iter()
            .map(|(u, n)| (UserId(u), count(n)))
            .collect())
    }

    async fn list(&mut self, q: &AssignmentQuery) -> Result<AssignmentPage, AppError> {
        let limit = q.limit.clamp(1, MAX_ASSIGNMENT_PAGE);
        let sql = format!(
            "select {ASSIGNMENT_COLUMNS} from journey_assignments a where a.workspace_id = $1 \
             and ($2::uuid is null or a.journey_id = $2) \
             and ($3::uuid is null or a.user_id = $3) \
             and ($4::timestamptz is null or (a.assigned_at, a.id) < ($4, $5)) \
             order by a.assigned_at desc, a.id desc limit $6"
        );
        let rows: Vec<AssignmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(q.journey_id.map(|j| j.as_uuid()))
            .bind(q.user_id.map(|u| u.as_uuid()))
            .bind(q.before.map(|c| c.assigned_at))
            .bind(q.before.map(|c| c.id.as_uuid()))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list assignments"))?;
        let mut items = rows
            .into_iter()
            .map(AssignmentRecord::into_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| AssignmentCursor {
                assigned_at: r.assigned_at,
                id: r.id,
            })
        } else {
            None
        };
        Ok(AssignmentPage { items, next })
    }
}
