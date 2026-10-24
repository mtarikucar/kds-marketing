//! The tenant bundle's capability repos: capabilities, groups, budget items with their links and
//! spend, and the workspace's policies.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    BudgetRepo, CapabilityFilter, CapabilityGroupRepo, CapabilityRepo,
    MAX_AGENT_CHECKIN_INTERVAL_MINUTES, MAX_SPEND_PAGE, MIN_AGENT_CHECKIN_INTERVAL_MINUTES,
    WorkspacePolicy, WorkspacePolicyRepo,
};
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetSpend, BudgetSpendId, Capability, CapabilityGroup,
    CapabilityGroupId, CapabilityId, CapabilityKind, StoredStatus,
};
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;

use super::state::{
    MemBundle, MemState, StoredBudgetLink, StoredCapability, StoredCapabilityGroup,
    StoredGroupMember, StoredWorkspacePolicy, exists, same_workspace, unique,
};
use super::tenant::MemTenant;

impl MemState {
    fn capability_in(&self, ws: WorkspaceId, id: CapabilityId) -> Option<&StoredCapability> {
        self.capabilities
            .iter()
            .find(|c| c.capability.workspace_id == ws && c.capability.id == id)
    }

    /// The capability as a read returns it: `has_sealed_config` from the sealed blob and the
    /// budget item ids, in id order, from the links.
    pub(super) fn capability_view(&self, stored: &StoredCapability) -> Capability {
        let c = &stored.capability;
        let mut budget_item_ids: Vec<BudgetItemId> = self
            .capability_budget_links
            .iter()
            .filter(|l| l.workspace_id == c.workspace_id && l.capability_id == c.id)
            .map(|l| l.budget_item_id)
            .collect();
        budget_item_ids.sort();
        Capability {
            has_sealed_config: stored.sealed.is_some(),
            budget_item_ids,
            ..c.clone()
        }
    }

    /// Whether a live capability of `ws` other than `except` holds the external account a
    /// capability of `kind_key` with `external_id` and `status` would hold: the partial unique
    /// index `capabilities_live_external_account` of migration 0003.
    fn account_taken(
        &self,
        ws: WorkspaceId,
        kind_key: &str,
        external_id: Option<&str>,
        status: StoredStatus,
        except: CapabilityId,
    ) -> bool {
        let Some(external_id) = external_id else {
            return false;
        };
        status != StoredStatus::Retired
            && self.capabilities.iter().any(|s| {
                let c = &s.capability;
                c.workspace_id == ws
                    && c.id != except
                    && c.kind_key == kind_key
                    && c.external_id.as_deref() == Some(external_id)
                    && c.status != StoredStatus::Retired
            })
    }

    fn group_in(&self, ws: WorkspaceId, id: CapabilityGroupId) -> Option<&StoredCapabilityGroup> {
        self.capability_groups
            .iter()
            .find(|g| g.group.workspace_id == ws && g.group.id == id)
    }

    /// The group with its members in id order.
    fn group_view(&self, stored: &StoredCapabilityGroup) -> (CapabilityGroup, Vec<CapabilityId>) {
        let g = &stored.group;
        let mut members: Vec<CapabilityId> = self
            .capability_group_members
            .iter()
            .filter(|m| m.workspace_id == g.workspace_id && m.group_id == g.id)
            .map(|m| m.capability_id)
            .collect();
        members.sort();
        (g.clone(), members)
    }

    fn item_in(&self, ws: WorkspaceId, id: BudgetItemId) -> Option<&BudgetItem> {
        self.budget_items
            .iter()
            .find(|i| i.workspace_id == ws && i.id == id)
    }
}

/// `NOT_FOUND` unless capability `id` belongs to `ws`, as `jt_pg` checks before hanging a member
/// or a link off it.
pub(super) fn ensure_capability(
    state: &MemState,
    ws: WorkspaceId,
    id: CapabilityId,
) -> Result<(), AppError> {
    state
        .capability_in(ws, id)
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such capability"))
}

fn ensure_group(state: &MemState, ws: WorkspaceId, id: CapabilityGroupId) -> Result<(), AppError> {
    state
        .group_in(ws, id)
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such capability group"))
}

fn ensure_item(state: &MemState, ws: WorkspaceId, id: BudgetItemId) -> Result<(), AppError> {
    state
        .item_in(ws, id)
        .map(|_| ())
        .ok_or_else(|| AppError::not_found("no such budget item"))
}

/// `CONFLICT` when the external account is taken, with the message `jt_pg` gives.
fn account_free(taken: bool) -> Result<(), AppError> {
    unique(
        !taken,
        "a live capability of this kind already holds the same external account",
    )
}

#[async_trait]
impl CapabilityRepo for MemTenant {
    async fn insert(
        &mut self,
        capability: Capability,
        sealed: Option<Vec<u8>>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, capability.workspace_id)?;
            let state = this.state();
            // As `on conflict do nothing` in `jt_pg`: the unique keys first, then the reference.
            unique(
                !state
                    .capabilities
                    .iter()
                    .any(|c| c.capability.id == capability.id),
                "the capability id is already taken",
            )?;
            account_free(state.account_taken(
                ws,
                &capability.kind_key,
                capability.external_id.as_deref(),
                capability.status,
                capability.id,
            ))?;
            exists(state.workspace(ws).is_some(), "capabilities.workspace_id")?;
            let row = StoredCapability {
                capability: Capability {
                    has_sealed_config: false,
                    budget_item_ids: Vec::new(),
                    ..capability
                },
                sealed,
                iys_sealed: None,
            };
            this.tx.write(move |s| s.capabilities.push(row.clone()));
            Ok(())
        })
    }

    async fn find(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        let state = self.state();
        Ok(state
            .capability_in(self.ws, id)
            .map(|c| state.capability_view(c)))
    }

    /// The fakes run one bundle at a time in tests, so there is no one to wait for: `find`.
    async fn lock(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        CapabilityRepo::find(self, id).await
    }

    async fn list(&mut self, filter: CapabilityFilter) -> Result<Vec<Capability>, AppError> {
        let (state, ws) = (self.state(), self.ws);
        let in_group = |c: &Capability, g: CapabilityGroupId| {
            state
                .capability_group_members
                .iter()
                .any(|m| m.workspace_id == ws && m.group_id == g && m.capability_id == c.id)
        };
        let mut rows: Vec<Capability> = state
            .capabilities
            .iter()
            .filter(|s| s.capability.workspace_id == ws)
            .map(|s| state.capability_view(s))
            .filter(|c| {
                filter.group.is_none_or(|g| {
                    CapabilityKind::parse(&c.kind_key).is_some_and(|k| k.group == g)
                })
            })
            .filter(|c| filter.kind.is_none_or(|k| c.kind_key == k))
            .filter(|c| filter.status.is_none_or(|s| c.status == s))
            .filter(|c| filter.group_id.is_none_or(|g| in_group(c, g)))
            .collect();
        rows.sort_by_key(|c| (c.created_at, c.id));
        self.tx.commit_capability_after_list(ws);
        Ok(rows)
    }

    async fn update(&mut self, capability: Capability) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, capability.workspace_id)?;
            let state = this.state();
            let current = state
                .capability_in(ws, capability.id)
                .ok_or_else(|| AppError::not_found("no such capability"))?;
            account_free(state.account_taken(
                ws,
                &current.capability.kind_key,
                capability.external_id.as_deref(),
                capability.status,
                capability.id,
            ))?;
            let id = capability.id;
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .capabilities
                    .iter_mut()
                    .find(|c| c.capability.workspace_id == ws && c.capability.id == id)
                {
                    let kept = &stored.capability;
                    stored.capability = Capability {
                        kind_key: kept.kind_key.clone(),
                        created_at: kept.created_at,
                        declared_by_connection: kept.declared_by_connection,
                        has_sealed_config: false,
                        budget_item_ids: Vec::new(),
                        ..capability.clone()
                    };
                }
            });
            Ok(())
        })
    }

    async fn set_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if this.tx.set_sealed_fails() {
                return Err(AppError::internal("injected failure: set_sealed"));
            }
            ensure_capability(this.state(), ws, id)?;
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .capabilities
                    .iter_mut()
                    .find(|c| c.capability.workspace_id == ws && c.capability.id == id)
                {
                    stored.sealed = sealed.clone();
                    stored.capability.updated_at = at;
                }
            });
            Ok(())
        })
    }

    async fn read_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError> {
        self.call(|this| {
            this.state()
                .capability_in(this.ws, id)
                .map(|c| c.sealed.clone())
                .ok_or_else(|| AppError::not_found("no such capability"))
        })
    }

    async fn set_iys_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if this.tx.set_sealed_fails() {
                return Err(AppError::internal("injected failure: set_iys_sealed"));
            }
            ensure_capability(this.state(), ws, id)?;
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .capabilities
                    .iter_mut()
                    .find(|c| c.capability.workspace_id == ws && c.capability.id == id)
                {
                    stored.iys_sealed = sealed.clone();
                    stored.capability.updated_at = at;
                }
            });
            Ok(())
        })
    }

    async fn lock_iys_snapshot(
        &mut self,
        id: CapabilityId,
    ) -> Result<Option<jt_app::ports::IysCapabilitySnapshot>, AppError> {
        let state = self.state();
        Ok(state
            .capability_in(self.ws, id)
            .map(|row| jt_app::ports::IysCapabilitySnapshot {
                capability: state.capability_view(row),
                sms_sealed: row.sealed.clone(),
                iys_sealed: row.iys_sealed.clone(),
            }))
    }

    async fn read_iys_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError> {
        self.call(|this| {
            this.state()
                .capability_in(this.ws, id)
                .map(|c| c.iys_sealed.clone())
                .ok_or_else(|| AppError::not_found("no such capability"))
        })
    }

    async fn set_status(
        &mut self,
        id: CapabilityId,
        status: StoredStatus,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            let current = state
                .capability_in(ws, id)
                .ok_or_else(|| AppError::not_found("no such capability"))?;
            account_free(state.account_taken(
                ws,
                &current.capability.kind_key,
                current.capability.external_id.as_deref(),
                status,
                id,
            ))?;
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .capabilities
                    .iter_mut()
                    .find(|c| c.capability.workspace_id == ws && c.capability.id == id)
                {
                    stored.capability.status = status;
                    stored.capability.updated_at = at;
                }
            });
            Ok(())
        })
    }

    async fn kinds_in_use(&mut self) -> Result<BTreeSet<String>, AppError> {
        Ok(self
            .state()
            .capabilities
            .iter()
            .map(|s| &s.capability)
            .filter(|c| c.workspace_id == self.ws && c.status != StoredStatus::Retired)
            .map(|c| c.kind_key.clone())
            .collect())
    }
}

#[async_trait]
impl CapabilityGroupRepo for MemTenant {
    async fn insert(&mut self, group: CapabilityGroup, at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, group.workspace_id)?;
            let state = this.state();
            unique(
                !state.capability_groups.iter().any(|g| {
                    g.group.id == group.id
                        || (g.group.workspace_id == ws
                            && g.group.name.to_lowercase() == group.name.to_lowercase())
                }),
                "the capability group id or name is already taken",
            )?;
            exists(
                state.workspace(ws).is_some(),
                "capability_groups.workspace_id",
            )?;
            let row = StoredCapabilityGroup {
                group,
                created_at: at,
            };
            this.tx
                .write(move |s| s.capability_groups.push(row.clone()));
            Ok(())
        })
    }

    async fn list(&mut self) -> Result<Vec<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        let state = self.state();
        let mut groups: Vec<&StoredCapabilityGroup> = state
            .capability_groups
            .iter()
            .filter(|g| g.group.workspace_id == self.ws)
            .collect();
        groups.sort_by_key(|g| (g.created_at, g.group.id));
        Ok(groups.into_iter().map(|g| state.group_view(g)).collect())
    }

    async fn find(
        &mut self,
        id: CapabilityGroupId,
    ) -> Result<Option<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        let state = self.state();
        Ok(state.group_in(self.ws, id).map(|g| state.group_view(g)))
    }

    async fn rename(&mut self, id: CapabilityGroupId, name: &str) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            ensure_group(state, ws, id)?;
            unique(
                !state.capability_groups.iter().any(|g| {
                    g.group.workspace_id == ws
                        && g.group.id != id
                        && g.group.name.to_lowercase() == name.to_lowercase()
                }),
                "the capability group name is already taken",
            )?;
            let name = name.to_owned();
            this.tx.write(move |s| {
                if let Some(g) = s
                    .capability_groups
                    .iter_mut()
                    .find(|g| g.group.workspace_id == ws && g.group.id == id)
                {
                    g.group.name = name.clone();
                }
            });
            Ok(())
        })
    }

    async fn delete(&mut self, id: CapabilityGroupId) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            ensure_group(this.state(), ws, id)?;
            this.tx.write(move |s| {
                s.capability_group_members
                    .retain(|m| !(m.workspace_id == ws && m.group_id == id));
                s.capability_groups
                    .retain(|g| !(g.group.workspace_id == ws && g.group.id == id));
            });
            Ok(())
        })
    }

    async fn add_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            ensure_group(state, ws, group)?;
            ensure_capability(state, ws, capability)?;
            let member = StoredGroupMember {
                workspace_id: ws,
                group_id: group,
                capability_id: capability,
            };
            if !state.capability_group_members.contains(&member) {
                this.tx
                    .write(move |s| s.capability_group_members.push(member));
            }
            Ok(())
        })
    }

    async fn remove_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let member = StoredGroupMember {
                workspace_id: this.ws,
                group_id: group,
                capability_id: capability,
            };
            if !this.state().capability_group_members.contains(&member) {
                return Err(AppError::not_found(
                    "the capability is not a member of the group",
                ));
            }
            this.tx
                .write(move |s| s.capability_group_members.retain(|m| *m != member));
            Ok(())
        })
    }
}

#[async_trait]
impl BudgetRepo for MemTenant {
    /// The cap's check constraint first, then the unique id, then the workspace reference, in the
    /// order Postgres checks them.
    async fn insert_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, item.workspace_id)?;
            if item.cap < 0 || item.unit_cost_minor.is_some_and(|p| p < 0) {
                return Err(AppError::internal("budget_items.cap must not be negative"));
            }
            let state = this.state();
            unique(
                !state.budget_items.iter().any(|i| i.id == item.id),
                "the budget item id is already taken",
            )?;
            exists(state.workspace(ws).is_some(), "budget_items.workspace_id")?;
            this.tx.write(move |s| s.budget_items.push(item.clone()));
            Ok(())
        })
    }

    async fn list_items(&mut self) -> Result<Vec<BudgetItem>, AppError> {
        let mut items: Vec<BudgetItem> = self
            .state()
            .budget_items
            .iter()
            .filter(|i| i.workspace_id == self.ws)
            .cloned()
            .collect();
        items.sort_by_key(|i| (i.created_at, i.id));
        Ok(items)
    }

    async fn find_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        Ok(self.state().item_in(self.ws, id).cloned())
    }

    /// The fakes run one bundle at a time in tests, so there is no one to wait for: `find_item`.
    async fn lock_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        self.tx.lock_studio().await;
        BudgetRepo::find_item(self, id).await
    }

    /// The bundle's workspace first, then the cap's check constraint, then the row, as `jt_pg`
    /// meets them; only the name, cap, period and retirement time are written.
    async fn update_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, item.workspace_id)?;
            if item.cap < 0 || item.unit_cost_minor.is_some_and(|p| p < 0) {
                return Err(AppError::internal("budget_items.cap must not be negative"));
            }
            ensure_item(this.state(), ws, item.id)?;
            this.tx.write(move |s| {
                if let Some(stored) = s
                    .budget_items
                    .iter_mut()
                    .find(|i| i.workspace_id == ws && i.id == item.id)
                {
                    stored.name = item.name.clone();
                    stored.cap = item.cap;
                    stored.unit_cost_minor = item.unit_cost_minor;
                    stored.period = item.period;
                    stored.retired_at = item.retired_at;
                }
            });
            Ok(())
        })
    }

    async fn unlink_item(&mut self, item: BudgetItemId) -> Result<u64, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let linked = this
                .state()
                .capability_budget_links
                .iter()
                .filter(|l| l.workspace_id == ws && l.budget_item_id == item)
                .count() as u64;
            if linked > 0 {
                this.tx.write(move |s| {
                    s.capability_budget_links
                        .retain(|l| !(l.workspace_id == ws && l.budget_item_id == item));
                });
            }
            Ok(linked)
        })
    }

    async fn link(&mut self, capability: CapabilityId, item: BudgetItemId) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let state = this.state();
            ensure_capability(state, ws, capability)?;
            ensure_item(state, ws, item)?;
            let link = StoredBudgetLink {
                workspace_id: ws,
                capability_id: capability,
                budget_item_id: item,
            };
            if !state.capability_budget_links.contains(&link) {
                this.tx.write(move |s| s.capability_budget_links.push(link));
            }
            Ok(())
        })
    }

    async fn unlink(
        &mut self,
        capability: CapabilityId,
        item: BudgetItemId,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let link = StoredBudgetLink {
                workspace_id: this.ws,
                capability_id: capability,
                budget_item_id: item,
            };
            if !this.state().capability_budget_links.contains(&link) {
                return Err(AppError::not_found(
                    "the capability is not linked to the budget item",
                ));
            }
            this.tx
                .write(move |s| s.capability_budget_links.retain(|l| *l != link));
            Ok(())
        })
    }

    /// The item reference first, as `jt_pg` checks it, then the amount's check constraint, then
    /// the unique id.
    async fn append_spend(&mut self, spend: BudgetSpend) -> Result<BudgetSpendId, AppError> {
        self.tx.lock_studio().await;
        self.call(|this| {
            let ws = this.ws;
            same_workspace(ws, spend.workspace_id)?;
            let state = this.state();
            ensure_item(state, ws, spend.budget_item_id)?;
            if spend.amount <= 0 {
                return Err(AppError::internal(
                    "budget_spend_entries.amount must be positive",
                ));
            }
            unique(
                !state.budget_spend.iter().any(|s| s.id == spend.id),
                "the spend entry id is already taken",
            )?;
            let id = spend.id;
            this.tx.write(move |s| s.budget_spend.push(spend.clone()));
            Ok(id)
        })
    }

    async fn spent_between(
        &mut self,
        item: BudgetItemId,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<i64, AppError> {
        let sum: i128 = self
            .state()
            .budget_spend
            .iter()
            .filter(|s| s.workspace_id == self.ws && s.budget_item_id == item)
            .filter(|s| s.at >= from && s.at < to)
            .map(|s| i128::from(s.amount))
            .sum();
        Ok(i64::try_from(sum).unwrap_or(i64::MAX))
    }

    async fn list_spend(
        &mut self,
        item: BudgetItemId,
        limit: u32,
        before: Option<(OffsetDateTime, BudgetSpendId)>,
    ) -> Result<Vec<BudgetSpend>, AppError> {
        let mut entries: Vec<BudgetSpend> = self
            .state()
            .budget_spend
            .iter()
            .filter(|s| s.workspace_id == self.ws && s.budget_item_id == item)
            .filter(|s| before.is_none_or(|before| (s.at, s.id) < before))
            .cloned()
            .collect();
        entries.sort_by_key(|s| std::cmp::Reverse((s.at, s.id)));
        entries.truncate(limit.clamp(1, MAX_SPEND_PAGE) as usize);
        Ok(entries)
    }
}

#[async_trait]
impl WorkspacePolicyRepo for MemTenant {
    async fn get(&mut self) -> Result<WorkspacePolicy, AppError> {
        Ok(self
            .state()
            .workspace_policies
            .iter()
            .find(|p| p.workspace_id == self.ws)
            .map(|p| p.policy.clone())
            .unwrap_or_default())
    }

    async fn set(&mut self, policy: WorkspacePolicy, at: OffsetDateTime) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            let bounds = MIN_AGENT_CHECKIN_INTERVAL_MINUTES..=MAX_AGENT_CHECKIN_INTERVAL_MINUTES;
            if !bounds.contains(&policy.agent_checkin_interval_minutes) {
                return Err(AppError::internal(
                    "workspace_policies.agent_checkin_interval_minutes is out of range",
                ));
            }
            exists(
                this.state().workspace(ws).is_some(),
                "workspace_policies.workspace_id",
            )?;
            if policy
                .inbox
                .status_labels
                .keys()
                .any(|key| !jt_app::ports::inbox::INBOX_STATUS_KEYS.contains(&key.as_str()))
            {
                return Err(AppError::internal("unknown inbox status label key"));
            }
            let row = StoredWorkspacePolicy {
                workspace_id: ws,
                policy,
                updated_at: at,
            };
            this.tx.write(move |s| {
                s.workspace_policies.retain(|p| p.workspace_id != ws);
                s.workspace_policies.push(row.clone());
            });
            Ok(())
        })
    }
}
