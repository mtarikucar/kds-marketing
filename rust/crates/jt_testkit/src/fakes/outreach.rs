//! The in-memory outreach templates, campaigns, enrollments and sends, with the constraints
//! migration `0022_outreach` enforces: ids unique; a campaign names a capability and a strategy
//! version of the bundle's workspace and keeps its checks (`campaign_row_valid`); an enrollment
//! names a campaign, a person, and optionally a journey and a prospect of the workspace, keeps its
//! checks (`enrollment_row_valid`), is one per campaign and person and, while active, one per
//! person; a send names an enrollment of its campaign and a message, one per outbox entry. Every
//! count is computed from the rows. Row locks are not modelled (`due` skips nothing): races are
//! tested on PostgreSQL.

use std::collections::BTreeMap;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::outreach::{
    CampaignCursor, CampaignPage, CampaignQuery, CampaignRepo, CampaignRow, EnrollmentPage,
    EnrollmentQuery, EnrollmentRepo, EnrollmentRow, InsertReport, MAX_ENROLLMENT_BATCH,
    MAX_OUTREACH_PAGE, OutreachSendRepo, ReportQuery, SendRow, StepCounts, TemplateCursor,
    TemplatePage, TemplateQuery, TemplateRepo, TemplateRow, campaign_row_valid,
    enrollment_row_valid,
};
use jt_capability::CapabilityId;
use jt_inbox::PersonId;
use jt_outreach::{
    CampaignId, CampaignStatus, EnrollmentId, EnrollmentStatus, SendId, SendOutcome, SkipReason,
    StopReason, TemplateId,
};
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::state::{MemBundle, MemState, dangling, unique};
use super::tenant::MemTenant;

/// Outreach's tables, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemOutreach {
    pub templates: Vec<(WorkspaceId, TemplateRow)>,
    pub campaigns: Vec<(WorkspaceId, CampaignRow)>,
    pub enrollments: Vec<(WorkspaceId, EnrollmentRow)>,
    pub sends: Vec<(WorkspaceId, SendRow)>,
}

fn limit_of(limit: u32) -> usize {
    limit.clamp(1, MAX_OUTREACH_PAGE) as usize
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl MemTenant {
    fn outreach(&self) -> &MemOutreach {
        &self.state().outreach
    }

    fn own<'a, T>(&self, rows: &'a [(WorkspaceId, T)]) -> impl Iterator<Item = &'a T> + use<'a, T> {
        let ws = self.ws;
        rows.iter().filter(move |(w, _)| *w == ws).map(|(_, r)| r)
    }

    fn enrollment_of(&self, id: EnrollmentId) -> Option<&EnrollmentRow> {
        self.own(&self.outreach().enrollments).find(|e| e.id == id)
    }

    /// The person's enrollments' ids.
    fn enrollments_of(&self, person: PersonId) -> Vec<EnrollmentId> {
        self.own(&self.outreach().enrollments)
            .filter(|e| e.person_id == person)
            .map(|e| e.id)
            .collect()
    }

    /// Sends (not refused) `keep` selects, created at `since` or later.
    fn counted_sends(
        &self,
        since: OffsetDateTime,
        keep: impl Fn(&SendRow) -> bool,
    ) -> Vec<&SendRow> {
        self.own(&self.outreach().sends)
            .filter(|s| s.outcome != SendOutcome::Refused && s.created_at >= since && keep(s))
            .collect()
    }

    /// Applies `change` to the enrollment `id` (here and on commit).
    fn change_enrollment(
        &mut self,
        id: EnrollmentId,
        change: impl Fn(&mut EnrollmentRow) + Send + Sync + 'static,
    ) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            if let Some((_, e)) = s
                .outreach
                .enrollments
                .iter_mut()
                .find(|(w, e)| *w == ws && e.id == id)
            {
                change(e);
            }
        });
    }

    /// Applies `change` to the send `id` (here and on commit).
    fn change_send(&mut self, id: SendId, change: impl Fn(&mut SendRow) + Send + Sync + 'static) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            if let Some((_, r)) = s
                .outreach
                .sends
                .iter_mut()
                .find(|(w, r)| *w == ws && r.id == id)
            {
                change(r);
            }
        });
    }

    fn stop_matching(
        &mut self,
        select: impl Fn(&EnrollmentRow) -> bool,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        if reason.key().chars().count() > 100 {
            return Err(AppError::internal(
                "a stop reason is longer than its column",
            ));
        }
        let ids: Vec<EnrollmentId> = self
            .own(&self.outreach().enrollments)
            .filter(|e| e.status == EnrollmentStatus::Active && select(e))
            .map(|e| e.id)
            .collect();
        for id in &ids {
            let reason = reason.clone();
            self.change_enrollment(*id, move |e| {
                e.status = EnrollmentStatus::Stopped;
                e.stop = Some(reason.clone());
                e.stopped_at = Some(at);
                e.next_send_at = None;
            });
        }
        Ok(count(ids.len()))
    }

    fn insert_enrollment_row(&mut self, row: EnrollmentRow) {
        let ws = self.ws;
        self.tx
            .write(move |s| s.outreach.enrollments.push((ws, row.clone())));
    }
}

#[async_trait]
impl TemplateRepo for MemTenant {
    async fn insert(&mut self, row: &TemplateRow) -> Result<(), AppError> {
        self.call(|t| {
            unique(
                !t.outreach()
                    .templates
                    .iter()
                    .any(|(_, r)| r.template.id == row.template.id),
                "the template id is already taken",
            )?;
            let ws = t.ws;
            let row = row.clone();
            t.tx.write(move |s| s.outreach.templates.push((ws, row.clone())));
            Ok(())
        })
    }

    async fn get(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError> {
        Ok(self
            .own(&self.outreach().templates)
            .find(|r| r.template.id == id)
            .cloned())
    }

    async fn lock(&mut self, id: TemplateId) -> Result<Option<TemplateRow>, AppError> {
        TemplateRepo::get(self, id).await
    }

    async fn update(
        &mut self,
        row: &TemplateRow,
        expected_revision: u32,
    ) -> Result<bool, AppError> {
        let ws = self.ws;
        let current = self
            .own(&self.outreach().templates)
            .any(|r| r.template.id == row.template.id && r.template.revision == expected_revision);
        if current {
            let row = row.clone();
            self.tx.write(move |s| {
                if let Some((_, r)) = s
                    .outreach
                    .templates
                    .iter_mut()
                    .find(|(w, r)| *w == ws && r.template.id == row.template.id)
                {
                    *r = TemplateRow {
                        created_by: r.created_by.clone(),
                        ..row.clone()
                    };
                }
            });
        }
        Ok(current)
    }

    async fn list(&mut self, q: &TemplateQuery) -> Result<TemplatePage, AppError> {
        let limit = limit_of(q.limit);
        let mut rows: Vec<TemplateRow> = self
            .own(&self.outreach().templates)
            .filter(|r| q.include_archived || !r.template.archived)
            .filter(|r| {
                q.before
                    .is_none_or(|c| (r.updated_at, r.template.id) < (c.updated_at, c.id))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse((r.updated_at, r.template.id)));
        let next = (rows.len() > limit).then(|| TemplateCursor {
            updated_at: rows[limit - 1].updated_at,
            id: rows[limit - 1].template.id,
        });
        rows.truncate(limit);
        Ok(TemplatePage { items: rows, next })
    }
}

#[async_trait]
impl CampaignRepo for MemTenant {
    async fn insert(&mut self, row: &CampaignRow) -> Result<(), AppError> {
        self.call(|t| {
            if !campaign_row_valid(row) {
                return Err(AppError::internal("a campaign breaks its checks"));
            }
            let ws = t.ws;
            let mailbox = t
                .state()
                .capabilities
                .iter()
                .any(|c| c.capability.workspace_id == ws && c.capability.id == row.mailbox_id);
            if !mailbox {
                return Err(AppError::not_found("no such mailbox"));
            }
            let version = t
                .state()
                .strategy_versions
                .iter()
                .any(|v| v.workspace_id == ws && v.id == row.strategy_version_id);
            if !version {
                return Err(AppError::not_found("no such strategy version"));
            }
            unique(
                !t.outreach().campaigns.iter().any(|(_, c)| c.id == row.id),
                "the campaign id is already taken",
            )?;
            let row = row.clone();
            t.tx.write(move |s| s.outreach.campaigns.push((ws, row.clone())));
            Ok(())
        })
    }

    async fn get(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError> {
        Ok(self
            .own(&self.outreach().campaigns)
            .find(|c| c.id == id)
            .cloned())
    }

    async fn lock(&mut self, id: CampaignId) -> Result<Option<CampaignRow>, AppError> {
        CampaignRepo::get(self, id).await
    }

    async fn update(
        &mut self,
        row: &CampaignRow,
        expected_revision: u32,
    ) -> Result<bool, AppError> {
        self.call(|t| {
            if !campaign_row_valid(row) {
                return Err(AppError::internal("a campaign breaks its checks"));
            }
            let ws = t.ws;
            let current = t
                .own(&t.outreach().campaigns)
                .any(|c| c.id == row.id && c.revision == expected_revision);
            if current {
                let mailbox =
                    t.state().capabilities.iter().any(|c| {
                        c.capability.workspace_id == ws && c.capability.id == row.mailbox_id
                    });
                if !mailbox {
                    return Err(dangling("outreach_campaigns.mailbox_id"));
                }
                let row = row.clone();
                t.tx.write(move |s| {
                    if let Some((_, c)) = s
                        .outreach
                        .campaigns
                        .iter_mut()
                        .find(|(w, c)| *w == ws && c.id == row.id)
                    {
                        *c = CampaignRow {
                            created_by: c.created_by.clone(),
                            created_at: c.created_at,
                            strategy_version_id: c.strategy_version_id,
                            ..row.clone()
                        };
                    }
                });
            }
            Ok(current)
        })
    }

    async fn list(&mut self, q: &CampaignQuery) -> Result<CampaignPage, AppError> {
        let limit = limit_of(q.limit);
        let mut rows: Vec<CampaignRow> = self
            .own(&self.outreach().campaigns)
            .filter(|c| q.status.is_none_or(|s| c.status == s))
            .filter(|c| {
                q.before
                    .is_none_or(|b| (c.created_at, c.id) < (b.created_at, b.id))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|c| std::cmp::Reverse((c.created_at, c.id)));
        let next = (rows.len() > limit).then(|| CampaignCursor {
            created_at: rows[limit - 1].created_at,
            id: rows[limit - 1].id,
        });
        rows.truncate(limit);
        Ok(CampaignPage { items: rows, next })
    }

    async fn by_status(
        &mut self,
        status: CampaignStatus,
        limit: u32,
    ) -> Result<Vec<CampaignRow>, AppError> {
        let mut rows: Vec<CampaignRow> = self
            .own(&self.outreach().campaigns)
            .filter(|c| c.status == status)
            .cloned()
            .collect();
        // Oldest launch first, unlaunched ones last.
        rows.sort_by_key(|c| (c.launched_at.is_none(), c.launched_at, c.created_at, c.id));
        rows.truncate(limit_of(limit));
        Ok(rows)
    }
}

#[async_trait]
impl EnrollmentRepo for MemTenant {
    async fn insert_many(&mut self, rows: &[EnrollmentRow]) -> Result<InsertReport, AppError> {
        self.call(|t| {
            if rows.len() > MAX_ENROLLMENT_BATCH || !rows.iter().all(enrollment_row_valid) {
                return Err(AppError::internal("an enrollment batch breaks its checks"));
            }
            let ws = t.ws;
            for row in rows {
                if !t
                    .own(&t.outreach().campaigns)
                    .any(|c| c.id == row.campaign_id)
                {
                    return Err(dangling("outreach_enrollments.campaign_id"));
                }
                let inbox = &t.state().inbox;
                if !inbox
                    .people
                    .iter()
                    .any(|p| p.workspace_id == ws && p.id == row.person_id)
                {
                    return Err(dangling("outreach_enrollments.person_id"));
                }
                if let Some(j) = row.journey_id
                    && !inbox
                        .journeys
                        .iter()
                        .any(|x| x.workspace_id == ws && x.id == j)
                {
                    return Err(dangling("outreach_enrollments.journey_id"));
                }
                if let Some(p) = row.prospect_id
                    && !t
                        .state()
                        .prospects
                        .prospects
                        .iter()
                        .any(|x| x.workspace_id == ws && x.id == p)
                {
                    return Err(dangling("outreach_enrollments.prospect_id"));
                }
            }
            let mut report = InsertReport::default();
            for row in rows {
                let enrolled = t
                    .own(&t.outreach().enrollments)
                    .any(|e| e.campaign_id == row.campaign_id && e.person_id == row.person_id);
                if enrolled {
                    report.already_enrolled.push(row.person_id);
                    continue;
                }
                unique(
                    !t.outreach().enrollments.iter().any(|(_, e)| e.id == row.id),
                    "the enrollment id is already taken",
                )?;
                let active_elsewhere = row.status == EnrollmentStatus::Active
                    && t.own(&t.outreach().enrollments).any(|e| {
                        e.person_id == row.person_id && e.status == EnrollmentStatus::Active
                    });
                if active_elsewhere {
                    t.insert_enrollment_row(EnrollmentRow {
                        status: EnrollmentStatus::Skipped,
                        skip: Some(SkipReason::ActiveElsewhere),
                        stop: None,
                        next_send_at: None,
                        basis: None,
                        ..row.clone()
                    });
                    report.active_elsewhere.push(row.id);
                } else {
                    t.insert_enrollment_row(row.clone());
                    report.inserted.push(row.id);
                }
            }
            Ok(report)
        })
    }

    async fn get(&mut self, id: EnrollmentId) -> Result<Option<EnrollmentRow>, AppError> {
        Ok(self.enrollment_of(id).cloned())
    }

    async fn due(
        &mut self,
        campaign: CampaignId,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<EnrollmentRow>, AppError> {
        let mut rows: Vec<EnrollmentRow> = self
            .own(&self.outreach().enrollments)
            .filter(|e| {
                e.campaign_id == campaign
                    && e.status == EnrollmentStatus::Active
                    && e.next_send_at.is_some_and(|at| at <= now)
            })
            .cloned()
            .collect();
        rows.sort_by_key(|e| (e.next_send_at, e.id));
        rows.truncate(limit_of(limit));
        Ok(rows)
    }

    async fn advance(
        &mut self,
        id: EnrollmentId,
        next_step: u8,
        next_send_at: Option<OffsetDateTime>,
        sent_at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        self.call(|t| {
            if !(1..=7).contains(&next_step) {
                return Err(AppError::internal("an enrollment's next step is 1 to 7"));
            }
            let active = t
                .enrollment_of(id)
                .is_some_and(|e| e.status == EnrollmentStatus::Active);
            if active {
                t.change_enrollment(id, move |e| {
                    e.next_step = next_step;
                    e.next_send_at = next_send_at;
                    e.last_sent_at = Some(sent_at);
                    if next_send_at.is_none() {
                        e.status = EnrollmentStatus::Completed;
                    }
                });
            }
            Ok(active)
        })
    }

    async fn postpone(
        &mut self,
        id: EnrollmentId,
        until: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let active = self
            .enrollment_of(id)
            .is_some_and(|e| e.status == EnrollmentStatus::Active);
        if active {
            self.change_enrollment(id, move |e| e.next_send_at = Some(until));
        }
        Ok(active)
    }

    async fn stop(
        &mut self,
        id: EnrollmentId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        self.call(|t| Ok(t.stop_matching(|e| e.id == id, reason, at)? == 1))
    }

    async fn stop_all_for(
        &mut self,
        person: PersonId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.call(|t| t.stop_matching(|e| e.person_id == person, reason, at))
    }

    async fn stop_campaign(
        &mut self,
        campaign: CampaignId,
        reason: &StopReason,
        at: OffsetDateTime,
    ) -> Result<u32, AppError> {
        self.call(|t| t.stop_matching(|e| e.campaign_id == campaign, reason, at))
    }

    async fn active_for(&mut self, person: PersonId) -> Result<Option<EnrollmentRow>, AppError> {
        Ok(self
            .own(&self.outreach().enrollments)
            .find(|e| e.person_id == person && e.status == EnrollmentStatus::Active)
            .cloned())
    }

    async fn personalize(
        &mut self,
        id: EnrollmentId,
        values: &BTreeMap<String, String>,
    ) -> Result<bool, AppError> {
        let found = self.enrollment_of(id).is_some();
        if found {
            let values = values.clone();
            self.change_enrollment(id, move |e| e.personalization = values.clone());
        }
        Ok(found)
    }

    async fn list(
        &mut self,
        campaign: CampaignId,
        q: &EnrollmentQuery,
    ) -> Result<EnrollmentPage, AppError> {
        let limit = limit_of(q.limit);
        let mut rows: Vec<EnrollmentRow> = self
            .own(&self.outreach().enrollments)
            .filter(|e| e.campaign_id == campaign)
            .filter(|e| q.status.is_none_or(|s| e.status == s))
            .filter(|e| q.after.is_none_or(|a| e.id > a))
            .cloned()
            .collect();
        rows.sort_by_key(|e| e.id);
        let next = (rows.len() > limit).then(|| rows[limit - 1].id);
        rows.truncate(limit);
        Ok(EnrollmentPage { items: rows, next })
    }

    async fn count_active(&mut self, campaign: CampaignId) -> Result<u32, AppError> {
        Ok(count(
            self.own(&self.outreach().enrollments)
                .filter(|e| e.campaign_id == campaign && e.status == EnrollmentStatus::Active)
                .count(),
        ))
    }
}

#[async_trait]
impl OutreachSendRepo for MemTenant {
    async fn insert(&mut self, row: &SendRow) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            let enrollment = t
                .enrollment_of(row.enrollment_id)
                .is_some_and(|e| e.campaign_id == row.campaign_id);
            let message = t
                .state()
                .inbox
                .messages
                .iter()
                .any(|m| m.workspace_id == ws && m.id == row.message_id);
            if !enrollment || !message {
                return Err(AppError::not_found("no such enrollment or message"));
            }
            if !(1..=6).contains(&row.step) || row.recipient_domain.is_empty() {
                return Err(AppError::internal("a send breaks its checks"));
            }
            unique(
                !t.outreach()
                    .sends
                    .iter()
                    .any(|(w, s)| s.id == row.id || (*w == ws && s.outbox_id == row.outbox_id)),
                "the send id or its outbox entry is already taken",
            )?;
            let row = row.clone();
            t.tx.write(move |s| s.outreach.sends.push((ws, row.clone())));
            Ok(())
        })
    }

    async fn get(&mut self, id: SendId) -> Result<Option<SendRow>, AppError> {
        Ok(self
            .own(&self.outreach().sends)
            .find(|s| s.id == id)
            .cloned())
    }

    async fn by_outbox(&mut self, outbox: Uuid) -> Result<Option<SendRow>, AppError> {
        Ok(self
            .own(&self.outreach().sends)
            .find(|s| s.outbox_id == outbox)
            .cloned())
    }

    async fn set_outcome(
        &mut self,
        id: SendId,
        outcome: SendOutcome,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let moves = self
            .own(&self.outreach().sends)
            .any(|s| s.id == id && s.outcome.can_become(outcome));
        if moves {
            self.change_send(id, move |s| {
                s.outcome = outcome;
                if outcome == SendOutcome::Sent && s.sent_at.is_none() {
                    s.sent_at = Some(at);
                }
            });
        }
        Ok(moves)
    }

    async fn mark_replied(
        &mut self,
        id: SendId,
        threaded: bool,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let first = self
            .own(&self.outreach().sends)
            .any(|s| s.id == id && s.replied_at.is_none());
        if first {
            self.change_send(id, move |s| {
                s.replied_at = Some(at);
                s.replied_threaded = Some(threaded);
            });
        }
        Ok(first)
    }

    async fn latest_for_person(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Option<SendRow>, AppError> {
        let enrollments = self.enrollments_of(person);
        Ok(self
            .counted_sends(since, |s| enrollments.contains(&s.enrollment_id))
            .into_iter()
            .max_by_key(|s| (s.created_at, s.id))
            .cloned())
    }

    async fn click(
        &mut self,
        id: SendId,
        automated: bool,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        if !self.own(&self.outreach().sends).any(|s| s.id == id) {
            return self.call(|_| Err(AppError::not_found("no such outreach send")));
        }
        self.change_send(id, move |s| {
            if automated {
                s.automated_clicks += 1;
            } else {
                s.clicks += 1;
                s.first_clicked_at.get_or_insert(at);
            }
        });
        Ok(())
    }

    async fn unsubscribed(&mut self, id: SendId, at: OffsetDateTime) -> Result<bool, AppError> {
        let first = self
            .own(&self.outreach().sends)
            .any(|s| s.id == id && s.unsubscribed_at.is_none());
        if first {
            self.change_send(id, move |s| s.unsubscribed_at = Some(at));
        }
        Ok(first)
    }

    async fn count_mailbox_since(
        &mut self,
        mailbox: CapabilityId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        Ok(count(
            self.counted_sends(since, |s| s.mailbox_id == mailbox).len(),
        ))
    }

    async fn count_campaign_since(
        &mut self,
        campaign: CampaignId,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        Ok(count(
            self.counted_sends(since, |s| s.campaign_id == campaign)
                .len(),
        ))
    }

    async fn count_domain_since(
        &mut self,
        mailbox: CapabilityId,
        domain: &str,
        since: OffsetDateTime,
    ) -> Result<u32, AppError> {
        Ok(count(
            self.counted_sends(since, |s| {
                s.mailbox_id == mailbox && s.recipient_domain == domain
            })
            .len(),
        ))
    }

    async fn person_send_times(
        &mut self,
        person: PersonId,
        since: OffsetDateTime,
    ) -> Result<Vec<OffsetDateTime>, AppError> {
        let enrollments = self.enrollments_of(person);
        let mut sends = self.counted_sends(since, |s| enrollments.contains(&s.enrollment_id));
        sends.sort_by_key(|s| (s.created_at, s.id));
        Ok(sends.into_iter().map(|s| s.created_at).collect())
    }

    async fn recent_outcomes(
        &mut self,
        campaign: CampaignId,
        n: u32,
    ) -> Result<Vec<SendOutcome>, AppError> {
        let mut sends: Vec<&SendRow> = self
            .own(&self.outreach().sends)
            .filter(|s| s.campaign_id == campaign)
            .collect();
        sends.sort_by_key(|s| std::cmp::Reverse((s.created_at, s.id)));
        Ok(sends
            .into_iter()
            .take(n as usize)
            .map(|s| s.outcome)
            .collect())
    }

    async fn report(&mut self, q: &ReportQuery) -> Result<Vec<StepCounts>, AppError> {
        let mut groups: BTreeMap<(CampaignId, u8), StepCounts> = BTreeMap::new();
        for s in self.own(&self.outreach().sends).filter(|s| {
            q.campaign_id.is_none_or(|c| s.campaign_id == c)
                && s.created_at >= q.from
                && s.created_at < q.to
        }) {
            let c = groups.entry((s.campaign_id, s.step)).or_insert(StepCounts {
                campaign_id: s.campaign_id,
                step: s.step,
                sends: 0,
                sent: 0,
                failed: 0,
                unknown: 0,
                refused: 0,
                bounced: 0,
                complained: 0,
                replied: 0,
                replied_threaded: 0,
                unsubscribed: 0,
                clicked: 0,
                clicks: 0,
                automated_clicks: 0,
            });
            c.sends += 1;
            match s.outcome {
                SendOutcome::Sent => c.sent += 1,
                SendOutcome::Failed => c.failed += 1,
                SendOutcome::Unknown => c.unknown += 1,
                SendOutcome::Refused => c.refused += 1,
                SendOutcome::Bounced => c.bounced += 1,
                SendOutcome::Complained => c.complained += 1,
                SendOutcome::Queued => {}
            }
            c.replied += u32::from(s.replied_at.is_some());
            c.replied_threaded += u32::from(s.replied_threaded == Some(true));
            c.unsubscribed += u32::from(s.unsubscribed_at.is_some());
            c.clicked += u32::from(s.first_clicked_at.is_some());
            c.clicks += s.clicks;
            c.automated_clicks += s.automated_clicks;
        }
        Ok(groups.into_values().collect())
    }
}
