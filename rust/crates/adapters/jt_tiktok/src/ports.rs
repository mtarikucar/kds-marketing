//! The connector ports of `jt_app`, implemented by [`TiktokConnector`] over the modules beside
//! this one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, Asset, Connector, InsightsReader, OAuthApp, OAuthProvider, PostMetrics,
    PublishReceipt, PublishRequest, PublishResolution, Publisher, TiktokCreator,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use url::Url;

use crate::{TIKTOK_HOSTS, TiktokConnector, account, insights, oauth, publish};

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
}
