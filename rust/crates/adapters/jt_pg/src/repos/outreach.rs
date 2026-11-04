//! `outreach_templates`, `outreach_campaigns`, `outreach_enrollments` and `outreach_sends`
//! (migration `0026_outreach`). A campaign's definition and approval, a template's and a
//! campaign's `created_by` and an enrollment's personalization keep the domain's encoding as
//! JSON. One active enrollment per person is the partial unique index
//! `outreach_enrollments_one_active`; `due` takes its rows `for update skip locked`.

use std::collections::BTreeMap;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::outreach::{
    CampaignCursor, CampaignPage, CampaignQuery, CampaignRepo, CampaignRow, EnrollmentPage,
    EnrollmentQuery, EnrollmentRepo, EnrollmentRow, InsertReport, MAX_ENROLLMENT_BATCH,
    MAX_OUTREACH_PAGE, OutreachSendRepo, ReportQuery, SendRow, StepCounts, TemplateCursor,
    TemplatePage, TemplateQuery, TemplateRepo, TemplateRow, campaign_row_valid, enrollment_reason,
    enrollment_row_valid,
};
use jt_capability::CapabilityId;
use jt_inbox::{CommercialBasis, JourneyId, MessageId, PersonId};
use jt_outreach::{
    CampaignId, CampaignStatus, EnrollmentId, EnrollmentStatus, Lang, PauseReason, SendId,
    SendOutcome, SkipReason, StopReason, Template, TemplateId,
};
use jt_prospects::ProspectId;
use jt_strategy::StrategyVersionId;
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

fn revision(n: i64, column: &str) -> Result<u32, AppError> {
    stored(u32::try_from(n).ok().filter(|r| *r >= 1), column)
}

fn page_limit(limit: u32) -> u32 {
    limit.clamp(1, MAX_OUTREACH_PAGE)
}

/// The from-outcomes that may become `to`.
fn from_outcomes(to: SendOutcome) -> Vec<&'static str> {
    SendOutcome::ALL
        .iter()
        .filter(|from| from.can_become(to))
        .map(|from| from.key())
        .collect()
}

// ---- templates ----

const TEMPLATE_COLUMNS: &str =
    "id, name, language, subject, body, revision, archived, created_by, updated_at";

#[derive(sqlx::FromRow)]
struct TemplateRecord {
    id: Uuid,
    name: String,
    language: String,
    subject: String,
    body: String,
    revision: i64,
    archived: bool,
    created_by: Value,
    updated_at: OffsetDateTime,
}

impl TemplateRecord {
    fn into_row(self) -> Result<TemplateRow, AppError> {
        Ok(TemplateRow {
            template: Template {
                id: TemplateId(self.id),
                name: self.name,
                language: stored(Lang::parse(&self.language), "outreach_templates.language")?,
                subject: self.subject,
                body: self.body,
                revision: revision(self.revision, "outreach_templates.revision")?,
                archived: self.archived,
            },
            created_by: decode(self.created_by, "outreach_templates.created_by")?,
            updated_at: self.updated_at,
        })
    }
}

impl PgTenantRepos {
    async fn template_by_id(
        &mut self,
        id: TemplateId,
        lock: bool,
    ) -> Result<Option<TemplateRow>, AppError> {
        let sql = format!(
            "select {TEMPLATE_COLUMNS} from outreach_templates where workspace_id = $1 and id = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<TemplateRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read outreach template"))?;
        row.map(TemplateRecord::into_row).transpose()
    }
}

#[async_trait]
impl TemplateRepo for PgTenantRepos {
    async fn insert(&mut self, row: &TemplateRow) -> Result<(), AppError> {
        let t = &row.template;
        sqlx::query(
            "insert into outreach_templates (workspace_id, id, name, language, subject, body, \
             revision, archived, created_by, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(t.id.as_uuid())
        .bind(&t.name)
        .bind(t.language.key())
        .bind(&t.subject)
        .bind(&t.body)
        .bind(i64::from(t.revision))
        .bind(t.archived)
        .bind(encode(&row.created_by, "template author")?)
        .bind(row.updated_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert outreach template"))?;
        Ok(())
    }

    async fn get(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError> {
        self.template_by_id(id, false).await
    }

    async fn lock(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError> {
        self.template_by_id(id, true).await
    }

    async fn update(
        &mut self,
        row: &TemplateRow,
        expected_revision: u32,
    ) -> Result<bool, AppError> {
        let t = &row.template;
        let done = sqlx::query(
            "update outreach_templates set name = $3, language = $4, subject = $5, body = $6, \
             revision = $7, archived = $8, updated_at = $9 \
             where workspace_id = $1 and id = $2 and revision = $10",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(t.id.as_uuid())
        .bind(&t.name)
        .bind(t.language.key())
        .bind(&t.subject)
        .bind(&t.body)
        .bind(i64::from(t.revision))
        .bind(t.archived)
        .bind(row.updated_at)
        .bind(i64::from(expected_revision))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update outreach template"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn list(&mut self, q: &TemplateQuery) -> Result<TemplatePage, AppError> {
        let limit = page_limit(q.limit);
        let sql = format!(
            "select {TEMPLATE_COLUMNS} from outreach_templates where workspace_id = $1 \
             and ($2 or not archived) \
             and ($3::timestamptz is null or (updated_at, id) < ($3, $4)) \
             order by updated_at desc, id desc limit $5"
        );
        let rows: Vec<TemplateRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(q.include_archived)
            .bind(q.before.map(|c| c.updated_at))
            .bind(q.before.map(|c| c.id.as_uuid()))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list outreach templates"))?;
        let mut items = rows
            .into_iter()
            .map(TemplateRecord::into_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| TemplateCursor {
                updated_at: r.updated_at,
                id: r.template.id,
            })
        } else {
            None
        };
        Ok(TemplatePage { items, next })
    }
}

// ---- campaigns ----

const CAMPAIGN_COLUMNS: &str = "id, name, mailbox_id, status, definition, revision, approval, \
                                pause_reason, strategy_version_id, created_by, created_at, \
                                updated_at, launched_at, completed_at";

#[derive(sqlx::FromRow)]
struct CampaignRecord {
    id: Uuid,
    name: String,
    mailbox_id: Uuid,
    status: String,
    definition: Value,
    revision: i64,
    approval: Option<Value>,
    pause_reason: Option<String>,
    strategy_version_id: Uuid,
    created_by: Value,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    launched_at: Option<OffsetDateTime>,
    completed_at: Option<OffsetDateTime>,
}

impl CampaignRecord {
    fn into_row(self) -> Result<CampaignRow, AppError> {
        Ok(CampaignRow {
            id: CampaignId(self.id),
            name: self.name,
            mailbox_id: CapabilityId(self.mailbox_id),
            status: stored(
                CampaignStatus::parse(&self.status),
                "outreach_campaigns.status",
            )?,
            definition: decode(self.definition, "outreach_campaigns.definition")?,
            revision: revision(self.revision, "outreach_campaigns.revision")?,
            approval: self
                .approval
                .map(|a| decode(a, "outreach_campaigns.approval"))
                .transpose()?,
            pause_reason: self
                .pause_reason
                .map(|r| stored(PauseReason::parse(&r), "outreach_campaigns.pause_reason"))
                .transpose()?,
            strategy_version_id: StrategyVersionId(self.strategy_version_id),
            created_by: decode(self.created_by, "outreach_campaigns.created_by")?,
            created_at: self.created_at,
            updated_at: self.updated_at,
            launched_at: self.launched_at,
            completed_at: self.completed_at,
        })
    }
}

impl PgTenantRepos {
    async fn campaign_by_id(
        &mut self,
        id: CampaignId,
        lock: bool,
    ) -> Result<Option<CampaignRow>, AppError> {
        let sql = format!(
            "select {CAMPAIGN_COLUMNS} from outreach_campaigns where workspace_id = $1 and id = $2{}",
            if lock { " for update" } else { "" }
        );
        let row: Option<CampaignRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(id.as_uuid())
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read outreach campaign"))?;
        row.map(CampaignRecord::into_row).transpose()
    }

    async fn exists_in_workspace(
        &mut self,
        table: &'static str,
        id: Uuid,
        what: &str,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar(&format!(
            "select exists(select 1 from {table} where workspace_id = $1 and id = $2)"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(id)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, what))
    }
}

#[async_trait]
impl CampaignRepo for PgTenantRepos {
    async fn insert(&mut self, row: &CampaignRow) -> Result<(), AppError> {
        if !campaign_row_valid(row) {
            return Err(AppError::internal("a campaign breaks its checks"));
        }
        if !self
            .exists_in_workspace("capabilities", row.mailbox_id.as_uuid(), "read mailbox")
            .await?
        {
            return Err(AppError::not_found("no such mailbox"));
        }
        if !self
            .exists_in_workspace(
                "strategy_versions",
                row.strategy_version_id.as_uuid(),
                "read strategy version",
            )
            .await?
        {
            return Err(AppError::not_found("no such strategy version"));
        }
        sqlx::query(
            "insert into outreach_campaigns (workspace_id, id, name, mailbox_id, status, \
             definition, revision, approval, pause_reason, strategy_version_id, created_by, \
             created_at, updated_at, launched_at, completed_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id.as_uuid())
        .bind(&row.name)
        .bind(row.mailbox_id.as_uuid())
        .bind(row.status.key())
        .bind(encode(&row.definition, "campaign definition")?)
        .bind(i64::from(row.revision))
        .bind(
            row.approval
                .as_ref()
                .map(|a| encode(a, "campaign approval"))
                .transpose()?,
        )
        .bind(row.pause_reason.map(PauseReason::key))
        .bind(row.strategy_version_id.as_uuid())
        .bind(encode(&row.created_by, "campaign author")?)
        .bind(row.created_at)
        .bind(row.updated_at)
        .bind(row.launched_at)
        .bind(row.completed_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert outreach campaign"))?;
        Ok(())
    }

    async fn get(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError> {
        self.campaign_by_id(id, false).await
    }

    async fn lock(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError> {
        self.campaign_by_id(id, true).await
    }

    async fn update(
        &mut self,
        row: &CampaignRow,
        expected_revision: u32,
    ) -> Result<bool, AppError> {
        if !campaign_row_valid(row) {
            return Err(AppError::internal("a campaign breaks its checks"));
        }
        let done = sqlx::query(
            "update outreach_campaigns set name = $3, mailbox_id = $4, status = $5, \
             definition = $6, revision = $7, approval = $8, pause_reason = $9, updated_at = $10, \
             launched_at = $11, completed_at = $12 \
             where workspace_id = $1 and id = $2 and revision = $13",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id.as_uuid())
        .bind(&row.name)
        .bind(row.mailbox_id.as_uuid())
        .bind(row.status.key())
        .bind(encode(&row.definition, "campaign definition")?)
        .bind(i64::from(row.revision))
        .bind(
            row.approval
                .as_ref()
                .map(|a| encode(a, "campaign approval"))
                .transpose()?,
        )
        .bind(row.pause_reason.map(PauseReason::key))
        .bind(row.updated_at)
        .bind(row.launched_at)
        .bind(row.completed_at)
        .bind(i64::from(expected_revision))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "update outreach campaign"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn list(&mut self, q: &CampaignQuery) -> Result<CampaignPage, AppError> {
        let limit = page_limit(q.limit);
        let sql = format!(
            "select {CAMPAIGN_COLUMNS} from outreach_campaigns where workspace_id = $1 \
             and ($2::text is null or status = $2) \
             and ($3::timestamptz is null or (created_at, id) < ($3, $4)) \
             order by created_at desc, id desc limit $5"
        );
        let rows: Vec<CampaignRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(q.status.map(CampaignStatus::key))
            .bind(q.before.map(|c| c.created_at))
            .bind(q.before.map(|c| c.id.as_uuid()))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list outreach campaigns"))?;
        let mut items = rows
            .into_iter()
            .map(CampaignRecord::into_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| CampaignCursor {
                created_at: r.created_at,
                id: r.id,
            })
        } else {
            None
        };
        Ok(CampaignPage { items, next })
    }

    async fn by_status(
        &mut self,
        status: CampaignStatus,
        limit: u32,
    ) -> Result<Vec<CampaignRow>, AppError> {
        let sql = format!(
            "select {CAMPAIGN_COLUMNS} from outreach_campaigns where workspace_id = $1 \
             and status = $2 order by launched_at nulls last, created_at, id limit $3"
        );
        let rows: Vec<CampaignRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(status.key())
            .bind(i64::from(page_limit(limit)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list campaigns by status"))?;
        rows.into_iter().map(CampaignRecord::into_row).collect()
    }
}

// ---- enrollments ----

const ENROLLMENT_COLUMNS: &str = "id, campaign_id, person_id, journey_id, prospect_id, status, \
                                  reason, next_step, next_send_at, personalization, basis, \
                                  enrolled_at, stopped_at, last_sent_at";

#[derive(sqlx::FromRow)]
struct EnrollmentRecord {
    id: Uuid,
    campaign_id: Uuid,
    person_id: Uuid,
    journey_id: Option<Uuid>,
    prospect_id: Option<Uuid>,
    status: String,
    reason: Option<String>,
    next_step: i16,
    next_send_at: Option<OffsetDateTime>,
    personalization: Value,
    basis: Option<String>,
    enrolled_at: OffsetDateTime,
    stopped_at: Option<OffsetDateTime>,
    last_sent_at: Option<OffsetDateTime>,
}

fn basis_of(key: &str) -> Option<CommercialBasis> {
    [CommercialBasis::Consent, CommercialBasis::BusinessRecipient]
        .into_iter()
        .find(|b| b.key() == key)
}

impl EnrollmentRecord {
    fn into_row(self) -> Result<EnrollmentRow, AppError> {
        let status = stored(
            EnrollmentStatus::parse(&self.status),
            "outreach_enrollments.status",
        )?;
        let reason = self.reason.as_deref();
        let (stop, skip) = match (status, reason) {
            (EnrollmentStatus::Stopped, Some(r)) => (
                Some(stored(StopReason::parse(r), "outreach_enrollments.reason")?),
                None,
            ),
            (EnrollmentStatus::Skipped, Some(r)) => (
                None,
                Some(stored(SkipReason::parse(r), "outreach_enrollments.reason")?),
            ),
            (EnrollmentStatus::Active | EnrollmentStatus::Completed, None) => (None, None),
            _ => return Err(AppError::internal("stored outreach_enrollments.reason")),
        };
        let personalization: BTreeMap<String, String> =
            decode(self.personalization, "outreach_enrollments.personalization")?;
        Ok(EnrollmentRow {
            id: EnrollmentId(self.id),
            campaign_id: CampaignId(self.campaign_id),
            person_id: PersonId(self.person_id),
            journey_id: self.journey_id.map(JourneyId),
            prospect_id: self.prospect_id.map(ProspectId),
            status,
            stop,
            skip,
            next_step: stored(
                u8::try_from(self.next_step).ok(),
                "outreach_enrollments.next_step",
            )?,
            next_send_at: self.next_send_at,
            personalization,
            basis: self
                .basis
                .map(|b| stored(basis_of(&b), "outreach_enrollments.basis"))
                .transpose()?,
            enrolled_at: self.enrolled_at,
            stopped_at: self.stopped_at,
            last_sent_at: self.last_sent_at,
        })
    }
}

impl PgTenantRepos {
    /// Inserts the row unless it conflicts with a unique key; whether it did.
    async fn insert_enrollment(&mut self, e: &EnrollmentRow) -> Result<bool, AppError> {
        let done = sqlx::query(
            "insert into outreach_enrollments (workspace_id, id, campaign_id, person_id, \
             journey_id, prospect_id, status, reason, next_step, next_send_at, personalization, \
             basis, enrolled_at, stopped_at, last_sent_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
             on conflict do nothing",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(e.id.as_uuid())
        .bind(e.campaign_id.as_uuid())
        .bind(e.person_id.as_uuid())
        .bind(e.journey_id.map(|j| j.as_uuid()))
        .bind(e.prospect_id.map(|p| p.as_uuid()))
        .bind(e.status.key())
        .bind(enrollment_reason(e))
        .bind(i16::from(e.next_step))
        .bind(e.next_send_at)
        .bind(encode(&e.personalization, "personalization")?)
        .bind(e.basis.map(CommercialBasis::key))
        .bind(e.enrolled_at)
        .bind(e.stopped_at)
        .bind(e.last_sent_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert outreach enrollment"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn enrolled(&mut self, campaign: CampaignId, person: PersonId) -> Result<bool, AppError> {
        sqlx::query_scalar(
            "select exists(select 1 from outreach_enrollments where workspace_id = $1 \
             and campaign_id = $2 and person_id = $3)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(campaign.as_uuid())
        .bind(person.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read enrollment"))
    }

    async fn enrollments_where(
        &mut self,
        condition: &str,
        bind: Uuid,
    ) -> Result<Vec<EnrollmentRow>, AppError> {
        let sql = format!(
            "select {ENROLLMENT_COLUMNS} from outreach_enrollments where workspace_id = $1 \
             and {condition}"
        );
        let rows: Vec<EnrollmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(bind)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read enrollments"))?;
        rows.into_iter().map(EnrollmentRecord::into_row).collect()
    }

    /// Stops the active enrollments `condition` (over `$2`) selects; how many.
    async fn stop_where(
        &mut self,
        condition: &str,
        bind: Uuid,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        let key = reason.key();
        if key.chars().count() > 100 {
            return Err(AppError::internal(
                "a stop reason is longer than its column",
            ));
        }
        let done = sqlx::query(&format!(
            "update outreach_enrollments set status = 'stopped', reason = $3, stopped_at = $4, \
             next_send_at = null where workspace_id = $1 and status = 'active' and {condition}"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(bind)
        .bind(key)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "stop enrollments"))?;
        Ok(count(
            i64::try_from(done.rows_affected()).unwrap_or(i64::MAX),
        ))
    }
}

#[async_trait]
impl EnrollmentRepo for PgTenantRepos {
    async fn insert_many(&mut self, rows: &[EnrollmentRow]) -> Result<InsertReport, AppError> {
        if rows.len() > MAX_ENROLLMENT_BATCH || !rows.iter().all(enrollment_row_valid) {
            return Err(AppError::internal("an enrollment batch breaks its checks"));
        }
        let mut report = InsertReport::default();
        for row in rows {
            if self.insert_enrollment(row).await? {
                report.inserted.push(row.id);
                continue;
            }
            if self.enrolled(row.campaign_id, row.person_id).await? {
                report.already_enrolled.push(row.person_id);
                continue;
            }
            if row.status != EnrollmentStatus::Active {
                return Err(AppError::conflict("the enrollment id is already taken"));
            }
            // The person is active in another campaign (or earlier in this batch).
            let skipped = EnrollmentRow {
                status: EnrollmentStatus::Skipped,
                skip: Some(SkipReason::ActiveElsewhere),
                stop: None,
                next_send_at: None,
                basis: None,
                ..row.clone()
            };
            if self.insert_enrollment(&skipped).await? {
                report.active_elsewhere.push(row.id);
            } else {
                report.already_enrolled.push(row.person_id);
            }
        }
        Ok(report)
    }

    async fn get(&mut self, id: EnrollmentId) -> Result<Option<EnrollmentRow>, AppError> {
        Ok(self.enrollments_where("id = $2", id.as_uuid()).await?.pop())
    }

    async fn due(
        &mut self,
        campaign: CampaignId,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<EnrollmentRow>, AppError> {
        let sql = format!(
            "with due as materialized ( \
                 select id from outreach_enrollments where workspace_id = $1 and campaign_id = $2 \
                 and status = 'active' and next_send_at <= $3 \
                 order by next_send_at, id limit $4 for update skip locked) \
             select {ENROLLMENT_COLUMNS} from outreach_enrollments e \
             where e.workspace_id = $1 and e.id in (select id from due) \
             order by e.next_send_at, e.id"
        );
        let rows: Vec<EnrollmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(campaign.as_uuid())
            .bind(now)
            .bind(i64::from(page_limit(limit)))
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list due enrollments"))?;
        rows.into_iter().map(EnrollmentRecord::into_row).collect()
    }

    async fn advance(
        &mut self,
        id: EnrollmentId,
        next_step: u8,
        next_send_at: Option<OffsetDateTime>,
        sent_at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        if !(1..=7).contains(&next_step) {
            return Err(AppError::internal("an enrollment's next step is 1 to 7"));
        }
        let done = sqlx::query(
            "update outreach_enrollments set next_step = $3, next_send_at = $4, \
             last_sent_at = $5, \
             status = case when $4::timestamptz is null then 'completed' else 'active' end \
             where workspace_id = $1 and id = $2 and status = 'active'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(i16::from(next_step))
        .bind(next_send_at)
        .bind(sent_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "advance enrollment"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn postpone(
        &mut self,
        id: EnrollmentId,
        until: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update outreach_enrollments set next_send_at = $3 \
             where workspace_id = $1 and id = $2 and status = 'active'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(until)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "postpone enrollment"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn stop(
        &mut self,
        id: EnrollmentId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        Ok(self.stop_where("id = $2", id.as_uuid(), reason, at).await? == 1)
    }

    async fn stop_all_for(
        &mut self,
        person: PersonId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.stop_where("person_id = $2", person.as_uuid(), reason, at)
            .await
    }

    async fn stop_campaign(
        &mut self,
        campaign: CampaignId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.stop_where("campaign_id = $2", campaign.as_uuid(), reason, at)
            .await
    }

    async fn active_for(&mut self, person: PersonId) -> Result<Option<EnrollmentRow>, AppError> {
        Ok(self
            .enrollments_where("person_id = $2 and status = 'active'", person.as_uuid())
            .await?
            .pop())
    }

    async fn personalize(
        &mut self,
        id: EnrollmentId,
        values: &BTreeMap<String, String>,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update outreach_enrollments set personalization = $3 \
             where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(encode(values, "personalization")?)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "personalize enrollment"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn list(
        &mut self,
        campaign: CampaignId,
        q: &EnrollmentQuery,
    ) -> Result<EnrollmentPage, AppError> {
        let limit = page_limit(q.limit);
        let sql = format!(
            "select {ENROLLMENT_COLUMNS} from outreach_enrollments where workspace_id = $1 \
             and campaign_id = $2 and ($3::text is null or status = $3) \
             and ($4::uuid is null or id > $4) order by id limit $5"
        );
        let rows: Vec<EnrollmentRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(campaign.as_uuid())
            .bind(q.status.map(EnrollmentStatus::key))
            .bind(q.after.map(|a| a.as_uuid()))
            .bind(i64::from(limit) + 1)
            .fetch_all(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "list enrollments"))?;
        let mut items = rows
            .into_iter()
            .map(EnrollmentRecord::into_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|r| r.id)
        } else {
            None
        };
        Ok(EnrollmentPage { items, next })
    }

    async fn count_active(&mut self, campaign: CampaignId) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(
            "select count(*) from outreach_enrollments where workspace_id = $1 \
             and campaign_id = $2 and status = 'active'",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(campaign.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count active enrollments"))?;
        Ok(count(n))
    }
}

// ---- sends ----

const SEND_COLUMNS: &str = "s.id, s.enrollment_id, s.campaign_id, s.mailbox_id, s.step, \
                            s.outbox_id, s.message_id, s.recipient_domain, s.outcome, \
                            s.created_at, s.sent_at, s.replied_at, s.replied_threaded, \
                            s.first_clicked_at, s.clicks, s.automated_clicks, s.unsubscribed_at";

#[derive(sqlx::FromRow)]
struct SendRecord {
    id: Uuid,
    enrollment_id: Uuid,
    campaign_id: Uuid,
    mailbox_id: Uuid,
    step: i16,
    outbox_id: Uuid,
    message_id: Uuid,
    recipient_domain: String,
    outcome: String,
    created_at: OffsetDateTime,
    sent_at: Option<OffsetDateTime>,
    replied_at: Option<OffsetDateTime>,
    replied_threaded: Option<bool>,
    first_clicked_at: Option<OffsetDateTime>,
    clicks: i32,
    automated_clicks: i32,
    unsubscribed_at: Option<OffsetDateTime>,
}

impl SendRecord {
    fn into_row(self) -> Result<SendRow, AppError> {
        Ok(SendRow {
            id: SendId(self.id),
            enrollment_id: EnrollmentId(self.enrollment_id),
            campaign_id: CampaignId(self.campaign_id),
            mailbox_id: CapabilityId(self.mailbox_id),
            step: stored(u8::try_from(self.step).ok(), "outreach_sends.step")?,
            outbox_id: self.outbox_id,
            message_id: MessageId(self.message_id),
            recipient_domain: self.recipient_domain,
            outcome: stored(SendOutcome::parse(&self.outcome), "outreach_sends.outcome")?,
            created_at: self.created_at,
            sent_at: self.sent_at,
            replied_at: self.replied_at,
            replied_threaded: self.replied_threaded,
            first_clicked_at: self.first_clicked_at,
            clicks: u32::try_from(self.clicks).unwrap_or(0),
            automated_clicks: u32::try_from(self.automated_clicks).unwrap_or(0),
            unsubscribed_at: self.unsubscribed_at,
        })
    }
}

impl PgTenantRepos {
    async fn send_where(
        &mut self,
        condition: &str,
        bind: Uuid,
    ) -> Result<Option<SendRow>, AppError> {
        let sql = format!(
            "select {SEND_COLUMNS} from outreach_sends s where s.workspace_id = $1 and {condition}"
        );
        let row: Option<SendRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(bind)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read outreach send"))?;
        row.map(SendRecord::into_row).transpose()
    }

    /// Counts the sends (not refused) `condition` selects over `$2` and the time `$3`.
    async fn count_sends(
        &mut self,
        condition: &str,
        bind: Uuid,
        since: OffsetDateTime,
        domain: Option<&str>,
    ) -> Result<u32, AppError> {
        let n: i64 = sqlx::query_scalar(&format!(
            "select count(*) from outreach_sends where workspace_id = $1 and {condition} \
             and created_at >= $3 and outcome <> 'refused' \
             and ($4::text is null or recipient_domain = $4)"
        ))
        .bind(self.workspace_id().as_uuid())
        .bind(bind)
        .bind(since)
        .bind(domain)
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count outreach sends"))?;
        Ok(count(n))
    }
}

#[derive(sqlx::FromRow)]
struct CountsRecord {
    campaign_id: Uuid,
    step: i16,
    sends: i64,
    sent: i64,
    failed: i64,
    unknown: i64,
    refused: i64,
    bounced: i64,
    complained: i64,
    replied: i64,
    replied_threaded: i64,
    unsubscribed: i64,
    clicked: i64,
    clicks: i64,
    automated_clicks: i64,
}

#[async_trait]
impl OutreachSendRepo for PgTenantRepos {
    async fn insert(&mut self, row: &SendRow) -> Result<(), AppError> {
        let known: bool = sqlx::query_scalar(
            "select exists(select 1 from outreach_enrollments where workspace_id = $1 and id = $2 \
                 and campaign_id = $3) \
             and exists(select 1 from messages where workspace_id = $1 and id = $4)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.enrollment_id.as_uuid())
        .bind(row.campaign_id.as_uuid())
        .bind(row.message_id.as_uuid())
        .fetch_one(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read send references"))?;
        if !known {
            return Err(AppError::not_found("no such enrollment or message"));
        }
        sqlx::query(
            "insert into outreach_sends (workspace_id, id, enrollment_id, campaign_id, \
             mailbox_id, step, outbox_id, message_id, recipient_domain, outcome, created_at, \
             sent_at, replied_at, replied_threaded, first_clicked_at, clicks, automated_clicks, \
             unsubscribed_at) \
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(row.id.as_uuid())
        .bind(row.enrollment_id.as_uuid())
        .bind(row.campaign_id.as_uuid())
        .bind(row.mailbox_id.as_uuid())
        .bind(i16::from(row.step))
        .bind(row.outbox_id)
        .bind(row.message_id.as_uuid())
        .bind(&row.recipient_domain)
        .bind(row.outcome.key())
        .bind(row.created_at)
        .bind(row.sent_at)
        .bind(row.replied_at)
        .bind(row.replied_threaded)
        .bind(row.first_clicked_at)
        .bind(i32::try_from(row.clicks).unwrap_or(i32::MAX))
        .bind(i32::try_from(row.automated_clicks).unwrap_or(i32::MAX))
        .bind(row.unsubscribed_at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "insert outreach send"))?;
        Ok(())
    }

    async fn get(&mut self, id: SendId) -> Result<Option<SendRow>, AppError> {
        self.send_where("s.id = $2", id.as_uuid()).await
    }

    async fn by_outbox(&mut self, outbox: Uuid) -> Result<Option<SendRow>, AppError> {
        self.send_where("s.outbox_id = $2", outbox).await
    }

    async fn set_outcome(
        &mut self,
        id: SendId,
        outcome: SendOutcome,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update outreach_sends set outcome = $3, \
             sent_at = case when $3 = 'sent' then coalesce(sent_at, $4) else sent_at end \
             where workspace_id = $1 and id = $2 and outcome = any($5)",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(outcome.key())
        .bind(at)
        .bind(from_outcomes(outcome))
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "set send outcome"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn mark_replied(
        &mut self,
        id: SendId,
        threaded: bool,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update outreach_sends set replied_at = $3, replied_threaded = $4 \
             where workspace_id = $1 and id = $2 and replied_at is null",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .bind(threaded)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "mark send replied"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn latest_for_person(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Option<SendRow>, AppError> {
        let sql = format!(
            "select {SEND_COLUMNS} from outreach_sends s join outreach_enrollments e \
             on e.workspace_id = s.workspace_id and e.id = s.enrollment_id \
             where s.workspace_id = $1 and e.person_id = $2 and s.created_at >= $3 \
             and s.outcome <> 'refused' order by s.created_at desc, s.id desc limit 1"
        );
        let row: Option<SendRecord> = sqlx::query_as(&sql)
            .bind(self.workspace_id().as_uuid())
            .bind(person.as_uuid())
            .bind(since)
            .fetch_optional(self.tx.conn())
            .await
            .map_err(|e| map_sqlx(e, "read a person's latest send"))?;
        row.map(SendRecord::into_row).transpose()
    }

    async fn click(
        &mut self,
        id: SendId,
        automated: bool,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        let done = sqlx::query(
            "update outreach_sends set \
             clicks = clicks + case when $3 then 0 else 1 end, \
             automated_clicks = automated_clicks + case when $3 then 1 else 0 end, \
             first_clicked_at = case when not $3 and first_clicked_at is null then $4 \
                                else first_clicked_at end \
             where workspace_id = $1 and id = $2",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(automated)
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count a click"))?;
        if done.rows_affected() == 1 {
            Ok(())
        } else {
            Err(AppError::not_found("no such outreach send"))
        }
    }

    async fn unsubscribed(&mut self, id: SendId, at: OffsetDateTime) -> Result<bool, AppError> {
        let done = sqlx::query(
            "update outreach_sends set unsubscribed_at = $3 \
             where workspace_id = $1 and id = $2 and unsubscribed_at is null",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(id.as_uuid())
        .bind(at)
        .execute(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "record unsubscribe"))?;
        Ok(done.rows_affected() == 1)
    }

    async fn count_mailbox_since(
        &mut self,
        mailbox: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.count_sends("mailbox_id = $2", mailbox.as_uuid(), since, None)
            .await
    }

    async fn count_campaign_since(
        &mut self,
        campaign: CampaignId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.count_sends("campaign_id = $2", campaign.as_uuid(), since, None)
            .await
    }

    async fn count_domain_since(
        &mut self,
        mailbox: CapabilityId,
        domain: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.count_sends("mailbox_id = $2", mailbox.as_uuid(), since, Some(domain))
            .await
    }

    async fn person_send_times(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Vec<OffsetDateTime>, AppError> {
        sqlx::query_scalar(
            "select s.created_at from outreach_sends s join outreach_enrollments e \
             on e.workspace_id = s.workspace_id and e.id = s.enrollment_id \
             where s.workspace_id = $1 and e.person_id = $2 and s.created_at >= $3 \
             and s.outcome <> 'refused' order by s.created_at, s.id",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(person.as_uuid())
        .bind(since)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read a person's send times"))
    }

    async fn recent_outcomes(
        &mut self,
        campaign: CampaignId,
        n: u32,
    ) -> Result<Vec<SendOutcome>, AppError> {
        let keys: Vec<String> = sqlx::query_scalar(
            "select outcome from outreach_sends where workspace_id = $1 and campaign_id = $2 \
             order by created_at desc, id desc limit $3",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(campaign.as_uuid())
        .bind(i64::from(n))
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "read recent outcomes"))?;
        keys.iter()
            .map(|k| stored(SendOutcome::parse(k), "outreach_sends.outcome"))
            .collect()
    }

    async fn report(&mut self, q: &ReportQuery) -> Result<Vec<StepCounts>, AppError> {
        let rows: Vec<CountsRecord> = sqlx::query_as(
            "select campaign_id, step, count(*) as sends, \
             count(*) filter (where outcome = 'sent') as sent, \
             count(*) filter (where outcome = 'failed') as failed, \
             count(*) filter (where outcome = 'unknown') as unknown, \
             count(*) filter (where outcome = 'refused') as refused, \
             count(*) filter (where outcome = 'bounced') as bounced, \
             count(*) filter (where outcome = 'complained') as complained, \
             count(*) filter (where replied_at is not null) as replied, \
             count(*) filter (where replied_threaded) as replied_threaded, \
             count(*) filter (where unsubscribed_at is not null) as unsubscribed, \
             count(*) filter (where first_clicked_at is not null) as clicked, \
             coalesce(sum(clicks), 0)::bigint as clicks, \
             coalesce(sum(automated_clicks), 0)::bigint as automated_clicks \
             from outreach_sends where workspace_id = $1 \
             and ($2::uuid is null or campaign_id = $2) and created_at >= $3 and created_at < $4 \
             group by campaign_id, step order by campaign_id, step",
        )
        .bind(self.workspace_id().as_uuid())
        .bind(q.campaign_id.map(|c| c.as_uuid()))
        .bind(q.from)
        .bind(q.to)
        .fetch_all(self.tx.conn())
        .await
        .map_err(|e| map_sqlx(e, "count outreach sends by step"))?;
        rows.into_iter()
            .map(|r| {
                Ok(StepCounts {
                    campaign_id: CampaignId(r.campaign_id),
                    step: stored(u8::try_from(r.step).ok(), "outreach_sends.step")?,
                    sends: count(r.sends),
                    sent: count(r.sent),
                    failed: count(r.failed),
                    unknown: count(r.unknown),
                    refused: count(r.refused),
                    bounced: count(r.bounced),
                    complained: count(r.complained),
                    replied: count(r.replied),
                    replied_threaded: count(r.replied_threaded),
                    unsubscribed: count(r.unsubscribed),
                    clicked: count(r.clicked),
                    clicks: count(r.clicks),
                    automated_clicks: count(r.automated_clicks),
                })
            })
            .collect()
    }
}
