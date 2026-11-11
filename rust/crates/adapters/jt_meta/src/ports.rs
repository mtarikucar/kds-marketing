//! The connector ports of `jt_app`, implemented by [`MetaConnector`] over the modules beside this
//! one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AdAccountLimits, AdCampaignWriter, AdDay, AdLevel, AdObjective, AdPlacement, AdSetSpec, AdSpec,
    CampaignProviderState, CampaignSpec, CreativeSpec, LeadFormSpec,
};

use jt_app::ports::connectors::{
    AccountMetrics, AdBudgetWriter, AdInsights, AdSet, AppSync, Asset, Connector,
    InboundEventDraft, InsightsReader, LeadGenFetcher, LeadGenRecord, MessagingSender,
    ModerationAction, OAuthApp, OAuthFlow, OAuthProvider, PostMetrics, PrivateReceipt,
    PublicPoller, PublicSurface, PublicTarget, PublishReceipt, PublishRequest, Publisher,
    Scheduled, SendReceipt, SubjectFacts,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::Date;
use url::Url;

use crate::{
    META_HOSTS, MetaConnector, ads, assets, comments, insights, leadgen, messaging, oauth, probe,
    publish, schedule,
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

    fn authorize_url_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Url, ConnectorError> {
        oauth::authorize_url_for(self, app, redirect, state, pkce_challenge, flow)
    }

    async fn exchange_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Credential, ConnectorError> {
        oauth::exchange_for(self, app, redirect, code, pkce_verifier, flow).await
    }

    async fn list_assets_for(
        &self,
        cred: &Credential,
        flow: Option<OAuthFlow>,
    ) -> Result<Vec<Asset>, ConnectorError> {
        assets::list_assets_for(self, cred, flow).await
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

    async fn read_back(
        &self,
        cred: &Credential,
        public: &Value,
        external_id: &str,
    ) -> Result<(), ConnectorError> {
        publish::read_back(self, cred, public, external_id).await
    }

    fn schedule_window(
        &self,
        public: &Value,
        request: &PublishRequest,
    ) -> Option<(time::Duration, time::Duration)> {
        schedule::window(public, request)
    }

    async fn schedule(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
        at: time::OffsetDateTime,
    ) -> Result<PublishReceipt, ConnectorError> {
        schedule::schedule(self, cred, public, request, at).await
    }

    async fn scheduled(
        &self,
        cred: &Credential,
        public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<Scheduled, ConnectorError> {
        schedule::scheduled(self, cred, public, receipt).await
    }

    async fn withdraw(
        &self,
        cred: &Credential,
        public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<bool, ConnectorError> {
        schedule::withdraw(self, cred, public, receipt).await
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

    async fn sender_name(
        &self,
        cred: &Credential,
        public: &Value,
        sender_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        messaging::sender_name(self, cred, public, sender_id).await
    }

    async fn request_app_sync(
        &self,
        cred: &Credential,
        public: &Value,
        sync: AppSync,
    ) -> Result<Option<SendReceipt>, ConnectorError> {
        messaging::request_app_sync(self, cred, public, sync).await
    }
}

#[async_trait]
impl PublicSurface for MetaConnector {
    async fn reply_public(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        comments::reply_public(self, cred, public, target, text).await
    }

    async fn reply_private(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<PrivateReceipt, ConnectorError> {
        comments::reply_private(self, cred, public, target, text).await
    }

    async fn moderate(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        action: ModerationAction,
    ) -> Result<(), ConnectorError> {
        comments::moderate(self, cred, public, target, action).await
    }

    async fn subject(
        &self,
        cred: &Credential,
        public: &Value,
        subject_external_id: &str,
    ) -> Result<Option<SubjectFacts>, ConnectorError> {
        comments::subject(self, cred, public, subject_external_id).await
    }
}

#[async_trait]
impl PublicPoller for MetaConnector {
    async fn poll(
        &self,
        _ws: WorkspaceId,
        cred: &Credential,
        public: &Value,
        cursor: &Value,
    ) -> Result<(Vec<InboundEventDraft>, Value), ConnectorError> {
        comments::poll(self, cred, public, cursor).await
    }

    async fn reconcile(
        &self,
        cred: &Credential,
        public: &Value,
        targets: &[PublicTarget],
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        comments::reconcile(self, cred, public, targets).await
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

#[async_trait]
impl AdCampaignWriter for MetaConnector {
    async fn account_limits(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AdAccountLimits, ConnectorError> {
        crate::campaigns::account_limits(self, cred, public).await
    }
    async fn find_by_name(
        &self,
        cred: &Credential,
        public: &Value,
        level: AdLevel,
        name: &str,
    ) -> Result<Option<String>, ConnectorError> {
        crate::campaigns::find_by_name(self, cred, public, level, name).await
    }
    async fn create_campaign(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CampaignSpec,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::create_campaign(self, cred, public, spec).await
    }
    async fn create_adset(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSetSpec,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::create_adset(self, cred, public, spec).await
    }
    async fn upload_image(
        &self,
        cred: &Credential,
        public: &Value,
        bytes: &[u8],
        name: &str,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::upload_image(self, cred, public, bytes, name).await
    }
    async fn create_lead_form(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &LeadFormSpec,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::create_lead_form(self, cred, public, spec).await
    }
    async fn create_creative(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CreativeSpec,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::create_creative(self, cred, public, spec).await
    }
    async fn create_ad(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSpec,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::create_ad(self, cred, public, spec).await
    }
    async fn campaign_state(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
    ) -> Result<CampaignProviderState, ConnectorError> {
        crate::campaigns::campaign_state(self, cred, public, campaign_id).await
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
        crate::campaigns::ad_days(self, cred, public, campaign_id, objective, since, until).await
    }
    async fn preview(
        &self,
        cred: &Credential,
        public: &Value,
        creative: &CreativeSpec,
        placement: AdPlacement,
    ) -> Result<String, ConnectorError> {
        crate::campaigns::preview(self, cred, public, creative, placement).await
    }
}
