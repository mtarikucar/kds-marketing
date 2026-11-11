//! The in-memory store of olay-driven publishing, with the constraints migration
//! `0022_studio_posts` enforces: one post per slot of the same workspace, naming a stored package
//! request and (when it has one) an olay of the workspace, its times ordered, and nothing of it
//! changing but its retirement, recorded once; one package request per key, its key, trigger and
//! creation fixed and only an open one changing; one posting policy row per workspace.

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::posts::*;
use jt_studio::SlotId;
use jt_tenancy::WorkspaceId;

use super::state::{MemBundle, exists, unique};
use super::tenant::MemTenant;

/// The workspaces' posts, package requests and posting settings, as the fake stores them.
#[derive(Clone, Debug, Default)]
pub struct MemPosts {
    pub posts: Vec<PlannedPost>,
    pub requests: Vec<PackageRequest>,
    pub settings: Vec<(WorkspaceId, PostingSettings)>,
    /// The social accounts' daily snapshots: one per account and day.
    pub account_days: Vec<AccountDay>,
}

impl MemTenant {
    fn store(&self) -> &MemPosts {
        &self.state().posts
    }
}

#[async_trait]
impl PostRepo for MemTenant {
    async fn insert_post(&mut self, post: PlannedPost) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            if post.workspace_id != ws {
                return Err(AppError::internal("post of another workspace"));
            }
            post.validate()
                .map_err(|e| AppError::internal(format!("studio_posts check: {e}")))?;
            if post.retired.is_some() {
                return Err(AppError::internal("studio_posts: a post is stored live"));
            }
            exists(
                this.state()
                    .studio
                    .slots
                    .iter()
                    .any(|s| s.chain.workspace_id == ws && s.id == post.slot_id),
                "studio_posts.slot_id",
            )
            .map_err(|_| AppError::not_found("slot"))?;
            exists(
                this.store()
                    .requests
                    .iter()
                    .any(|r| r.workspace_id == ws && r.id == post.package_request_id),
                "studio_posts.package_request_id",
            )
            .map_err(|_| AppError::not_found("package request"))?;
            if let Some(olay) = post.olay_id
                && !this
                    .state()
                    .materials
                    .olays
                    .iter()
                    .any(|o| o.workspace_id == ws && o.id == olay)
            {
                return Err(AppError::not_found("olay"));
            }
            unique(
                !this
                    .store()
                    .posts
                    .iter()
                    .any(|p| p.workspace_id == ws && p.slot_id == post.slot_id),
                "insert post: the value is already taken",
            )?;
            this.tx.write(move |s| s.posts.posts.push(post.clone()));
            Ok(())
        })
    }

    async fn get_post(&mut self, slot: SlotId) -> Result<Option<PlannedPost>, AppError> {
        let ws = self.ws;
        Ok(self
            .store()
            .posts
            .iter()
            .find(|p| p.workspace_id == ws && p.slot_id == slot)
            .cloned())
    }

    async fn list_posts(&mut self) -> Result<Vec<PlannedPost>, AppError> {
        let ws = self.ws;
        let mut out: Vec<PlannedPost> = self
            .store()
            .posts
            .iter()
            .filter(|p| p.workspace_id == ws)
            .cloned()
            .collect();
        out.sort_by_key(|p| (p.publish_at, p.slot_id));
        Ok(out)
    }

    async fn retire_post(
        &mut self,
        slot: SlotId,
        retired: PostRetirement,
    ) -> Result<bool, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let post = this
                .store()
                .posts
                .iter()
                .find(|p| p.workspace_id == ws && p.slot_id == slot)
                .ok_or_else(|| AppError::not_found("post"))?;
            if post.retired.is_some() {
                return Ok(false);
            }
            this.tx.write(move |s| {
                if let Some(p) = s
                    .posts
                    .posts
                    .iter_mut()
                    .find(|p| p.workspace_id == ws && p.slot_id == slot)
                {
                    p.retired = Some(retired);
                }
            });
            Ok(true)
        })
    }

    async fn insert_package_request(&mut self, request: PackageRequest) -> Result<bool, AppError> {
        self.call(|this| {
            let ws = this.ws;
            if request.workspace_id != ws {
                return Err(AppError::internal("request of another workspace"));
            }
            request
                .validate()
                .map_err(|e| AppError::internal(format!("studio_package_requests check: {e}")))?;
            if this
                .store()
                .requests
                .iter()
                .any(|r| r.workspace_id == ws && r.key == request.key)
            {
                return Ok(false);
            }
            unique(
                !this.store().requests.iter().any(|r| r.id == request.id),
                "insert package request: the value is already taken",
            )?;
            this.tx
                .write(move |s| s.posts.requests.push(request.clone()));
            Ok(true)
        })
    }

    async fn update_package_request(&mut self, request: PackageRequest) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            request
                .validate()
                .map_err(|e| AppError::internal(format!("studio_package_requests check: {e}")))?;
            let current = this
                .store()
                .requests
                .iter()
                .find(|r| r.workspace_id == ws && r.id == request.id)
                .ok_or_else(|| AppError::not_found("package request"))?;
            if current.key != request.key
                || current.trigger != request.trigger
                || current.created_at != request.created_at
            {
                return Err(AppError::internal(
                    "studio_package_requests: the key, trigger and creation never change",
                ));
            }
            if current.status != PackageStatus::Open {
                return Err(AppError::conflict("the package request is closed"));
            }
            this.tx.write(move |s| {
                if let Some(r) = s
                    .posts
                    .requests
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == request.id)
                {
                    *r = request.clone();
                }
            });
            Ok(())
        })
    }

    async fn get_package_request(
        &mut self,
        id: PackageRequestId,
    ) -> Result<Option<PackageRequest>, AppError> {
        let ws = self.ws;
        Ok(self
            .store()
            .requests
            .iter()
            .find(|r| r.workspace_id == ws && r.id == id)
            .cloned())
    }

    async fn list_package_requests(&mut self) -> Result<Vec<PackageRequest>, AppError> {
        let ws = self.ws;
        let mut out: Vec<PackageRequest> = self
            .store()
            .requests
            .iter()
            .filter(|r| r.workspace_id == ws)
            .cloned()
            .collect();
        out.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.id)));
        Ok(out)
    }

    async fn insert_account_day(&mut self, day: AccountDay) -> Result<bool, AppError> {
        self.call(|this| {
            if day.workspace_id != this.ws {
                return Err(AppError::internal("account day of another workspace"));
            }
            // The account is the same workspace's (the table's composite foreign key).
            exists(
                this.state().capabilities.iter().any(|c| {
                    c.capability.workspace_id == this.ws && c.capability.id == day.capability_id
                }),
                "social_account_days.capability_id",
            )?;
            if this.store().account_days.iter().any(|d| {
                d.workspace_id == day.workspace_id
                    && d.capability_id == day.capability_id
                    && d.day == day.day
            }) {
                return Ok(false);
            }
            this.tx
                .write(move |s| s.posts.account_days.push(day.clone()));
            Ok(true)
        })
    }

    async fn account_days(
        &mut self,
        capability: jt_capability::CapabilityId,
        from: time::Date,
        until: time::Date,
    ) -> Result<Vec<AccountDay>, AppError> {
        let ws = self.ws;
        let mut days: Vec<_> = self
            .store()
            .account_days
            .iter()
            .filter(|d| {
                d.workspace_id == ws
                    && d.capability_id == capability
                    && d.day >= from
                    && d.day <= until
            })
            .cloned()
            .collect();
        days.sort_by_key(|d| d.day);
        Ok(days)
    }

    async fn latest_account_days(&mut self) -> Result<Vec<AccountDay>, AppError> {
        let ws = self.ws;
        let mut latest: std::collections::BTreeMap<jt_capability::CapabilityId, AccountDay> =
            Default::default();
        for d in self
            .store()
            .account_days
            .iter()
            .filter(|d| d.workspace_id == ws)
        {
            if latest.get(&d.capability_id).is_none_or(|x| x.day < d.day) {
                latest.insert(d.capability_id, d.clone());
            }
        }
        Ok(latest.into_values().collect())
    }

    async fn purge_account_days(&mut self, before: time::Date) -> Result<u64, AppError> {
        self.call(|this| {
            let ws = this.ws;
            let gone = this
                .store()
                .account_days
                .iter()
                .filter(|d| d.workspace_id == ws && d.day < before)
                .count();
            this.tx.write(move |s| {
                s.posts
                    .account_days
                    .retain(|d| d.workspace_id != ws || d.day >= before)
            });
            Ok(gone as u64)
        })
    }

    async fn posting_settings(&mut self) -> Result<PostingSettings, AppError> {
        let ws = self.ws;
        Ok(self
            .store()
            .settings
            .iter()
            .find(|(w, _)| *w == ws)
            .map(|(_, s)| s.clone())
            .unwrap_or_default())
    }

    async fn save_posting_settings(&mut self, settings: PostingSettings) -> Result<(), AppError> {
        self.call(|this| {
            let ws = this.ws;
            settings
                .policy
                .validate()
                .map_err(|e| AppError::internal(format!("studio_posting_policy check: {e}")))?;
            if settings.tz.is_empty() || settings.tz.len() > 64 {
                return Err(AppError::internal("studio_posting_policy check: tz"));
            }
            this.tx.write(move |s| {
                s.posts.settings.retain(|(w, _)| *w != ws);
                s.posts.settings.push((ws, settings.clone()));
            });
            Ok(())
        })
    }
}
