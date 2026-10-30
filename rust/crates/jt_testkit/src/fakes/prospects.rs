//! The in-memory prospect pool, research tasks and blocklist, with the constraints migration
//! `0020_prospects` enforces: one prospect and one task per id across workspaces, a hard key held
//! by at most one prospect of a workspace (soft keys repeat freely), a task's strategy version and
//! a prospect's task of the bundle's workspace, one open standing task per ICP entry and version,
//! a rejection's expiry and nothing else's, and keys and scores going with their prospect. Every
//! count is computed from the rows (no counter to drift). Locks are not modelled: races are
//! tested on PostgreSQL.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::prospects::{
    BlockReason, BlocklistRepo, Inserted, ListCursor, MAX_PROSPECT_PAGE, Page, ProspectQuery,
    ProspectRepo, ProspectRow, ResearchTaskQuery, ResearchTaskRepo, ScoreRow, Updated, is_key_hash,
    prospect_matches,
};
use jt_inbox::PersonId;
use jt_prospects::{
    Claim, Decision, Key, KeyKind, Promotion, Prospect, ProspectId, ProspectStatus, ResearchTask,
    ResearchTaskId, ScoreSummary, TaskKind, TaskStatus,
};
use jt_strategy::StrategyVersionId;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, same_workspace, unique};
use super::tenant::MemTenant;

/// One blocklist row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBlock {
    pub workspace_id: WorkspaceId,
    pub kind: KeyKind,
    pub key_hash: String,
    pub reason: BlockReason,
    pub created_at: OffsetDateTime,
    pub expires_at: Option<OffsetDateTime>,
}

/// The pool's tables, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemProspects {
    pub prospects: Vec<Prospect>,
    /// `(workspace, prospect, key)`.
    pub keys: Vec<(WorkspaceId, ProspectId, Key)>,
    pub scores: Vec<(WorkspaceId, ScoreRow)>,
    pub tasks: Vec<ResearchTask>,
    pub blocklist: Vec<StoredBlock>,
}

fn rank(r: BlockReason) -> u8 {
    match r {
        BlockReason::Rejected => 0,
        BlockReason::DoNotContact => 1,
        BlockReason::Erased => 2,
    }
}

/// `keys` without repeats, in key order.
fn distinct(keys: &[Key]) -> Vec<Key> {
    keys.iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl MemTenant {
    fn pool(&self) -> &MemProspects {
        &self.state().prospects
    }

    fn prospect_in(&self, id: ProspectId) -> Option<&Prospect> {
        let ws = self.ws;
        self.pool()
            .prospects
            .iter()
            .find(|p| p.workspace_id == ws && p.id == id)
    }

    /// The first of `keys`' hard keys (in key order) a prospect other than `except` holds.
    fn hard_holder(
        &self,
        keys: &[Key],
        except: Option<ProspectId>,
    ) -> Option<(KeyKind, ProspectId)> {
        let ws = self.ws;
        let mut held: Vec<(Key, ProspectId)> = self
            .pool()
            .keys
            .iter()
            .filter(|(w, id, k)| {
                *w == ws && k.kind.hard() && Some(*id) != except && keys.contains(k)
            })
            .map(|(_, id, k)| (k.clone(), *id))
            .collect();
        held.sort();
        held.into_iter().next().map(|(k, id)| (k.kind, id))
    }

    fn task_in(&self, id: ResearchTaskId) -> Option<&ResearchTask> {
        let ws = self.ws;
        self.pool()
            .tasks
            .iter()
            .find(|t| t.workspace_id == ws && t.id == id)
    }

    fn count_where(&self, f: impl Fn(&Prospect) -> bool) -> u32 {
        let ws = self.ws;
        let n = self
            .pool()
            .prospects
            .iter()
            .filter(|p| p.workspace_id == ws && f(p))
            .count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    /// Applies `change` to prospect `id` of the bundle's workspace, here and on commit.
    fn change_prospect(
        &mut self,
        id: ProspectId,
        change: impl Fn(&mut Prospect) + Send + Sync + 'static,
    ) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            if let Some(p) = s
                .prospects
                .prospects
                .iter_mut()
                .find(|p| p.workspace_id == ws && p.id == id)
            {
                change(p);
            }
        });
    }

    fn set_keys(&mut self, id: ProspectId, keys: Vec<Key>) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            s.prospects.keys.retain(|(w, p, _)| !(*w == ws && *p == id));
            for k in &keys {
                s.prospects.keys.push((ws, id, k.clone()));
            }
        });
    }
}

#[async_trait]
impl ProspectRepo for MemTenant {
    async fn lock_pool(&mut self) -> Result<(), AppError> {
        Ok(())
    }

    async fn insert(&mut self, p: &Prospect, keys: &[Key]) -> Result<Inserted, AppError> {
        self.call(|this| {
            same_workspace(this.ws, p.workspace_id)?;
            if p.status == ProspectStatus::Promoted {
                return Err(AppError::internal("a new prospect is never promoted"));
            }
            if let Some((kind, prospect_id)) = this.hard_holder(keys, None) {
                return Ok(Inserted::DuplicateKey { kind, prospect_id });
            }
            unique(
                !this.pool().prospects.iter().any(|x| x.id == p.id),
                "the prospect id is already taken",
            )?;
            if let Some(task) = p.research_task_id
                && this.task_in(task).is_none()
            {
                return Err(AppError::internal(
                    "prospects.research_task_id references a row that does not exist",
                ));
            }
            let row = p.clone();
            this.tx
                .write(move |s: &mut MemState| s.prospects.prospects.push(row.clone()));
            this.set_keys(p.id, distinct(keys));
            Ok(Inserted::Ok)
        })
    }

    async fn update(
        &mut self,
        p: &Prospect,
        keys: &[Key],
        expected_revision: u32,
    ) -> Result<Updated, AppError> {
        self.call(|this| {
            same_workspace(this.ws, p.workspace_id)?;
            let Some(current) = this.prospect_in(p.id) else {
                return Err(AppError::not_found("no such prospect"));
            };
            if current.revision != expected_revision {
                return Ok(Updated::Stale);
            }
            if let Some((kind, prospect_id)) = this.hard_holder(keys, Some(p.id)) {
                return Ok(Updated::DuplicateKey { kind, prospect_id });
            }
            let mut row = p.clone();
            row.created_at = current.created_at;
            row.revision = expected_revision + 1;
            this.change_prospect(p.id, move |x| *x = row.clone());
            this.set_keys(p.id, distinct(keys));
            Ok(Updated::Ok)
        })
    }

    async fn get(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError> {
        Ok(self.prospect_in(id).cloned())
    }

    async fn lock(&mut self, id: ProspectId) -> Result<Option<Prospect>, AppError> {
        Ok(self.prospect_in(id).cloned())
    }

    async fn list(&mut self, q: &ProspectQuery) -> Result<Page<ProspectRow>, AppError> {
        let ws = self.ws;
        let limit = q.limit.clamp(1, MAX_PROSPECT_PAGE) as usize;
        let mut rows: Vec<&Prospect> = self
            .pool()
            .prospects
            .iter()
            .filter(|p| p.workspace_id == ws && prospect_matches(p, q))
            .filter(|p| {
                q.after
                    .is_none_or(|c| (p.created_at, p.id.as_uuid()) < (c.created_at, c.id))
            })
            .collect();
        rows.sort_by_key(|p| std::cmp::Reverse((p.created_at, p.id)));
        let mut items: Vec<ProspectRow> = rows
            .iter()
            .take(limit + 1)
            .map(|p| ProspectRow::of(p))
            .collect();
        let next = if items.len() > limit {
            items.truncate(limit);
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
        let ws = self.ws;
        let found: BTreeSet<(KeyKind, ProspectId)> = self
            .pool()
            .keys
            .iter()
            .filter(|(w, _, k)| *w == ws && keys.contains(k))
            .map(|(_, id, k)| (k.kind, *id))
            .collect();
        Ok(found.into_iter().collect())
    }

    async fn keys_of(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError> {
        let ws = self.ws;
        let mut keys: Vec<Key> = self
            .pool()
            .keys
            .iter()
            .filter(|(w, p, _)| *w == ws && *p == id)
            .map(|(_, _, k)| k.clone())
            .collect();
        keys.sort();
        Ok(keys)
    }

    async fn record_score(&mut self, row: &ScoreRow) -> Result<(), AppError> {
        self.call(|this| {
            if row.score > 100 {
                return Err(AppError::internal("a score is 0..=100"));
            }
            if this.prospect_in(row.prospect_id).is_none() {
                return Err(AppError::not_found("no such prospect"));
            }
            unique(
                !this.pool().scores.iter().any(|(_, s)| s.id == row.id),
                "the score id is already taken",
            )?;
            let ws = this.ws;
            let stored = row.clone();
            this.tx
                .write(move |s: &mut MemState| s.prospects.scores.push((ws, stored.clone())));
            let (score, digest, at) = (row.score, row.rubric_digest.clone(), row.at);
            this.change_prospect(row.prospect_id, move |p| {
                if p.latest_score.as_ref().is_none_or(|l| l.at <= at) {
                    p.latest_score = Some(ScoreSummary {
                        score,
                        digest: digest.clone(),
                        at,
                    });
                }
            });
            Ok(())
        })
    }

    async fn scores(&mut self, id: ProspectId, limit: u32) -> Result<Vec<ScoreRow>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<ScoreRow> = self
            .pool()
            .scores
            .iter()
            .filter(|(w, s)| *w == ws && s.prospect_id == id)
            .map(|(_, s)| s.clone())
            .collect();
        rows.sort_by_key(|s| std::cmp::Reverse((s.at, s.id)));
        rows.truncate(limit.clamp(1, MAX_PROSPECT_PAGE) as usize);
        Ok(rows)
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
        self.call(|this| {
            if status == ProspectStatus::Promoted {
                return Err(AppError::internal("a promotion is set with set_promoted"));
            }
            let Some(current) = this.prospect_in(id) else {
                return Err(AppError::not_found("no such prospect"));
            };
            if current.revision != expected_revision {
                return Ok(Updated::Stale);
            }
            let decision = decision.cloned();
            this.change_prospect(id, move |p| {
                p.status = status;
                p.decision = decision.clone();
                p.purge_after = purge_after;
                p.updated_at = at;
                p.revision += 1;
            });
            Ok(Updated::Ok)
        })
    }

    async fn set_promoted(
        &mut self,
        id: ProspectId,
        promotion: &Promotion,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if this.prospect_in(id).is_none() {
                return Err(AppError::not_found("no such prospect"));
            }
            let mut promotion = promotion.clone();
            promotion.bucket = promotion.score.map(jt_prospects::bucket);
            this.change_prospect(id, move |p| {
                p.status = ProspectStatus::Promoted;
                p.promoted = Some(promotion.clone());
                p.purge_after = None;
                p.updated_at = promotion.at;
                p.revision += 1;
            });
            Ok(())
        })
    }

    async fn by_person(&mut self, person: PersonId) -> Result<Option<Prospect>, AppError> {
        let ws = self.ws;
        Ok(self
            .pool()
            .prospects
            .iter()
            .find(|p| {
                p.workspace_id == ws && p.promoted.as_ref().is_some_and(|x| x.person_id == person)
            })
            .cloned())
    }

    async fn delete(&mut self, id: ProspectId) -> Result<Vec<Key>, AppError> {
        let keys = self.keys_of(id).await?;
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            s.prospects
                .prospects
                .retain(|p| !(p.workspace_id == ws && p.id == id));
            s.prospects.keys.retain(|(w, p, _)| !(*w == ws && *p == id));
            s.prospects
                .scores
                .retain(|(w, x)| !(*w == ws && x.prospect_id == id));
        });
        Ok(keys)
    }

    async fn due_for_purge(
        &mut self,
        now: OffsetDateTime,
        limit: u32,
    ) -> Result<Vec<ProspectId>, AppError> {
        let ws = self.ws;
        let mut due: Vec<(OffsetDateTime, ProspectId)> = self
            .pool()
            .prospects
            .iter()
            .filter(|p| p.workspace_id == ws)
            .filter_map(|p| p.purge_after.filter(|at| *at <= now).map(|at| (at, p.id)))
            .collect();
        due.sort();
        due.truncate(limit as usize);
        Ok(due.into_iter().map(|(_, id)| id).collect())
    }

    async fn created_between(
        &mut self,
        task: Option<ResearchTaskId>,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError> {
        Ok(self.count_where(|p| {
            p.created_at >= from
                && p.created_at < to
                && task.is_none_or(|t| p.research_task_id == Some(t))
        }))
    }

    async fn promoted_between(
        &mut self,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<u32, AppError> {
        Ok(self.count_where(|p| {
            p.promoted
                .as_ref()
                .is_some_and(|x| x.at >= from && x.at < to)
        }))
    }

    async fn count_unscored(&mut self, digest: &str) -> Result<u32, AppError> {
        Ok(self.count_where(|p| {
            p.status == ProspectStatus::New
                && p.latest_score.as_ref().is_none_or(|s| s.digest != digest)
        }))
    }

    async fn count_qualified_unpromoted(&mut self) -> Result<u32, AppError> {
        Ok(self.count_where(|p| p.status == ProspectStatus::Qualified))
    }

    async fn backlog(&mut self, segment_key: &str) -> Result<u32, AppError> {
        Ok(self.count_where(|p| {
            matches!(p.status, ProspectStatus::New | ProspectStatus::Qualified)
                && p.segment_key.as_deref() == Some(segment_key)
        }))
    }
}

#[async_trait]
impl ResearchTaskRepo for MemTenant {
    async fn insert(&mut self, t: &ResearchTask) -> Result<bool, AppError> {
        self.call(|this| {
            same_workspace(this.ws, t.workspace_id)?;
            unique(
                !this.pool().tasks.iter().any(|x| x.id == t.id),
                "the research task id is already taken",
            )?;
            if this
                .state()
                .version_in(this.ws, t.strategy_version_id)
                .is_none()
            {
                return Err(AppError::not_found("no such strategy version"));
            }
            if (t.status == TaskStatus::Open) != t.closed_at.is_none() {
                return Err(AppError::internal(
                    "a task is closed exactly when it is not open",
                ));
            }
            if let TaskKind::Standing { icp_key } = &t.kind
                && t.status == TaskStatus::Open
                && this.pool().tasks.iter().any(|x| {
                    x.workspace_id == t.workspace_id
                        && x.strategy_version_id == t.strategy_version_id
                        && x.status == TaskStatus::Open
                        && matches!(&x.kind, TaskKind::Standing { icp_key: k } if k == icp_key)
                })
            {
                return Ok(false);
            }
            let row = t.clone();
            this.tx
                .write(move |s: &mut MemState| s.prospects.tasks.push(row.clone()));
            Ok(true)
        })
    }

    async fn get(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError> {
        Ok(self.task_in(id).cloned())
    }

    async fn lock(&mut self, id: ResearchTaskId) -> Result<Option<ResearchTask>, AppError> {
        Ok(self.task_in(id).cloned())
    }

    async fn list(&mut self, q: &ResearchTaskQuery) -> Result<Page<ResearchTask>, AppError> {
        let ws = self.ws;
        let limit = q.limit.clamp(1, MAX_PROSPECT_PAGE) as usize;
        let mut rows: Vec<ResearchTask> = self
            .pool()
            .tasks
            .iter()
            .filter(|t| t.workspace_id == ws && q.status.is_none_or(|s| t.status == s))
            .filter(|t| {
                q.after
                    .is_none_or(|c| (t.created_at, t.id.as_uuid()) < (c.created_at, c.id))
            })
            .cloned()
            .collect();
        rows.sort_by_key(|p| std::cmp::Reverse((p.created_at, p.id)));
        rows.truncate(limit + 1);
        let next = if rows.len() > limit {
            rows.truncate(limit);
            rows.last().map(|t| ListCursor {
                created_at: t.created_at,
                id: t.id.as_uuid(),
            })
        } else {
            None
        };
        Ok(Page { items: rows, next })
    }

    async fn open_standing(
        &mut self,
        version: StrategyVersionId,
    ) -> Result<Vec<ResearchTask>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<ResearchTask> = self
            .pool()
            .tasks
            .iter()
            .filter(|t| {
                t.workspace_id == ws
                    && t.strategy_version_id == version
                    && t.status == TaskStatus::Open
                    && matches!(t.kind, TaskKind::Standing { .. })
            })
            .cloned()
            .collect();
        rows.sort_by_key(|t| (t.created_at, t.id));
        Ok(rows)
    }

    async fn set_status(
        &mut self,
        id: ResearchTaskId,
        status: TaskStatus,
        at: OffsetDateTime,
        note: &str,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if this.task_in(id).is_none() {
                return Err(AppError::not_found("no such research task"));
            }
            if note.chars().count() > 1_000 {
                return Err(AppError::internal(
                    "research_tasks.close_note is at most 1000",
                ));
            }
            let (ws, note) = (this.ws, note.to_owned());
            this.tx.write(move |s: &mut MemState| {
                if let Some(t) = s
                    .prospects
                    .tasks
                    .iter_mut()
                    .find(|t| t.workspace_id == ws && t.id == id)
                {
                    t.status = status;
                    if status == TaskStatus::Open {
                        t.closed_at = None;
                        t.close_note = String::new();
                    } else {
                        t.closed_at = Some(at);
                        t.close_note = note.clone();
                    }
                }
            });
            Ok(())
        })
    }

    async fn set_claim(
        &mut self,
        id: ResearchTaskId,
        claim: Option<&Claim>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            if this.task_in(id).is_none() {
                return Err(AppError::not_found("no such research task"));
            }
            let (ws, claim) = (this.ws, claim.cloned());
            this.tx.write(move |s: &mut MemState| {
                if let Some(t) = s
                    .prospects
                    .tasks
                    .iter_mut()
                    .find(|t| t.workspace_id == ws && t.id == id)
                {
                    t.claim = claim.clone();
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl BlocklistRepo for MemTenant {
    async fn contains(
        &mut self,
        kind: KeyKind,
        hash: &str,
        now: OffsetDateTime,
    ) -> Result<Option<BlockReason>, AppError> {
        let ws = self.ws;
        Ok(self
            .pool()
            .blocklist
            .iter()
            .find(|b| {
                b.workspace_id == ws
                    && b.kind == kind
                    && b.key_hash == hash
                    && b.expires_at.is_none_or(|e| e > now)
            })
            .map(|b| b.reason))
    }

    async fn insert(
        &mut self,
        kind: KeyKind,
        hash: &str,
        reason: BlockReason,
        at: OffsetDateTime,
        expires_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        self.call(|this| {
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
            let (ws, hash) = (this.ws, hash.to_owned());
            this.tx.write(move |s: &mut MemState| {
                let list = &mut s.prospects.blocklist;
                match list
                    .iter_mut()
                    .find(|b| b.workspace_id == ws && b.kind == kind && b.key_hash == hash)
                {
                    Some(b) if rank(reason) > rank(b.reason) => {
                        b.reason = reason;
                        b.expires_at = expires_at;
                    }
                    Some(b) if b.reason == BlockReason::Rejected => {
                        b.expires_at = b.expires_at.max(expires_at);
                    }
                    Some(_) => {}
                    None => list.push(StoredBlock {
                        workspace_id: ws,
                        kind,
                        key_hash: hash.clone(),
                        reason,
                        created_at: at,
                        expires_at,
                    }),
                }
            });
            Ok(())
        })
    }

    async fn lift(&mut self, kind: KeyKind, hash: &str) -> Result<bool, AppError> {
        let ws = self.ws;
        let found = self.pool().blocklist.iter().any(|b| {
            b.workspace_id == ws
                && b.kind == kind
                && b.key_hash == hash
                && b.reason == BlockReason::DoNotContact
        });
        if found {
            let hash = hash.to_owned();
            self.tx.write(move |s: &mut MemState| {
                s.prospects.blocklist.retain(|b| {
                    !(b.workspace_id == ws
                        && b.kind == kind
                        && b.key_hash == hash
                        && b.reason == BlockReason::DoNotContact)
                })
            });
        }
        Ok(found)
    }

    async fn purge_expired(&mut self, now: OffsetDateTime) -> Result<u64, AppError> {
        let ws = self.ws;
        let expired = |b: &StoredBlock| {
            b.workspace_id == ws
                && b.reason == BlockReason::Rejected
                && b.expires_at.is_some_and(|e| e <= now)
        };
        let n = self.pool().blocklist.iter().filter(|b| expired(b)).count();
        if n > 0 {
            self.tx.write(move |s: &mut MemState| {
                s.prospects.blocklist.retain(|b| {
                    !(b.workspace_id == ws
                        && b.reason == BlockReason::Rejected
                        && b.expires_at.is_some_and(|e| e <= now))
                })
            });
        }
        Ok(n as u64)
    }
}
