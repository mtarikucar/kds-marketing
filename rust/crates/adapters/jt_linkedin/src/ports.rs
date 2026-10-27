//! The connector ports of `jt_app`, implemented by [`LinkedinConnector`] over the modules beside
//! this one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, Asset, Connector, InsightsReader, OAuthApp, OAuthProvider, PostMetrics,
    PublishReceipt, PublishRequest, Publisher,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use url::Url;

use crate::{LINKEDIN_HOSTS, LinkedinConnector, account, insights, oauth, publish};

#[async_trait]
impl Connector for LinkedinConnector {
    fn provider(&self) -> Provider {
        Provider::Linkedin
    }

    fn hosts(&self) -> &'static [&'static str] {
        LINKEDIN_HOSTS
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        account::probe(self, cred, public).await
    }

    /// A renewed credential when `cred` holds a refresh token; `None` when it holds none (see the
    /// crate docs).
    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        oauth::refresh(self, cred).await
    }
}

#[async_trait]
impl OAuthProvider for LinkedinConnector {
    /// The authorize URL (see the crate docs); `Permanent` for an app that is not LinkedIn's. A
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

/// LinkedIn publishes synchronously: `resolve` keeps its default (the receipt is the post).
#[async_trait]
impl Publisher for LinkedinConnector {
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
impl InsightsReader for LinkedinConnector {
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
