//! The connector ports of `jt_app`, implemented by [`XConnector`] over the modules beside this
//! one.

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, Asset, Connector, InsightsReader, OAuthApp, OAuthProvider, PostMetrics,
    PublishReceipt, PublishRequest, Publisher,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use url::Url;

use crate::{X_HOSTS, XConnector, account, insights, oauth, publish};

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
    /// [`XConnector::try_authorize_url`], or `about:blank` (a page that starts no flow) when it
    /// refuses: without a PKCE challenge, or for an app that is not X's.
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Url {
        self.try_authorize_url(app, redirect, state, pkce_challenge)
            .unwrap_or_else(|e| {
                tracing::warn!(error_kind = e.kind(), "refused to build an X authorize URL");
                Url::parse("about:blank").expect("a valid URL")
            })
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
