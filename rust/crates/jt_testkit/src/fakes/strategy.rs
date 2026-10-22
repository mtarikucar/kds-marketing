//! The tenant bundle's strategy repos: versions, hypotheses and the consultation log.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{ConsultationRepo, HypothesisRepo, MAX_CONSULTATION_PAGE, StrategyRepo};
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, Hypothesis, HypothesisId, HypothesisState, Sections,
    StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_tenancy::{UserId, WorkspaceId};
use time::OffsetDateTime;

use super::state::{
    MemBundle, MemState, StoredConsultationEntry, StoredHypothesis, exists, same_workspace, unique,
};
use super::tenant::MemTenant;

/// `INTERNAL` for a confidence the check constraint of `strategy_hypotheses` refuses.
fn check_confidence(h: &Hypothesis) -> Result<(), AppError> {
    if (0.0..=1.0).contains(&h.confidence) {
        Ok(())
    } else {
        Err(AppError::internal(
            "strategy_hypotheses.confidence must be between 0 and 1",
        ))
    }
}

/// After a draft-only write found no draft: `NOT_FOUND` for an unknown version, `CONFLICT` for
/// one that is not a draft, as in `jt_pg`.
fn ensure_draft(state: &MemState, ws: WorkspaceId, id: StrategyVersionId) -> Result<(), AppError> {
    match state.version_in(ws, id) {
        None => Err(AppError::not_found("no such strategy version")),
        Some(v) if v.status != VersionStatus::Draft => {
            Err(AppError::conflict("the strategy version is not a draft"))
        }
        Some(_) => Ok(()),
    }
}

#[async_trait]
impl StrategyRepo for MemTenant {
    async fn insert(&mut self, version: StrategyVersion) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, version.workspace_id)?;
            let state = this.state();
            // As `on conflict do nothing` in `jt_pg`: the unique keys first, then the references.
            unique(
                !state.strategy_versions.iter().any(|v| {
                    v.id == version.id || (v.workspace_id == ws && v.number == version.number)
                }),
                "the strategy version id or number is taken",
            )?;
            if matches!(
                version.status,
                VersionStatus::Draft | VersionStatus::Approved
            ) {
                unique(
                    state.version_with_status(ws, version.status).is_none(),
                    "the workspace already has a version in that status",
                )?;
            }
            exists(
                state.workspace(ws).is_some(),
                "strategy_versions.workspace_id",
            )?;
            if let Some(by) = version.approved_by {
                exists(state.user(by).is_some(), "strategy_versions.approved_by")?;
            }
            this.tx
                .write(move |s| s.strategy_versions.push(version.clone()));
            Ok(())
        })
    }

    async fn find(&mut self, id: StrategyVersionId) -> Result<Option<StrategyVersion>, AppError> {
        Ok(self.state().version_in(self.ws, id).cloned())
    }

    async fn current_approved(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        Ok(self
            .state()
            .version_with_status(self.ws, VersionStatus::Approved)
            .cloned())
    }

    async fn current_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        Ok(self
            .state()
            .version_with_status(self.ws, VersionStatus::Draft)
            .cloned())
    }

    /// `current_draft`: the fakes run one bundle at a time in tests, so there is nothing to wait
    /// for. Races on the draft are tested against Postgres.
    async fn lock_draft(&mut self) -> Result<Option<StrategyVersion>, AppError> {
        Ok(self
            .state()
            .version_with_status(self.ws, VersionStatus::Draft)
            .cloned())
    }

    async fn list(&mut self) -> Result<Vec<StrategyVersion>, AppError> {
        let mut versions: Vec<StrategyVersion> = self
            .state()
            .strategy_versions
            .iter()
            .filter(|v| v.workspace_id == self.ws)
            .cloned()
            .collect();
        versions.sort_by_key(|v| std::cmp::Reverse(v.number));
        Ok(versions)
    }

    async fn update_sections(
        &mut self,
        id: StrategyVersionId,
        sections: Sections,
        _at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            ensure_draft(this.state(), ws, id)?;
            this.tx.write(move |s| {
                if let Some(v) = s
                    .strategy_versions
                    .iter_mut()
                    .find(|v| v.workspace_id == ws && v.id == id)
                {
                    v.sections = sections.clone();
                }
            });
            Ok(())
        })
    }

    async fn set_submitted(
        &mut self,
        id: StrategyVersionId,
        at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            ensure_draft(this.state(), ws, id)?;
            this.tx.write(move |s| {
                if let Some(v) = s
                    .strategy_versions
                    .iter_mut()
                    .find(|v| v.workspace_id == ws && v.id == id)
                {
                    v.submitted_at = at;
                }
            });
            Ok(())
        })
    }

    async fn set_status(
        &mut self,
        id: StrategyVersionId,
        status: VersionStatus,
        at: OffsetDateTime,
        by: Option<UserId>,
    ) -> Result<u64, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let from: &[VersionStatus] = match status {
                VersionStatus::Draft => {
                    return Err(AppError::internal(
                        "a strategy version never returns to draft",
                    ));
                }
                VersionStatus::Approved => &[VersionStatus::Draft],
                VersionStatus::Archived => &[VersionStatus::Draft, VersionStatus::Approved],
            };
            let state = this.state();
            let movable = state
                .version_in(ws, id)
                .is_some_and(|v| from.contains(&v.status));
            if !movable {
                return Ok(0);
            }
            if status == VersionStatus::Approved {
                unique(
                    state
                        .version_with_status(ws, VersionStatus::Approved)
                        .is_none(),
                    "the workspace already has an approved strategy version",
                )?;
                if let Some(by) = by {
                    exists(state.user(by).is_some(), "strategy_versions.approved_by")?;
                }
            }
            this.tx.write(move |s| {
                if let Some(v) = s
                    .strategy_versions
                    .iter_mut()
                    .find(|v| v.workspace_id == ws && v.id == id)
                {
                    v.status = status;
                    if status == VersionStatus::Approved {
                        v.approved_at = Some(at);
                        v.approved_by = by;
                    } else {
                        v.archived_at = Some(at);
                    }
                }
            });
            Ok(1)
        })
    }

    async fn next_number(&mut self) -> Result<i32, AppError> {
        let highest = self
            .state()
            .strategy_versions
            .iter()
            .filter(|v| v.workspace_id == self.ws)
            .map(|v| v.number)
            .max()
            .unwrap_or(0);
        Ok(highest + 1)
    }
}

#[async_trait]
impl HypothesisRepo for MemTenant {
    async fn replace_all(
        &mut self,
        version_id: StrategyVersionId,
        hypotheses: Vec<Hypothesis>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            this.state().ensure_version(ws, version_id)?;
            let mut seen = BTreeSet::new();
            for h in &hypotheses {
                unique(seen.insert(h.id), "a hypothesis is listed twice")?;
                check_confidence(h)?;
            }
            let rows: Vec<StoredHypothesis> = hypotheses
                .into_iter()
                .zip(0..)
                .map(|(hypothesis, position)| StoredHypothesis {
                    workspace_id: ws,
                    version_id,
                    position,
                    hypothesis,
                })
                .collect();
            this.tx.write(move |s| {
                s.hypotheses
                    .retain(|h| !(h.workspace_id == ws && h.version_id == version_id));
                s.hypotheses.extend(rows.iter().cloned());
            });
            Ok(())
        })
    }

    async fn list(&mut self, version_id: StrategyVersionId) -> Result<Vec<Hypothesis>, AppError> {
        let mut rows: Vec<&StoredHypothesis> = self
            .state()
            .hypotheses
            .iter()
            .filter(|h| h.workspace_id == self.ws && h.version_id == version_id)
            .collect();
        rows.sort_by_key(|h| (h.position, h.hypothesis.id));
        Ok(rows.into_iter().map(|h| h.hypothesis.clone()).collect())
    }

    async fn upsert(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis: Hypothesis,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            state.ensure_version(ws, version_id)?;
            check_confidence(&hypothesis)?;
            let of_version =
                move |h: &StoredHypothesis| h.workspace_id == ws && h.version_id == version_id;
            let position = state
                .hypotheses
                .iter()
                .filter(|h| of_version(h))
                .map(|h| h.position + 1)
                .max()
                .unwrap_or(0);
            this.tx.write(move |s| {
                match s
                    .hypotheses
                    .iter_mut()
                    .find(|h| of_version(h) && h.hypothesis.id == hypothesis.id)
                {
                    Some(stored) => stored.hypothesis = hypothesis.clone(),
                    None => s.hypotheses.push(StoredHypothesis {
                        workspace_id: ws,
                        version_id,
                        position,
                        hypothesis: hypothesis.clone(),
                    }),
                }
            });
            Ok(())
        })
    }

    async fn set_state(
        &mut self,
        version_id: StrategyVersionId,
        hypothesis_id: HypothesisId,
        state: HypothesisState,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let target = move |h: &StoredHypothesis| {
                h.workspace_id == ws
                    && h.version_id == version_id
                    && h.hypothesis.id == hypothesis_id
            };
            if !this.state().hypotheses.iter().any(target) {
                return Err(AppError::not_found("no such hypothesis"));
            }
            this.tx.write(move |s| {
                if let Some(h) = s.hypotheses.iter_mut().find(|h| target(h)) {
                    h.hypothesis.state = state;
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl ConsultationRepo for MemTenant {
    async fn append(&mut self, entry: ConsultationEntry) -> Result<ConsultationEntryId, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            state.ensure_version(ws, entry.version_id)?;
            unique(
                !state.consultation.iter().any(|e| e.entry.id == entry.id),
                "the consultation entry id is already taken",
            )?;
            let id = entry.id;
            let row = StoredConsultationEntry {
                workspace_id: ws,
                entry,
            };
            this.tx.write(move |s| s.consultation.push(row.clone()));
            Ok(id)
        })
    }

    async fn list(
        &mut self,
        version_id: StrategyVersionId,
        limit: u32,
        before: Option<(OffsetDateTime, ConsultationEntryId)>,
    ) -> Result<Vec<ConsultationEntry>, AppError> {
        let mut entries: Vec<ConsultationEntry> = self
            .state()
            .consultation
            .iter()
            .filter(|e| e.workspace_id == self.ws && e.entry.version_id == version_id)
            .filter(|e| before.is_none_or(|before| (e.entry.at, e.entry.id) < before))
            .map(|e| e.entry.clone())
            .collect();
        entries.sort_by_key(|e| std::cmp::Reverse((e.at, e.id)));
        entries.truncate(limit.clamp(1, MAX_CONSULTATION_PAGE) as usize);
        Ok(entries)
    }

    async fn count(&mut self, version_id: StrategyVersionId) -> Result<i64, AppError> {
        let n = self
            .state()
            .consultation
            .iter()
            .filter(|e| e.workspace_id == self.ws && e.entry.version_id == version_id)
            .count();
        i64::try_from(n).map_err(|_| AppError::internal("too many consultation entries"))
    }
}
