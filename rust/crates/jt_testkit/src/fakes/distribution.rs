//! The in-memory rep profiles, distribution rules and assignment log, with the constraints
//! migration `0027_distribution` enforces: a profile and a rule cursor name an existing user, a
//! decision a journey of the bundle's workspace; at most one live decision per journey; rule
//! positions unique (the whole set is replaced); a decision's member as its cause allows, a due
//! time only with a member; a decision changes only by being acted on or superseded, once each.
//! Every count is computed from the rows. Locks are not modelled: races are tested on PostgreSQL.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::distribution::{
    AssignmentCursor, AssignmentPage, AssignmentQuery, AssignmentRepo, AssignmentRow,
    MAX_ASSIGNMENT_PAGE, MAX_RULES, Ownerless, OwnerlessScope, RepProfileRepo, RuleRepo,
    assignment_row_valid,
};
use jt_inbox::{Cause, Journey, JourneyId, RepProfile, Rule, RuleId};
use jt_tenancy::{UserId, WorkspaceId};
use time::OffsetDateTime;

use super::state::{MemBundle, MemState, exists, unique};
use super::tenant::MemTenant;

/// Distribution's tables, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemDistribution {
    pub profiles: Vec<(WorkspaceId, RepProfile)>,
    /// In position order per workspace.
    pub rules: Vec<(WorkspaceId, Rule)>,
    pub assignments: Vec<(WorkspaceId, AssignmentRow)>,
}

impl MemTenant {
    fn dist(&self) -> &MemDistribution {
        &self.state().distribution
    }

    fn rows(&self) -> impl Iterator<Item = &AssignmentRow> {
        let ws = self.ws;
        self.dist()
            .assignments
            .iter()
            .filter(move |(w, _)| *w == ws)
            .map(|(_, r)| r)
    }

    fn live_row(&self, journey: JourneyId) -> Option<&AssignmentRow> {
        self.rows()
            .find(|r| r.journey_id == journey && r.superseded_at.is_none())
    }

    fn open_journeys(&self) -> impl Iterator<Item = &Journey> {
        let ws = self.ws;
        self.state()
            .inbox
            .journeys
            .iter()
            .filter(move |j| j.workspace_id == ws && j.closed_at.is_none())
    }

    fn is_open(&self, journey: JourneyId) -> bool {
        self.open_journeys().any(|j| j.id == journey)
    }

    fn sla_reassignments(&self, journey: JourneyId) -> u32 {
        let n = self
            .rows()
            .filter(|r| r.journey_id == journey && r.cause == Cause::SlaReassign)
            .count();
        u32::try_from(n).unwrap_or(u32::MAX)
    }

    /// Live, unacted, due decisions of open journeys, oldest due first.
    fn overdue(&self, now: OffsetDateTime) -> Vec<&AssignmentRow> {
        let mut due: Vec<&AssignmentRow> = self
            .rows()
            .filter(|r| {
                r.superseded_at.is_none()
                    && r.acted_at.is_none()
                    && r.sla_due_at.is_some_and(|d| d <= now)
                    && self.is_open(r.journey_id)
            })
            .collect();
        due.sort_by_key(|r| (r.sla_due_at, r.id));
        due
    }

    fn user_exists(&self, user: UserId) -> bool {
        self.state().users.iter().any(|u| u.id == user)
    }

    /// Applies `change` to the journey's live decision, here and on commit.
    fn change_live(
        &mut self,
        journey: JourneyId,
        change: impl Fn(&mut AssignmentRow) + Send + Sync + 'static,
    ) {
        let ws = self.ws;
        self.tx.write(move |s: &mut MemState| {
            if let Some((_, r)) = s
                .distribution
                .assignments
                .iter_mut()
                .find(|(w, r)| *w == ws && r.journey_id == journey && r.superseded_at.is_none())
            {
                change(r);
            }
        });
    }
}

#[async_trait]
impl RepProfileRepo for MemTenant {
    async fn get(&mut self, user: UserId) -> Result<RepProfile, AppError> {
        let ws = self.ws;
        Ok(self
            .dist()
            .profiles
            .iter()
            .find(|(w, p)| *w == ws && p.user_id == user)
            .map(|(_, p)| p.clone())
            .unwrap_or_else(|| RepProfile::default_for(user)))
    }

    async fn list(&mut self) -> Result<Vec<RepProfile>, AppError> {
        let ws = self.ws;
        let mut out: Vec<RepProfile> = self
            .dist()
            .profiles
            .iter()
            .filter(|(w, _)| *w == ws)
            .map(|(_, p)| p.clone())
            .collect();
        out.sort_by_key(|p| p.user_id);
        Ok(out)
    }

    async fn set(&mut self, profile: &RepProfile) -> Result<(), AppError> {
        self.call(|t| {
            exists(t.user_exists(profile.user_id), "rep_profiles.user_id")?;
            let bounded = profile.max_open.is_none_or(|m| (1..=10_000).contains(&m))
                && profile.languages.len() <= 20
                && profile.cities.len() <= 20
                && profile.sectors.len() <= 20;
            if !bounded {
                return Err(AppError::internal("a rep profile breaks its checks"));
            }
            let ws = t.ws;
            let profile = profile.clone();
            t.tx.write(move |s| {
                s.distribution
                    .profiles
                    .retain(|(w, p)| !(*w == ws && p.user_id == profile.user_id));
                s.distribution.profiles.push((ws, profile.clone()));
            });
            Ok(())
        })
    }
}

#[async_trait]
impl RuleRepo for MemTenant {
    async fn list(&mut self) -> Result<Vec<Rule>, AppError> {
        let ws = self.ws;
        Ok(self
            .dist()
            .rules
            .iter()
            .filter(|(w, _)| *w == ws)
            .map(|(_, r)| r.clone())
            .collect())
    }

    async fn replace_all(&mut self, rules: &[Rule], _at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|t| {
            if rules.len() > MAX_RULES {
                return Err(AppError::internal("more rules than positions"));
            }
            for r in rules {
                let name = r.name.chars().count();
                if !(1..=80).contains(&name)
                    || r.sla_minutes.is_some_and(|m| !(5..=10_080).contains(&m))
                {
                    return Err(AppError::internal("a distribution rule breaks its checks"));
                }
                if let Some(user) = r.cursor {
                    exists(t.user_exists(user), "distribution_rules.cursor_user_id")?;
                }
            }
            let ids: std::collections::BTreeSet<RuleId> = rules.iter().map(|r| r.id).collect();
            unique(ids.len() == rules.len(), "a rule id is repeated")?;
            let ws = t.ws;
            let taken = t
                .state()
                .distribution
                .rules
                .iter()
                .any(|(w, r)| *w != ws && ids.contains(&r.id));
            unique(!taken, "a rule id is taken")?;
            let rules = rules.to_vec();
            t.tx.write(move |s| {
                s.distribution.rules.retain(|(w, _)| *w != ws);
                for r in &rules {
                    s.distribution.rules.push((ws, r.clone()));
                }
            });
            Ok(())
        })
    }

    async fn set_cursor(&mut self, id: RuleId, user: UserId) -> Result<bool, AppError> {
        self.call(|t| {
            exists(t.user_exists(user), "distribution_rules.cursor_user_id")?;
            let ws = t.ws;
            let found = t.dist().rules.iter().any(|(w, r)| *w == ws && r.id == id);
            if found {
                t.tx.write(move |s| {
                    if let Some((_, r)) = s
                        .distribution
                        .rules
                        .iter_mut()
                        .find(|(w, r)| *w == ws && r.id == id)
                    {
                        r.cursor = Some(user);
                    }
                });
            }
            Ok(found)
        })
    }
}

#[async_trait]
impl AssignmentRepo for MemTenant {
    async fn live(&mut self, journey: JourneyId) -> Result<Option<AssignmentRow>, AppError> {
        Ok(self.live_row(journey).cloned())
    }

    async fn insert(&mut self, row: &AssignmentRow) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            let journey = t
                .state()
                .inbox
                .journeys
                .iter()
                .any(|j| j.workspace_id == ws && j.id == row.journey_id);
            if !journey {
                return Err(AppError::not_found("no such journey"));
            }
            if let Some(user) = row.user_id {
                exists(t.user_exists(user), "journey_assignments.user_id")?;
            }
            if row.superseded_at.is_some() || !assignment_row_valid(row) {
                return Err(AppError::internal("an assignment breaks its checks"));
            }
            unique(
                !t.state()
                    .distribution
                    .assignments
                    .iter()
                    .any(|(_, r)| r.id == row.id),
                "the assignment id is taken",
            )?;
            unique(
                t.live_row(row.journey_id).is_none(),
                "the journey already has a live assignment",
            )?;
            let row = row.clone();
            t.tx.write(move |s| s.distribution.assignments.push((ws, row.clone())));
            Ok(())
        })
    }

    async fn supersede(
        &mut self,
        journey: JourneyId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let live = self.live_row(journey).is_some();
        if live {
            self.change_live(journey, move |r| r.superseded_at = Some(at));
        }
        Ok(live)
    }

    async fn touch(
        &mut self,
        journey: JourneyId,
        user: UserId,
        at: OffsetDateTime,
    ) -> Result<bool, AppError> {
        let owner = self
            .live_row(journey)
            .is_some_and(|r| r.user_id == Some(user) && r.acted_at.is_none());
        if owner {
            self.change_live(journey, move |r| r.acted_at = Some(at));
        }
        Ok(owner)
    }

    async fn due_sla(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
        limit: u32,
    ) -> Result<Vec<AssignmentRow>, AppError> {
        Ok(self
            .overdue(now)
            .into_iter()
            .filter(|r| self.sla_reassignments(r.journey_id) < max_reassignments)
            .take(limit.clamp(1, MAX_ASSIGNMENT_PAGE) as usize)
            .cloned()
            .collect())
    }

    async fn count_stalled(
        &mut self,
        now: OffsetDateTime,
        max_reassignments: u32,
    ) -> Result<u32, AppError> {
        let n = self
            .overdue(now)
            .into_iter()
            .filter(|r| self.sla_reassignments(r.journey_id) >= max_reassignments)
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn ownerless_open(
        &mut self,
        scope: OwnerlessScope,
        limit: u32,
    ) -> Result<Vec<JourneyId>, AppError> {
        let mut out: Vec<&Journey> = self
            .open_journeys()
            .filter(|j| j.owner.is_none())
            .filter(|j| match scope {
                OwnerlessScope::All => true,
                OwnerlessScope::Undecided => self
                    .live_row(j.id)
                    .is_none_or(|r| r.cause == Cause::MemberLeft),
            })
            .collect();
        out.sort_by_key(|j| (j.opened_at, j.id));
        Ok(out
            .into_iter()
            .take(limit.clamp(1, MAX_ASSIGNMENT_PAGE) as usize)
            .map(|j| j.id)
            .collect())
    }

    async fn count_ownerless(&mut self) -> Result<Ownerless, AppError> {
        let mut open: Vec<&Journey> = self.open_journeys().filter(|j| j.owner.is_none()).collect();
        open.sort_by_key(|j| (j.opened_at, j.id));
        Ok(Ownerless {
            count: u32::try_from(open.len()).unwrap_or(u32::MAX),
            oldest_journey_id: open.first().map(|j| j.id),
        })
    }

    async fn previous_assignees(&mut self, journey: JourneyId) -> Result<Vec<UserId>, AppError> {
        let users: std::collections::BTreeSet<UserId> = self
            .rows()
            .filter(|r| r.journey_id == journey)
            .filter_map(|r| r.user_id)
            .collect();
        Ok(users.into_iter().collect())
    }

    async fn reassignments(&mut self, journey: JourneyId) -> Result<u32, AppError> {
        Ok(self.sla_reassignments(journey))
    }

    async fn default_cursor(&mut self) -> Result<Option<UserId>, AppError> {
        Ok(self
            .rows()
            .filter(|r| r.cause == Cause::Default)
            .max_by_key(|r| (r.assigned_at, r.id))
            .and_then(|r| r.user_id))
    }

    async fn open_owned(&mut self) -> Result<Vec<(UserId, u32)>, AppError> {
        let mut counts = std::collections::BTreeMap::<UserId, u32>::new();
        for j in self.open_journeys() {
            if let Some(owner) = j.owner {
                *counts.entry(owner).or_default() += 1;
            }
        }
        Ok(counts.into_iter().collect())
    }

    async fn list(&mut self, q: &AssignmentQuery) -> Result<AssignmentPage, AppError> {
        let limit = q.limit.clamp(1, MAX_ASSIGNMENT_PAGE) as usize;
        let mut rows: Vec<&AssignmentRow> = self
            .rows()
            .filter(|r| q.journey_id.is_none_or(|j| r.journey_id == j))
            .filter(|r| q.user_id.is_none_or(|u| r.user_id == Some(u)))
            .filter(|r| {
                q.before
                    .is_none_or(|c| (r.assigned_at, r.id) < (c.assigned_at, c.id))
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse((r.assigned_at, r.id)));
        let more = rows.len() > limit;
        let items: Vec<AssignmentRow> = rows.into_iter().take(limit).cloned().collect();
        let next = more
            .then(|| items.last())
            .flatten()
            .map(|r| AssignmentCursor {
                assigned_at: r.assigned_at,
                id: r.id,
            });
        Ok(AssignmentPage { items, next })
    }
}
