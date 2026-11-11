//! The connector ports of `jt_app`, implemented by [`GoogleConnector`] over the modules beside
//! this one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AdAccountLimits, AdBudgetWriter, AdCampaignWriter, AdDay, AdInsights, AdLevel, AdObjective,
    AdPlacement, AdSet, AdSetSpec, AdSpec, AdStatus, Asset, CampaignProviderState, CampaignSpec,
    Connector, CreativeSpec, LeadFormSpec, OAuthApp, OAuthProvider,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::Date;
use url::Url;

use crate::{GOOGLE_HOSTS, GoogleConnector, account, campaigns, oauth, reads};

/// What this adapter does not do for an ad account of Google's: `what`, as a refusal.
fn not_offered(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("{what} is not offered for a Google Ads account"))
}

#[async_trait]
impl Connector for GoogleConnector {
    fn provider(&self) -> Provider {
        Provider::Google
    }

    fn hosts(&self) -> &'static [&'static str] {
        GOOGLE_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        account::probe(self, cred, public).await
    }

    /// A renewed credential when `cred` holds a refresh token; `None` when it holds none.
    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        oauth::refresh(self, cred).await
    }

    /// Revokes the grant at Google: the account is disconnected there too.
    async fn revoke(&self, cred: &Credential) -> Result<(), ConnectorError> {
        oauth::revoke(self, cred).await
    }
}

#[async_trait]
impl OAuthProvider for GoogleConnector {
    /// The authorize URL (see the crate docs); `Permanent` for an app that is not Google's. A
    /// PKCE challenge is not sent.
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

/// Switching a campaign, an ad group or an ad on and off. The budget operations on ad sets that
/// already exist (design 2026-11-10's bound ad sets) are Meta's alone.
#[async_trait]
impl AdBudgetWriter for GoogleConnector {
    async fn set_status(
        &self,
        cred: &Credential,
        entity_id: &str,
        status: AdStatus,
    ) -> Result<(), ConnectorError> {
        campaigns::set_status(self, cred, entity_id, status).await
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

#[async_trait]
impl AdCampaignWriter for GoogleConnector {
    async fn account_limits(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AdAccountLimits, ConnectorError> {
        campaigns::account_limits(self, cred, public).await
    }

    async fn find_by_name(
        &self,
        cred: &Credential,
        public: &Value,
        level: AdLevel,
        name: &str,
    ) -> Result<Option<String>, ConnectorError> {
        campaigns::find_by_name(self, cred, public, level, name).await
    }

    async fn create_campaign(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CampaignSpec,
    ) -> Result<String, ConnectorError> {
        campaigns::create_campaign(self, cred, public, spec).await
    }

    async fn create_adset(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSetSpec,
    ) -> Result<String, ConnectorError> {
        campaigns::create_adset(self, cred, public, spec).await
    }

    /// A search ad shows no image.
    async fn upload_image(
        &self,
        _cred: &Credential,
        _public: &Value,
        _bytes: &[u8],
        _name: &str,
    ) -> Result<String, ConnectorError> {
        Err(not_offered("an image"))
    }

    async fn create_lead_form(
        &self,
        _page_cred: &Credential,
        _page_public: &Value,
        _spec: &LeadFormSpec,
    ) -> Result<String, ConnectorError> {
        Err(not_offered("a lead form"))
    }

    /// Nothing is sent: a search ad carries its own texts (see the crate docs).
    async fn create_creative(
        &self,
        _cred: &Credential,
        public: &Value,
        spec: &CreativeSpec,
    ) -> Result<String, ConnectorError> {
        campaigns::create_creative(public, spec)
    }

    async fn create_ad(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSpec,
    ) -> Result<String, ConnectorError> {
        campaigns::create_ad(self, cred, public, spec).await
    }

    async fn campaign_state(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
    ) -> Result<CampaignProviderState, ConnectorError> {
        reads::campaign_state(self, cred, public, campaign_id).await
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
        reads::ad_days(self, cred, public, campaign_id, objective, since, until).await
    }

    /// Google shows no preview of a search ad through its API.
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
