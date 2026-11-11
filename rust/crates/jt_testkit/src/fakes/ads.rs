//! The in-memory ad campaigns, with `jt_pg`'s rules: the revision compare-and-swap, the lists'
//! order and page sizes, and the closed mark.
use super::state::MemBundle;
use super::tenant::MemTenant;
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::ads::{AdCampaign, AdsRepo, CampaignScope},
};
use time::OffsetDateTime;
use uuid::Uuid;

/// A stored campaign with its closed mark.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredCampaign {
    pub campaign: AdCampaign,
    pub closed_at: Option<OffsetDateTime>,
}

#[async_trait]
impl AdsRepo for MemTenant {
    async fn get_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError> {
        Ok(self
            .state()
            .ads_campaigns
            .iter()
            .find(|r| r.campaign.workspace_id == self.ws && r.campaign.id == id)
            .map(|r| r.campaign.clone()))
    }
    async fn lock_campaign(&mut self, id: Uuid) -> Result<Option<AdCampaign>, AppError> {
        self.tx.lock_studio().await;
        self.get_campaign(id).await
    }
    async fn list_campaigns(
        &mut self,
        scope: CampaignScope,
        before: Option<OffsetDateTime>,
    ) -> Result<Vec<AdCampaign>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<_> = self
            .state()
            .ads_campaigns
            .iter()
            .filter(|r| r.campaign.workspace_id == ws)
            .filter(|r| match scope {
                CampaignScope::Open => r.closed_at.is_none(),
                CampaignScope::Closed => {
                    r.closed_at.is_some_and(|at| before.is_none_or(|b| at < b))
                }
            })
            .cloned()
            .collect();
        match scope {
            CampaignScope::Open => {
                rows.sort_by_key(|r| (r.campaign.start_at, r.campaign.id));
                rows.truncate(200);
            }
            CampaignScope::Closed => {
                rows.sort_by_key(|r| std::cmp::Reverse((r.closed_at, r.campaign.id)));
                rows.truncate(51);
            }
        }
        Ok(rows.into_iter().map(|r| r.campaign).collect())
    }
    async fn list_winding_down(
        &mut self,
        since: OffsetDateTime,
    ) -> Result<Vec<AdCampaign>, AppError> {
        let ws = self.ws;
        let mut rows: Vec<_> = self
            .state()
            .ads_campaigns
            .iter()
            .filter(|r| r.campaign.workspace_id == ws)
            .filter(|r| {
                let activated = r
                    .campaign
                    .built
                    .as_ref()
                    .is_some_and(|b| b.activated_at.is_some());
                activated
                    && r.closed_at
                        .is_some_and(|at| at > since || r.campaign.at_provider())
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.closed_at, r.campaign.id));
        rows.truncate(200);
        Ok(rows.into_iter().map(|r| r.campaign).collect())
    }
    async fn save_campaign(
        &mut self,
        mut c: AdCampaign,
        expected: Option<u64>,
        closed_at: Option<OffsetDateTime>,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        self.call(|this| {
            if c.workspace_id != this.ws {
                return Err(AppError::internal("ad campaign workspace mismatch"));
            }
            if c.revision != expected.unwrap_or(0).saturating_add(1) {
                return Err(AppError::conflict("ad campaign revision changed"));
            }
            c.state = None;
            c.totals = None;
            let ws = this.ws;
            let stored = this
                .state()
                .ads_campaigns
                .iter()
                .find(|r| r.campaign.workspace_id == ws && r.campaign.id == c.id)
                .map(|r| r.campaign.revision);
            if stored != expected {
                return Err(AppError::conflict("ad campaign revision changed"));
            }
            let row = StoredCampaign {
                campaign: c.clone(),
                closed_at,
            };
            this.tx.write(move |s| {
                s.ads_campaigns.retain(|r| {
                    !(r.campaign.workspace_id == ws && r.campaign.id == row.campaign.id)
                });
                s.ads_campaigns.push(row.clone());
            });
            Ok(())
        })
    }
}
