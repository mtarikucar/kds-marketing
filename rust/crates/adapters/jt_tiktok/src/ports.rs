//! The connector ports of `jt_app`, implemented by [`TiktokConnector`] over the modules beside
//! this one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, AdAccountLimits, AdBudgetWriter, AdCampaignWriter, AdDay, AdInsights, AdLevel,
    AdObjective, AdPlacement, AdSet, AdSetSpec, AdSpec, AdStatus, Asset, CampaignProviderState,
    CampaignSpec, Connector, CreativeSpec, InsightsReader, LeadFormSpec, OAuthApp, OAuthProvider,
    PostMetrics, PublishReceipt, PublishRequest, PublishResolution, Publisher, RecentPost,
    TiktokCreator,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::Date;
use url::Url;

use crate::{TIKTOK_HOSTS, TiktokConnector, account, ads, insights, oauth, publish};

/// What this adapter does not do for an ad account of TikTok's: `what`, as a refusal.
fn not_offered(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("{what} is not offered for a TikTok ad account"))
}

#[async_trait]
impl Connector for TiktokConnector {
    fn provider(&self) -> Provider {
        Provider::Tiktok
    }

    fn hosts(&self) -> &'static [&'static str] {
        TIKTOK_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        account::probe(self, cred, public).await
    }

    /// A renewed credential when this one expires within [`crate::REFRESH_AHEAD`] (or has
    /// expired, or names no expiry); `None` otherwise.
    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        oauth::refresh(self, cred).await
    }

    /// Revokes the access token (see the crate docs, "Revocation").
    async fn revoke(&self, cred: &Credential) -> Result<(), ConnectorError> {
        oauth::revoke(self, cred).await
    }
}

#[async_trait]
impl OAuthProvider for TiktokConnector {
    /// The authorize URL (see the crate docs); `Permanent` for an app that is not TikTok's. A PKCE
    /// challenge is not put in it: TikTok's web flow takes none.
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Result<Url, ConnectorError> {
        oauth::authorize_url(self, app, redirect, state, pkce_challenge)
    }

    async fn exchange(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
    ) -> Result<Credential, ConnectorError> {
        oauth::exchange(self, app, redirect, code, pkce_verifier).await
    }

    async fn list_assets(&self, cred: &Credential) -> Result<Vec<Asset>, ConnectorError> {
        account::list_assets(self, cred).await
    }
}

#[async_trait]
impl Publisher for TiktokConnector {
    async fn publish(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
    ) -> Result<PublishReceipt, ConnectorError> {
        publish::publish(self, cred, public, request).await
    }

    /// Always `Some`: TikTok publishes in the background (see the crate docs, "Status").
    async fn resolve(
        &self,
        cred: &Credential,
        public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<Option<PublishResolution>, ConnectorError> {
        publish::resolve(self, cred, public, receipt).await
    }

    /// Always `Some`: a TikTok post is made on its posting screen (see the crate docs, "The
    /// posting screen").
    async fn creator_info(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Option<TiktokCreator>, ConnectorError> {
        publish::posting_creator(self, cred, public).await.map(Some)
    }
}

#[async_trait]
impl InsightsReader for TiktokConnector {
    async fn post_metrics(
        &self,
        cred: &Credential,
        public: &Value,
        post_id: &str,
    ) -> Result<PostMetrics, ConnectorError> {
        insights::post_metrics(self, cred, public, post_id).await
    }

    async fn account_metrics(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AccountMetrics, ConnectorError> {
        insights::account_metrics(self, cred, public).await
    }

    /// Always `Some`: one page of the video list (see the crate docs, "Counters").
    async fn recent_posts(
        &self,
        cred: &Credential,
        public: &Value,
        limit: u32,
    ) -> Result<Option<Vec<RecentPost>>, ConnectorError> {
        insights::recent_posts(self, cred, public, limit)
            .await
            .map(Some)
    }
}

/// Switching a campaign, an ad group or an ad on and off. The budget operations on ad sets that
/// already exist (design 2026-11-10's bound ad sets) are Meta's alone.
#[async_trait]
impl AdBudgetWriter for TiktokConnector {
    async fn set_status(
        &self,
        cred: &Credential,
        entity_id: &str,
        status: AdStatus,
    ) -> Result<(), ConnectorError> {
        ads::set_status(self, cred, entity_id, status).await
    }

    async fn set_daily_budget(
        &self,
        _cred: &Credential,
        _entity_id: &str,
        _minor: i64,
    ) -> Result<(), ConnectorError> {
        Err(not_offered("changing a daily budget"))
    }

    async fn list_adsets(
        &self,
        _cred: &Credential,
        _public: &Value,
    ) -> Result<Vec<AdSet>, ConnectorError> {
        Err(not_offered("listing ad sets"))
    }

    async fn insights(
        &self,
        _cred: &Credential,
        _public: &Value,
        _since: Date,
        _until: Date,
    ) -> Result<Vec<AdInsights>, ConnectorError> {
        Err(not_offered("the account's results by campaign"))
    }
}

/// A campaign as TikTok holds it (see the crate docs, "Ad campaigns"): a campaign, the level
/// under it an ad group, an ad a one-image carousel that carries its own content.
#[async_trait]
impl AdCampaignWriter for TiktokConnector {
    async fn account_limits(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AdAccountLimits, ConnectorError> {
        ads::account_limits(self, cred, public).await
    }

    async fn find_by_name(
        &self,
        cred: &Credential,
        public: &Value,
        level: AdLevel,
        name: &str,
    ) -> Result<Option<String>, ConnectorError> {
        ads::find_by_name(self, cred, public, level, name).await
    }

    async fn create_campaign(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CampaignSpec,
    ) -> Result<String, ConnectorError> {
        ads::create_campaign(self, cred, public, spec).await
    }

    async fn create_adset(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSetSpec,
    ) -> Result<String, ConnectorError> {
        ads::create_adset(self, cred, public, spec).await
    }

    async fn upload_image(
        &self,
        cred: &Credential,
        public: &Value,
        bytes: &[u8],
        name: &str,
    ) -> Result<String, ConnectorError> {
        ads::upload_image(self, cred, public, bytes, name).await
    }

    async fn create_lead_form(
        &self,
        _page_cred: &Credential,
        _page_public: &Value,
        _spec: &LeadFormSpec,
    ) -> Result<String, ConnectorError> {
        Err(not_offered("a lead form"))
    }

    /// Nothing is sent: a TikTok ad carries its own content, made by the ad step.
    async fn create_creative(
        &self,
        _cred: &Credential,
        public: &Value,
        spec: &CreativeSpec,
    ) -> Result<String, ConnectorError> {
        ads::create_creative(public, spec)
    }

    async fn create_ad(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSpec,
    ) -> Result<String, ConnectorError> {
        ads::create_ad(self, cred, public, spec).await
    }

    async fn campaign_state(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
    ) -> Result<CampaignProviderState, ConnectorError> {
        ads::campaign_state(self, cred, public, campaign_id).await
    }

    async fn ad_days(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
        objective: AdObjective,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdDay>, ConnectorError> {
        ads::ad_days(self, cred, public, campaign_id, objective, since, until).await
    }

    /// TikTok's ad preview is not read here.
    async fn preview(
        &self,
        _cred: &Credential,
        _public: &Value,
        _creative: &CreativeSpec,
        _placement: AdPlacement,
    ) -> Result<String, ConnectorError> {
        Err(not_offered("an ad preview"))
    }
}
