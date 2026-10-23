//! Fakes for the connector ports: a configurable [`FakeAppConfig`], and scripted provider
//! adapters ([`ScriptedConnector`], [`ScriptedOAuth`]) handed out by a [`ScriptedRegistry`].
//!
//! A scripted adapter answers each method with the results a test queued for that method, in
//! order, and records every call (with its arguments) for assertions; a [`ScriptedConnector`]
//! names the hosts it was given ([`ScriptedConnector::with_hosts`], none by default). A call with nothing queued
//! panics, naming the provider and the method: the test scripted too few answers. The one
//! exception is [`Connector::on_connected`], which every connection runs: with nothing queued it
//! answers `Ok(Value::Null)`, as the trait's default does. Nothing reaches a network.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, AdBudgetWriter, AdInsights, AdSet, Asset, Connector, ConnectorRegistry,
    ConsentRow, ConsentSync, InsightsReader, InstagramApp, LeadGenFetcher, LeadGenRecord,
    MessagingSender, MetaApp, OAuthApp, OAuthProvider, PlatformAppConfig, PostMetrics,
    PublishReceipt, PublishRequest, Publisher, SendReceipt, SmsSender, Telephony, Url, XApp,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use serde_json::Value;
use time::Date;

use super::state::lock;

// ---------------------------------------------------------------------------------------------
// Platform apps
// ---------------------------------------------------------------------------------------------

/// The address [`FakeAppConfig::default`] answers.
pub const TEST_PUBLIC_BASE_URL: &str = "https://panel.test";

/// A platform app configuration a test sets field by field. The default has no app at all and
/// the public address [`TEST_PUBLIC_BASE_URL`]; [`FakeAppConfig::with_all_apps`] has all three.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeAppConfig {
    pub meta: Option<MetaApp>,
    pub instagram: Option<InstagramApp>,
    pub x: Option<XApp>,
    pub public_base_url: Url,
}

impl Default for FakeAppConfig {
    fn default() -> Self {
        FakeAppConfig {
            meta: None,
            instagram: None,
            x: None,
            public_base_url: Url::parse(TEST_PUBLIC_BASE_URL).expect("a valid test URL"),
        }
    }
}

impl FakeAppConfig {
    /// Every app configured, with test values (`meta-app-id`/`meta-app-secret`, verify token
    /// `meta-verify-token`; `instagram-app-id`/`instagram-app-secret`;
    /// `x-client-id`/`x-client-secret`) and no optional Meta settings.
    pub fn with_all_apps() -> Self {
        FakeAppConfig {
            meta: Some(MetaApp {
                app_id: "meta-app-id".into(),
                app_secret: "meta-app-secret".into(),
                verify_token: "meta-verify-token".into(),
                login_config_id: None,
                whatsapp_config_id: None,
                graph_version: None,
            }),
            instagram: Some(InstagramApp {
                app_id: "instagram-app-id".into(),
                app_secret: "instagram-app-secret".into(),
            }),
            x: Some(XApp {
                client_id: "x-client-id".into(),
                client_secret: "x-client-secret".into(),
            }),
            ..FakeAppConfig::default()
        }
    }
}

impl PlatformAppConfig for FakeAppConfig {
    fn meta_app(&self) -> Option<MetaApp> {
        self.meta.clone()
    }

    fn instagram_app(&self) -> Option<InstagramApp> {
        self.instagram.clone()
    }

    fn x_app(&self) -> Option<XApp> {
        self.x.clone()
    }

    fn public_base_url(&self) -> Url {
        self.public_base_url.clone()
    }
}

// ---------------------------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------------------------

/// The answers queued for one method.
struct Script<T> {
    queue: Mutex<VecDeque<T>>,
}

impl<T> Default for Script<T> {
    fn default() -> Self {
        Script {
            queue: Mutex::new(VecDeque::new()),
        }
    }
}

impl<T> Script<T> {
    fn push(&self, answer: T) {
        lock(&self.queue).push_back(answer);
    }

    /// The next answer, if one is queued.
    fn try_next(&self) -> Option<T> {
        lock(&self.queue).pop_front()
    }

    /// The next answer; panics when none is queued.
    fn next(&self, adapter: &str, provider: Provider, what: &str) -> T {
        lock(&self.queue).pop_front().unwrap_or_else(|| {
            panic!(
                "{adapter}({}): no {what} scripted: the test queued fewer answers than were asked \
                 for",
                provider.key()
            )
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The scripted connector
// ---------------------------------------------------------------------------------------------

/// One call a [`ScriptedConnector`] received, with its arguments.
#[derive(Clone, Debug, PartialEq)]
pub enum ConnectorCall {
    Probe {
        credential: Credential,
        public: Value,
    },
    Refresh {
        credential: Credential,
    },
    OnConnected {
        credential: Credential,
        public: Value,
    },
    SendSms {
        credential: Credential,
        to: String,
        text: String,
        reference: Option<String>,
    },
    Publish {
        credential: Credential,
        public: Value,
        request: PublishRequest,
    },
    PostMetrics {
        credential: Credential,
        public: Value,
        post_id: String,
    },
    AccountMetrics {
        credential: Credential,
        public: Value,
    },
    SendText {
        credential: Credential,
        public: Value,
        recipient_id: String,
        text: String,
    },
    SetDailyBudget {
        credential: Credential,
        entity_id: String,
        minor: i64,
    },
    ListAdsets {
        credential: Credential,
        public: Value,
    },
    Insights {
        credential: Credential,
        public: Value,
        since: Date,
        until: Date,
    },
    FetchLeadGen {
        credential: Credential,
        leadgen_id: String,
    },
    ClickToCall {
        credential: Credential,
        from_ext: String,
        to: String,
    },
    Hangup {
        credential: Credential,
        call_id: String,
    },
    ConsentAdd {
        credential: Credential,
        rows: Vec<ConsentRow>,
    },
}

/// A provider adapter implementing [`Connector`] and every operation trait, answering from the
/// queues its `push_*` methods fill (one queue per method) and recording every call.
pub struct ScriptedConnector {
    provider: Provider,
    hosts: &'static [&'static str],
    calls: Mutex<Vec<ConnectorCall>>,
    probe: Script<ProbeResult>,
    refresh: Script<Result<Option<Credential>, ConnectorError>>,
    on_connected: Script<Result<Value, ConnectorError>>,
    sms: Script<Result<SendReceipt, ConnectorError>>,
    publish: Script<Result<PublishReceipt, ConnectorError>>,
    post_metrics: Script<Result<PostMetrics, ConnectorError>>,
    account_metrics: Script<Result<AccountMetrics, ConnectorError>>,
    send_text: Script<Result<SendReceipt, ConnectorError>>,
    set_daily_budget: Script<Result<(), ConnectorError>>,
    list_adsets: Script<Result<Vec<AdSet>, ConnectorError>>,
    insights: Script<Result<Vec<AdInsights>, ConnectorError>>,
    leadgen: Script<Result<LeadGenRecord, ConnectorError>>,
    click_to_call: Script<Result<SendReceipt, ConnectorError>>,
    hangup: Script<Result<(), ConnectorError>>,
    consent_add: Script<Result<SendReceipt, ConnectorError>>,
}

impl ScriptedConnector {
    /// An adapter for `provider` with nothing queued, reaching no host
    /// ([`with_hosts`](Self::with_hosts) names some).
    pub fn new(provider: Provider) -> Self {
        ScriptedConnector {
            provider,
            hosts: &[],
            calls: Mutex::new(Vec::new()),
            probe: Script::default(),
            refresh: Script::default(),
            on_connected: Script::default(),
            sms: Script::default(),
            publish: Script::default(),
            post_metrics: Script::default(),
            account_metrics: Script::default(),
            send_text: Script::default(),
            set_daily_budget: Script::default(),
            list_adsets: Script::default(),
            insights: Script::default(),
            leadgen: Script::default(),
            click_to_call: Script::default(),
            hangup: Script::default(),
            consent_add: Script::default(),
        }
    }

    /// The adapter answering `hosts` from [`Connector::hosts`].
    pub fn with_hosts(mut self, hosts: &'static [&'static str]) -> Self {
        self.hosts = hosts;
        self
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<ConnectorCall> {
        lock(&self.calls).clone()
    }

    pub fn push_probe(&self, result: ProbeResult) {
        self.probe.push(result);
    }

    pub fn push_refresh(&self, result: Result<Option<Credential>, ConnectorError>) {
        self.refresh.push(result);
    }

    /// Queues an answer of [`Connector::on_connected`]; with none queued it answers
    /// `Ok(Value::Null)`.
    pub fn push_on_connected(&self, result: Result<Value, ConnectorError>) {
        self.on_connected.push(result);
    }

    pub fn push_sms(&self, result: Result<SendReceipt, ConnectorError>) {
        self.sms.push(result);
    }

    pub fn push_publish(&self, result: Result<PublishReceipt, ConnectorError>) {
        self.publish.push(result);
    }

    pub fn push_post_metrics(&self, result: Result<PostMetrics, ConnectorError>) {
        self.post_metrics.push(result);
    }

    pub fn push_account_metrics(&self, result: Result<AccountMetrics, ConnectorError>) {
        self.account_metrics.push(result);
    }

    pub fn push_send_text(&self, result: Result<SendReceipt, ConnectorError>) {
        self.send_text.push(result);
    }

    pub fn push_set_daily_budget(&self, result: Result<(), ConnectorError>) {
        self.set_daily_budget.push(result);
    }

    pub fn push_list_adsets(&self, result: Result<Vec<AdSet>, ConnectorError>) {
        self.list_adsets.push(result);
    }

    pub fn push_insights(&self, result: Result<Vec<AdInsights>, ConnectorError>) {
        self.insights.push(result);
    }

    pub fn push_leadgen(&self, result: Result<LeadGenRecord, ConnectorError>) {
        self.leadgen.push(result);
    }

    pub fn push_click_to_call(&self, result: Result<SendReceipt, ConnectorError>) {
        self.click_to_call.push(result);
    }

    pub fn push_hangup(&self, result: Result<(), ConnectorError>) {
        self.hangup.push(result);
    }

    pub fn push_consent_add(&self, result: Result<SendReceipt, ConnectorError>) {
        self.consent_add.push(result);
    }

    fn record(&self, call: ConnectorCall) {
        lock(&self.calls).push(call);
    }

    fn next<T>(&self, script: &Script<T>, what: &str) -> T {
        script.next("ScriptedConnector", self.provider, what)
    }
}

#[async_trait]
impl Connector for ScriptedConnector {
    fn provider(&self) -> Provider {
        self.provider
    }

    fn hosts(&self) -> &'static [&'static str] {
        self.hosts
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        self.record(ConnectorCall::Probe {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.next(&self.probe, "probe result")
    }

    async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        self.record(ConnectorCall::Refresh {
            credential: cred.clone(),
        });
        self.next(&self.refresh, "refresh result")
    }

    async fn on_connected(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Value, ConnectorError> {
        self.record(ConnectorCall::OnConnected {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.on_connected.try_next().unwrap_or(Ok(Value::Null))
    }
}

#[async_trait]
impl SmsSender for ScriptedConnector {
    async fn send(
        &self,
        cred: &Credential,
        to: &str,
        text: &str,
        reference: Option<&str>,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::SendSms {
            credential: cred.clone(),
            to: to.to_owned(),
            text: text.to_owned(),
            reference: reference.map(str::to_owned),
        });
        self.next(&self.sms, "sms result")
    }
}

#[async_trait]
impl Publisher for ScriptedConnector {
    async fn publish(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
    ) -> Result<PublishReceipt, ConnectorError> {
        self.record(ConnectorCall::Publish {
            credential: cred.clone(),
            public: public.clone(),
            request: request.clone(),
        });
        self.next(&self.publish, "publish result")
    }
}

#[async_trait]
impl InsightsReader for ScriptedConnector {
    async fn post_metrics(
        &self,
        cred: &Credential,
        public: &Value,
        post_id: &str,
    ) -> Result<PostMetrics, ConnectorError> {
        self.record(ConnectorCall::PostMetrics {
            credential: cred.clone(),
            public: public.clone(),
            post_id: post_id.to_owned(),
        });
        self.next(&self.post_metrics, "post metrics result")
    }

    async fn account_metrics(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AccountMetrics, ConnectorError> {
        self.record(ConnectorCall::AccountMetrics {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.next(&self.account_metrics, "account metrics result")
    }
}

#[async_trait]
impl MessagingSender for ScriptedConnector {
    async fn send_text(
        &self,
        cred: &Credential,
        public: &Value,
        recipient_id: &str,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::SendText {
            credential: cred.clone(),
            public: public.clone(),
            recipient_id: recipient_id.to_owned(),
            text: text.to_owned(),
        });
        self.next(&self.send_text, "send_text result")
    }
}

#[async_trait]
impl AdBudgetWriter for ScriptedConnector {
    async fn set_daily_budget(
        &self,
        cred: &Credential,
        entity_id: &str,
        minor: i64,
    ) -> Result<(), ConnectorError> {
        self.record(ConnectorCall::SetDailyBudget {
            credential: cred.clone(),
            entity_id: entity_id.to_owned(),
            minor,
        });
        self.next(&self.set_daily_budget, "set_daily_budget result")
    }

    async fn list_adsets(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<Vec<AdSet>, ConnectorError> {
        self.record(ConnectorCall::ListAdsets {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.next(&self.list_adsets, "list_adsets result")
    }

    async fn insights(
        &self,
        cred: &Credential,
        public: &Value,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdInsights>, ConnectorError> {
        self.record(ConnectorCall::Insights {
            credential: cred.clone(),
            public: public.clone(),
            since,
            until,
        });
        self.next(&self.insights, "insights result")
    }
}

#[async_trait]
impl LeadGenFetcher for ScriptedConnector {
    async fn fetch(
        &self,
        cred: &Credential,
        leadgen_id: &str,
    ) -> Result<LeadGenRecord, ConnectorError> {
        self.record(ConnectorCall::FetchLeadGen {
            credential: cred.clone(),
            leadgen_id: leadgen_id.to_owned(),
        });
        self.next(&self.leadgen, "lead-gen result")
    }
}

#[async_trait]
impl Telephony for ScriptedConnector {
    async fn click_to_call(
        &self,
        cred: &Credential,
        from_ext: &str,
        to: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::ClickToCall {
            credential: cred.clone(),
            from_ext: from_ext.to_owned(),
            to: to.to_owned(),
        });
        self.next(&self.click_to_call, "click_to_call result")
    }

    async fn hangup(&self, cred: &Credential, call_id: &str) -> Result<(), ConnectorError> {
        self.record(ConnectorCall::Hangup {
            credential: cred.clone(),
            call_id: call_id.to_owned(),
        });
        self.next(&self.hangup, "hangup result")
    }
}

#[async_trait]
impl ConsentSync for ScriptedConnector {
    async fn add(
        &self,
        cred: &Credential,
        rows: &[ConsentRow],
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::ConsentAdd {
            credential: cred.clone(),
            rows: rows.to_vec(),
        });
        self.next(&self.consent_add, "consent result")
    }
}

// ---------------------------------------------------------------------------------------------
// The scripted OAuth provider
// ---------------------------------------------------------------------------------------------

/// The host of every URL [`ScriptedOAuth::authorize_url`] builds.
pub const TEST_OAUTH_HOST: &str = "oauth.test";

/// One call a [`ScriptedOAuth`] received. Only the app's client id is recorded, never its secret.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OAuthCall {
    AuthorizeUrl {
        client_id: String,
        redirect: Url,
        state: String,
        pkce_challenge: Option<String>,
    },
    Exchange {
        client_id: String,
        redirect: Url,
        code: String,
        pkce_verifier: Option<String>,
    },
    ListAssets {
        credential: Credential,
    },
}

/// An OAuth provider whose authorize URL is built deterministically
/// (`https://oauth.test/<provider>/authorize?response_type=code&client_id=..&redirect_uri=..&state=..`,
/// plus `code_challenge` and `code_challenge_method=S256` when a challenge is given) and whose
/// exchanges and asset lists answer from the queues `push_exchange` and `push_assets` fill.
pub struct ScriptedOAuth {
    provider: Provider,
    calls: Mutex<Vec<OAuthCall>>,
    exchange: Script<Result<Credential, ConnectorError>>,
    assets: Script<Result<Vec<Asset>, ConnectorError>>,
}

impl ScriptedOAuth {
    /// A provider's OAuth flow with nothing queued.
    pub fn new(provider: Provider) -> Self {
        ScriptedOAuth {
            provider,
            calls: Mutex::new(Vec::new()),
            exchange: Script::default(),
            assets: Script::default(),
        }
    }

    /// The provider whose flow this is.
    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<OAuthCall> {
        lock(&self.calls).clone()
    }

    pub fn push_exchange(&self, result: Result<Credential, ConnectorError>) {
        self.exchange.push(result);
    }

    pub fn push_assets(&self, result: Result<Vec<Asset>, ConnectorError>) {
        self.assets.push(result);
    }

    fn record(&self, call: OAuthCall) {
        lock(&self.calls).push(call);
    }
}

#[async_trait]
impl OAuthProvider for ScriptedOAuth {
    fn authorize_url(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
    ) -> Url {
        self.record(OAuthCall::AuthorizeUrl {
            client_id: app.client_id().to_owned(),
            redirect: redirect.clone(),
            state: state.to_owned(),
            pkce_challenge: pkce_challenge.map(str::to_owned),
        });
        let mut url = Url::parse(&format!(
            "https://{TEST_OAUTH_HOST}/{}/authorize",
            self.provider.key()
        ))
        .expect("a valid test URL");
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", app.client_id())
                .append_pair("redirect_uri", redirect.as_str())
                .append_pair("state", state);
            if let Some(challenge) = pkce_challenge {
                query
                    .append_pair("code_challenge", challenge)
                    .append_pair("code_challenge_method", "S256");
            }
        }
        url
    }

    async fn exchange(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
    ) -> Result<Credential, ConnectorError> {
        self.record(OAuthCall::Exchange {
            client_id: app.client_id().to_owned(),
            redirect: redirect.clone(),
            code: code.to_owned(),
            pkce_verifier: pkce_verifier.map(str::to_owned),
        });
        self.exchange
            .next("ScriptedOAuth", self.provider, "exchange result")
    }

    async fn list_assets(&self, cred: &Credential) -> Result<Vec<Asset>, ConnectorError> {
        self.record(OAuthCall::ListAssets {
            credential: cred.clone(),
        });
        self.assets
            .next("ScriptedOAuth", self.provider, "assets result")
    }
}

// ---------------------------------------------------------------------------------------------
// The scripted registry
// ---------------------------------------------------------------------------------------------

// The operation matrix below restates which operations the real adapters offer (M1b Tasks 5 to
// 7); the real registry (Task 11) should be tested against the same matrix, so this fake never
// offers more than production does.

/// The providers whose adapters publish posts and read their counters (Meta, X).
const PUBLISHING: &[Provider] = &[Provider::Meta, Provider::X];
/// The providers whose adapters send direct messages, write ad budgets and fetch lead-gen
/// submissions (Meta).
const META_ONLY: &[Provider] = &[Provider::Meta];
/// The providers whose adapters send SMS, place calls and record consent (NetGSM).
const NETGSM_ONLY: &[Provider] = &[Provider::Netgsm];

/// A registry over scripted adapters. It starts empty (every getter `None`, like
/// `jt_app::std_impls::EmptyConnectorRegistry`); [`with_connector`](Self::with_connector) and
/// [`with_oauth`](Self::with_oauth) register adapters by their provider. A registered
/// [`ScriptedConnector`] is handed out for its provider's operations where the real adapter offers
/// them: SMS, calls and consent for NetGSM; publishing and counters for Meta and X; messaging, ad
/// budgets and lead-gen for Meta. Clones share the adapters.
#[derive(Clone, Default)]
pub struct ScriptedRegistry {
    connectors: BTreeMap<Provider, Arc<ScriptedConnector>>,
    oauth: BTreeMap<Provider, Arc<ScriptedOAuth>>,
}

impl ScriptedRegistry {
    /// A registry with no adapter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `connector` for its provider, replacing any registered before.
    pub fn with_connector(mut self, connector: Arc<ScriptedConnector>) -> Self {
        self.connectors.insert(connector.provider, connector);
        self
    }

    /// Registers `oauth` for its provider, replacing any registered before.
    pub fn with_oauth(mut self, oauth: Arc<ScriptedOAuth>) -> Self {
        self.oauth.insert(oauth.provider, oauth);
        self
    }

    /// The registered connector of `provider` when `offered` lists it.
    fn offered(&self, provider: Provider, offered: &[Provider]) -> Option<Arc<ScriptedConnector>> {
        offered
            .contains(&provider)
            .then(|| self.connectors.get(&provider).cloned())
            .flatten()
    }
}

impl ConnectorRegistry for ScriptedRegistry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        self.connectors
            .get(&provider)
            .cloned()
            .map(|c| c as Arc<dyn Connector>)
    }

    fn oauth(&self, provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        self.oauth
            .get(&provider)
            .cloned()
            .map(|o| o as Arc<dyn OAuthProvider>)
    }

    fn sms(&self, provider: Provider) -> Option<Arc<dyn SmsSender>> {
        self.offered(provider, NETGSM_ONLY)
            .map(|c| c as Arc<dyn SmsSender>)
    }

    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>> {
        self.offered(provider, PUBLISHING)
            .map(|c| c as Arc<dyn Publisher>)
    }

    fn insights(&self, provider: Provider) -> Option<Arc<dyn InsightsReader>> {
        self.offered(provider, PUBLISHING)
            .map(|c| c as Arc<dyn InsightsReader>)
    }

    fn messaging(&self, provider: Provider) -> Option<Arc<dyn MessagingSender>> {
        self.offered(provider, META_ONLY)
            .map(|c| c as Arc<dyn MessagingSender>)
    }

    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        self.offered(provider, META_ONLY)
            .map(|c| c as Arc<dyn AdBudgetWriter>)
    }

    fn leadgen(&self, provider: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        self.offered(provider, META_ONLY)
            .map(|c| c as Arc<dyn LeadGenFetcher>)
    }

    fn telephony(&self, provider: Provider) -> Option<Arc<dyn Telephony>> {
        self.offered(provider, NETGSM_ONLY)
            .map(|c| c as Arc<dyn Telephony>)
    }

    fn consent(&self, provider: Provider) -> Option<Arc<dyn ConsentSync>> {
        self.offered(provider, NETGSM_ONLY)
            .map(|c| c as Arc<dyn ConsentSync>)
    }
}
