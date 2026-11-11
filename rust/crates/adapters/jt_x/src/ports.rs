//! The connector ports of `jt_app`, implemented by [`XConnector`] over the modules beside this
//! one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, AdAccountLimits, AdBudgetWriter, AdCampaignWriter, AdDay, AdInsights, AdLevel,
    AdObjective, AdPlacement, AdSet, AdSetSpec, AdSpec, AdStatus, Asset, CampaignProviderState,
    CampaignSpec, Connector, CreativeSpec, InsightsReader, LeadFormSpec, OAuthApp, OAuthProvider,
    PostMetrics, PublishReceipt, PublishRequest, Publisher,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::Date;
use url::Url;

use crate::{X_HOSTS, XConnector, account, ads, insights, oauth, publish};

/// What this adapter does not do for an ads account of X's: `what`, as a refusal.
fn not_offered(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("{what} is not offered for an X ads account"))
}

#[async_trait]
impl Connector for XConnector {
    fn provider(&self) -> Provider {
        Provider::X
    }

    fn hosts(&self) -> &'static [&'static str] {
        X_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        account::probe(self, cred, public).await
    }

    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        oauth::refresh(self, cred).await
    }
}

#[async_trait]
impl OAuthProvider for XConnector {
    /// The authorize URL (see the crate docs); `Permanent` ("pkce required") without a PKCE
    /// challenge, and for an app that is not X's.
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
impl Publisher for XConnector {
    async fn publish(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
    ) -> Result<PublishReceipt, ConnectorError> {
        publish::publish(self, cred, public, request).await
    }
}

#[async_trait]
impl InsightsReader for XConnector {
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
}

/// Switching a campaign, a line item or an ad on and off. The budget operations on ad sets that
/// already exist (design 2026-11-10's bound ad sets) are Meta's alone.
#[async_trait]
impl AdBudgetWriter for XConnector {
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

/// A campaign as X holds it (see the crate docs, "Ad campaigns"): a campaign, the level under
/// it a line item, the creative a website card, an ad a promoted-only post promoted in the line
/// item.
#[async_trait]
impl AdCampaignWriter for XConnector {
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

    async fn create_creative(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CreativeSpec,
    ) -> Result<String, ConnectorError> {
        ads::create_creative(self, cred, public, spec).await
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

    /// X's ad preview is not read here.
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
