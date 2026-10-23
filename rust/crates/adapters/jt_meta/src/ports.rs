//! The connector ports of `jt_app`, implemented by [`MetaConnector`] over the modules beside this
//! one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, AdBudgetWriter, AdInsights, AdSet, Asset, Connector, InsightsReader,
    LeadGenFetcher, LeadGenRecord, MessagingSender, OAuthApp, OAuthProvider, PostMetrics,
    PublishReceipt, PublishRequest, Publisher, SendReceipt,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::Date;
use url::Url;

use crate::{
    META_HOSTS, MetaConnector, ads, assets, insights, leadgen, messaging, oauth, probe, publish,
};

#[async_trait]
impl Connector for MetaConnector {
    fn provider(&self) -> Provider {
        Provider::Meta
    }

    fn hosts(&self) -> &'static [&'static str] {
        META_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        probe::probe(self, cred, public).await
    }

    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        oauth::refresh(self, cred).await
    }

    async fn on_connected(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Value, ConnectorError> {
        probe::on_connected(self, cred, public).await
    }
}

#[async_trait]
impl OAuthProvider for MetaConnector {
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
        assets::list_assets(self, cred).await
    }
}

#[async_trait]
impl Publisher for MetaConnector {
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
impl InsightsReader for MetaConnector {
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

#[async_trait]
impl MessagingSender for MetaConnector {
    async fn send_text(
        &self,
        cred: &Credential,
        public: &Value,
        recipient_id: &str,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        messaging::send_text(self, cred, public, recipient_id, text).await
    }
}

#[async_trait]
impl LeadGenFetcher for MetaConnector {
    async fn fetch(
        &self,
        cred: &Credential,
        leadgen_id: &str,
    ) -> Result<LeadGenRecord, ConnectorError> {
        leadgen::fetch(self, cred, leadgen_id).await
    }
}

#[async_trait]
impl AdBudgetWriter for MetaConnector {
    async fn set_status(
        &self,
        cred: &Credential,
        entity_id: &str,
        status: jt_app::ports::connectors::AdStatus,
    ) -> Result<(), ConnectorError> {
        ads::set_status(self, cred, entity_id, status).await
    }
    async fn account_context(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<jt_app::ports::connectors::AdAccountContext, ConnectorError> {
        ads::account_context(self, cred, public).await
    }
    async fn adset_insights(
        &self,
        cred: &Credential,
        public: &Value,
        since: Date,
        until: Date,
    ) -> Result<Vec<jt_app::ports::connectors::AdSetInsights>, ConnectorError> {
        ads::adset_insights(self, cred, public, since, until).await
    }
    async fn resolve_adset(
        &self,
        cred: &Credential,
        public: &Value,
        ad_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        ads::resolve_adset(self, cred, public, ad_id).await
    }

    async fn set_daily_budget(
        &self,
        cred: &Credential,
        entity_id: &str,
        minor: i64,
    ) -> Result<(), ConnectorError> {
        ads::set_daily_budget(self, cred, entity_id, minor).await
    }

    async fn list_adsets(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Vec<AdSet>, ConnectorError> {
        ads::list_adsets(self, cred, public).await
    }

    async fn insights(
        &self,
        cred: &Credential,
        public: &Value,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdInsights>, ConnectorError> {
        ads::insights(self, cred, public, since, until).await
    }
}
