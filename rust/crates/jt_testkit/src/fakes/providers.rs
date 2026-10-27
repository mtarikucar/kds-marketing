//! Fakes for the connector ports: a configurable [`FakeAppConfig`], and scripted provider
//! adapters ([`ScriptedConnector`], [`ScriptedOAuth`]) handed out by a [`ScriptedRegistry`].
//!
//! A scripted adapter answers each method with the results a test queued for that method, in
//! order, and records every call (with its arguments) for assertions; a [`ScriptedConnector`]
//! names the hosts it was given ([`ScriptedConnector::with_hosts`], none by default). A call with nothing queued
//! panics, naming the provider and the method: the test scripted too few answers. The one
//! exception is [`Connector::on_connected`], which every connection runs: with nothing queued it
//! answers `Ok(Value::Null)`, as the trait's default does. Nothing reaches a network.
//!
//! A [`ScriptedConnector`] also counts the probes it is answering at once
//! ([`ScriptedConnector::max_probes_in_flight`]); [`ScriptedConnector::with_probe_yields`] makes
//! each probe yield to the scheduler a few times before it answers, so that probes run
//! concurrently overlap and a bound on their concurrency can be observed.

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AccountMetrics, AdAccountContext, AdBudgetWriter, AdInsights, AdSet, AdSetInsights, AdStatus,
    Asset, Connector, ConnectorRegistry, ConsentRow, ConsentSync, DeliveryReports, DeliveryStatus,
    InboundEventDraft, InsightsReader, InstagramApp, LeadGenFetcher, LeadGenRecord, LinkedinApp,
    MailMessage, MailSender, MailboxCursor, MailboxPoller, MessagingSender, MetaApp, OAuthApp,
    OAuthProvider, PlatformAppConfig, PostMetrics, PublishReceipt, PublishRequest,
    PublishResolution, Publisher, SendReceipt, SmsSender, Telephony, TiktokApp, Url, XApp,
};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use time::{Date, OffsetDateTime};

use super::state::lock;

// ---------------------------------------------------------------------------------------------
// Platform apps
// ---------------------------------------------------------------------------------------------

/// The address [`FakeAppConfig::default`] answers.
pub const TEST_PUBLIC_BASE_URL: &str = "https://panel.test";

/// A platform app configuration a test sets field by field. The default has no app at all and
/// the public address [`TEST_PUBLIC_BASE_URL`]; [`FakeAppConfig::with_all_apps`] has them all.
/// `public_base_url: None` stands for a server whose public address is not configured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeAppConfig {
    pub meta: Option<MetaApp>,
    pub instagram: Option<InstagramApp>,
    pub x: Option<XApp>,
    pub tiktok: Option<TiktokApp>,
    pub linkedin: Option<LinkedinApp>,
    pub public_base_url: Option<Url>,
}

impl Default for FakeAppConfig {
    fn default() -> Self {
        FakeAppConfig {
            meta: None,
            instagram: None,
            x: None,
            tiktok: None,
            linkedin: None,
            public_base_url: Some(Url::parse(TEST_PUBLIC_BASE_URL).expect("a valid test URL")),
        }
    }
}

impl FakeAppConfig {
    /// Every app configured, with test values (`meta-app-id`/`meta-app-secret`, verify token
    /// `meta-verify-token`; `instagram-app-id`/`instagram-app-secret`;
    /// `x-client-id`/`x-client-secret`; `tiktok-client-key`/`tiktok-client-secret`;
    /// `linkedin-client-id`/`linkedin-client-secret`, without the organization scopes) and no
    /// optional Meta or LinkedIn settings.
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
            tiktok: Some(TiktokApp {
                client_key: "tiktok-client-key".into(),
                client_secret: "tiktok-client-secret".into(),
            }),
            linkedin: Some(LinkedinApp {
                client_id: "linkedin-client-id".into(),
                client_secret: "linkedin-client-secret".into(),
                organization_scopes: false,
                api_version: None,
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

    fn tiktok_app(&self) -> Option<TiktokApp> {
        self.tiktok.clone()
    }

    fn linkedin_app(&self) -> Option<LinkedinApp> {
        self.linkedin.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
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
    SetAdStatus {
        credential: Credential,
        entity_id: String,
        status: AdStatus,
    },
    AdAccountContext {
        credential: Credential,
        public: Value,
    },
    AdSetInsights {
        credential: Credential,
        public: Value,
        since: Date,
        until: Date,
    },
    ResolveAdset {
        credential: Credential,
        public: Value,
        ad_id: String,
    },
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
        commercial: bool,
    },
    SendMail {
        workspace_id: WorkspaceId,
        credential: Credential,
        message: MailMessage,
    },
    MailboxPoll {
        workspace_id: WorkspaceId,
        credential: Credential,
        public: Value,
        cursor: MailboxCursor,
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
        public: Value,
        from_ext: String,
        to: String,
    },
    Hangup {
        credential: Credential,
        call_id: String,
    },
    CallRecords {
        credential: Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    },
    ConsentAdd {
        credential: Credential,
        rows: Vec<ConsentRow>,
    },
    Report {
        credential: Credential,
        job_ids: Vec<String>,
    },
    Inbox {
        credential: Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    },
}

/// A provider adapter implementing [`Connector`] and every operation trait, answering from the
/// queues its `push_*` methods fill (one queue per method) and recording every call.
type SendHook =
    Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;

pub struct ScriptedConnector {
    provider: Provider,
    hosts: &'static [&'static str],
    calls: Mutex<Vec<ConnectorCall>>,
    /// How many times a probe yields to the scheduler before it answers.
    probe_yields: usize,
    /// The probes being answered now, and the most there ever were at once.
    probes_in_flight: AtomicUsize,
    max_probes_in_flight: AtomicUsize,
    probe: Script<ProbeResult>,
    refresh: Script<Result<Option<Credential>, ConnectorError>>,
    on_connected: Script<Result<Value, ConnectorError>>,
    sms: Script<Result<SendReceipt, ConnectorError>>,
    mail: Script<Result<SendReceipt, ConnectorError>>,
    mailbox_poll: Script<Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError>>,
    send_hooks: Script<SendHook>,
    ad_read_hooks: Script<SendHook>,
    publish: Script<Result<PublishReceipt, ConnectorError>>,
    /// Publication statuses answer from here, `Ok(None)` (the trait's default: the receipt is the
    /// post) when nothing is queued; the receipts asked about are kept apart from
    /// [`ScriptedConnector::calls`] (see [`ScriptedConnector::resolve_calls`]).
    resolve: Script<Result<Option<PublishResolution>, ConnectorError>>,
    resolve_calls: Mutex<Vec<PublishReceipt>>,
    post_metrics: Script<Result<PostMetrics, ConnectorError>>,
    account_metrics: Script<Result<AccountMetrics, ConnectorError>>,
    send_text: Script<Result<SendReceipt, ConnectorError>>,
    /// Sender-name lookups answer from here, `Ok(None)` when nothing is queued; they are kept
    /// apart from [`ScriptedConnector::calls`] (see [`ScriptedConnector::sender_name_calls`]).
    sender_name: Script<Result<Option<String>, ConnectorError>>,
    sender_name_calls: Mutex<Vec<String>>,
    set_status: Script<Result<(), ConnectorError>>,
    account_context: Script<Result<AdAccountContext, ConnectorError>>,
    adset_insights: Script<Result<Vec<AdSetInsights>, ConnectorError>>,
    resolve_adset: Script<Result<Option<String>, ConnectorError>>,
    set_daily_budget: Script<Result<(), ConnectorError>>,
    list_adsets: Script<Result<Vec<AdSet>, ConnectorError>>,
    insights: Script<Result<Vec<AdInsights>, ConnectorError>>,
    leadgen: Script<Result<LeadGenRecord, ConnectorError>>,
    click_to_call: Script<Result<SendReceipt, ConnectorError>>,
    hangup: Script<Result<(), ConnectorError>>,
    call_records: Script<Result<Vec<InboundEventDraft>, ConnectorError>>,
    consent_add: Script<Result<SendReceipt, ConnectorError>>,
    report: Script<Result<Vec<DeliveryStatus>, ConnectorError>>,
    inbox: Script<Result<Vec<InboundEventDraft>, ConnectorError>>,
}

impl ScriptedConnector {
    pub fn push_resolve_adset(&self, result: Result<Option<String>, ConnectorError>) {
        self.resolve_adset.push(result);
    }
    pub fn push_adset_insights(&self, result: Result<Vec<AdSetInsights>, ConnectorError>) {
        self.adset_insights.push(result);
    }
    pub fn push_account_context(&self, result: Result<AdAccountContext, ConnectorError>) {
        self.account_context.push(result);
    }
    pub fn push_set_status(&self, result: Result<(), ConnectorError>) {
        self.set_status.push(result);
    }
    /// An adapter for `provider` with nothing queued, reaching no host
    /// ([`with_hosts`](Self::with_hosts) names some).
    pub fn new(provider: Provider) -> Self {
        ScriptedConnector {
            provider,
            hosts: &[],
            calls: Mutex::new(Vec::new()),
            probe_yields: 0,
            probes_in_flight: AtomicUsize::new(0),
            max_probes_in_flight: AtomicUsize::new(0),
            probe: Script::default(),
            refresh: Script::default(),
            on_connected: Script::default(),
            sms: Script::default(),
            mail: Script::default(),
            mailbox_poll: Script::default(),
            send_hooks: Script::default(),
            ad_read_hooks: Script::default(),
            publish: Script::default(),
            resolve: Script::default(),
            resolve_calls: Mutex::default(),
            post_metrics: Script::default(),
            account_metrics: Script::default(),
            send_text: Script::default(),
            sender_name: Script::default(),
            sender_name_calls: Mutex::default(),
            set_status: Script::default(),
            account_context: Script::default(),
            adset_insights: Script::default(),
            resolve_adset: Script::default(),
            set_daily_budget: Script::default(),
            list_adsets: Script::default(),
            insights: Script::default(),
            leadgen: Script::default(),
            click_to_call: Script::default(),
            hangup: Script::default(),
            call_records: Script::default(),
            consent_add: Script::default(),
            report: Script::default(),
            inbox: Script::default(),
        }
    }

    /// The adapter answering `hosts` from [`Connector::hosts`].
    pub fn with_hosts(mut self, hosts: &'static [&'static str]) -> Self {
        self.hosts = hosts;
        self
    }

    /// The adapter yielding `yields` times to the scheduler inside every probe, before it
    /// answers, so that concurrent probes overlap.
    pub fn with_probe_yields(mut self, yields: usize) -> Self {
        self.probe_yields = yields;
        self
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<ConnectorCall> {
        lock(&self.calls).clone()
    }

    /// The most probes this adapter was answering at the same time.
    pub fn max_probes_in_flight(&self) -> usize {
        self.max_probes_in_flight.load(Ordering::SeqCst)
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

    /// Queue the exact outcome, including uncertain writes and an optional reported cost.
    pub fn push_sms(&self, result: Result<SendReceipt, ConnectorError>) {
        self.sms.push(result);
    }

    pub fn push_mail(&self, result: Result<SendReceipt, ConnectorError>) {
        self.mail.push(result);
    }

    pub fn push_mailbox_poll(
        &self,
        result: Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError>,
    ) {
        self.mailbox_poll.push(result);
    }

    pub fn push_publish(&self, result: Result<PublishReceipt, ConnectorError>) {
        self.publish.push(result);
    }

    /// Queues what the next [`Publisher::resolve`] answers.
    pub fn push_resolve(&self, result: Result<Option<PublishResolution>, ConnectorError>) {
        self.resolve.push(result);
    }

    /// The receipts [`Publisher::resolve`] was asked about, in order.
    pub fn resolve_calls(&self) -> Vec<PublishReceipt> {
        lock(&self.resolve_calls).clone()
    }

    pub fn push_post_metrics(&self, result: Result<PostMetrics, ConnectorError>) {
        self.post_metrics.push(result);
    }

    pub fn push_account_metrics(&self, result: Result<AccountMetrics, ConnectorError>) {
        self.account_metrics.push(result);
    }

    /// Run after recording a provider write, before its result. Supports races and crashes.
    pub fn push_ad_read_hook<F, Fut>(&self, hook: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.ad_read_hooks.push(Box::new(move || Box::pin(hook())));
    }
    pub fn push_send_hook<F, Fut>(&self, hook: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.send_hooks.push(Box::new(move || Box::pin(hook())));
    }
    async fn after_send(&self) {
        if let Some(hook) = self.send_hooks.try_next() {
            hook().await;
        }
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

    pub fn push_sender_name(&self, result: Result<Option<String>, ConnectorError>) {
        self.sender_name.push(result);
    }

    /// The sender ids whose names were asked for, in order.
    pub fn sender_name_calls(&self) -> Vec<String> {
        lock(&self.sender_name_calls).clone()
    }

    pub fn push_click_to_call(&self, result: Result<SendReceipt, ConnectorError>) {
        self.click_to_call.push(result);
    }

    pub fn push_call_records(&self, result: Result<Vec<InboundEventDraft>, ConnectorError>) {
        self.call_records.push(result);
    }

    pub fn push_hangup(&self, result: Result<(), ConnectorError>) {
        self.hangup.push(result);
    }

    pub fn push_consent_add(&self, result: Result<SendReceipt, ConnectorError>) {
        self.consent_add.push(result);
    }

    pub fn push_report(&self, result: Result<Vec<DeliveryStatus>, ConnectorError>) {
        self.report.push(result);
    }

    pub fn push_inbox(&self, result: Result<Vec<InboundEventDraft>, ConnectorError>) {
        self.inbox.push(result);
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
        let now = self.probes_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_probes_in_flight.fetch_max(now, Ordering::SeqCst);
        for _ in 0..self.probe_yields {
            tokio::task::yield_now().await;
        }
        self.probes_in_flight.fetch_sub(1, Ordering::SeqCst);
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
        commercial: bool,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::SendSms {
            credential: cred.clone(),
            to: to.to_owned(),
            text: text.to_owned(),
            reference: reference.map(str::to_owned),
            commercial,
        });
        self.after_send().await;
        self.next(&self.sms, "sms result")
    }
}

#[async_trait]
impl MailSender for ScriptedConnector {
    async fn send(
        &self,
        ws: WorkspaceId,
        cred: &Credential,
        message: MailMessage,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::SendMail {
            workspace_id: ws,
            credential: cred.clone(),
            message,
        });
        self.after_send().await;
        self.next(&self.mail, "mail result")
    }
}

#[async_trait]
impl MailboxPoller for ScriptedConnector {
    async fn poll(
        &self,
        ws: WorkspaceId,
        cred: &Credential,
        public: &Value,
        cursor: &MailboxCursor,
    ) -> Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError> {
        self.record(ConnectorCall::MailboxPoll {
            workspace_id: ws,
            credential: cred.clone(),
            public: public.clone(),
            cursor: cursor.clone(),
        });
        self.next(&self.mailbox_poll, "mailbox poll result")
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
        self.after_send().await;
        self.next(&self.publish, "publish result")
    }

    async fn resolve(
        &self,
        _cred: &Credential,
        _public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<Option<PublishResolution>, ConnectorError> {
        lock(&self.resolve_calls).push(receipt.clone());
        self.resolve.try_next().unwrap_or(Ok(None))
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
        self.after_send().await;
        self.next(&self.send_text, "send_text result")
    }

    async fn sender_name(
        &self,
        _cred: &Credential,
        _public: &Value,
        sender_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        lock(&self.sender_name_calls).push(sender_id.to_owned());
        self.sender_name.try_next().unwrap_or(Ok(None))
    }
}

#[async_trait]
impl AdBudgetWriter for ScriptedConnector {
    async fn set_status(
        &self,
        cred: &Credential,
        entity_id: &str,
        status: AdStatus,
    ) -> Result<(), ConnectorError> {
        self.record(ConnectorCall::SetAdStatus {
            credential: cred.clone(),
            entity_id: entity_id.into(),
            status,
        });
        self.set_status
            .try_next()
            .unwrap_or_else(|| Err(ConnectorError::permanent("ad status is unsupported")))
    }
    async fn account_context(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AdAccountContext, ConnectorError> {
        self.record(ConnectorCall::AdAccountContext {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.account_context.try_next().unwrap_or_else(|| {
            Err(ConnectorError::permanent(
                "ad account context is unsupported",
            ))
        })
    }
    async fn adset_insights(
        &self,
        cred: &Credential,
        public: &Value,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdSetInsights>, ConnectorError> {
        self.record(ConnectorCall::AdSetInsights {
            credential: cred.clone(),
            public: public.clone(),
            since,
            until,
        });
        self.adset_insights
            .try_next()
            .unwrap_or_else(|| Err(ConnectorError::permanent("ad set insights are unsupported")))
    }
    async fn resolve_adset(
        &self,
        cred: &Credential,
        public: &Value,
        ad_id: &str,
    ) -> Result<Option<String>, ConnectorError> {
        self.record(ConnectorCall::ResolveAdset {
            credential: cred.clone(),
            public: public.clone(),
            ad_id: ad_id.into(),
        });
        self.resolve_adset.try_next().unwrap_or_else(|| {
            Err(ConnectorError::permanent(
                "ad set resolution is unsupported",
            ))
        })
    }

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
        if let Some(hook) = self.ad_read_hooks.try_next() {
            hook().await;
        }
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
        public: &Value,
        from_ext: &str,
        to: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::ClickToCall {
            credential: cred.clone(),
            public: public.clone(),
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

    async fn call_records(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        self.record(ConnectorCall::CallRecords {
            credential: cred.clone(),
            from,
            to,
        });
        self.next(&self.call_records, "call_records result")
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

#[async_trait]
impl DeliveryReports for ScriptedConnector {
    async fn report(
        &self,
        cred: &Credential,
        job_ids: &[String],
    ) -> Result<Vec<DeliveryStatus>, ConnectorError> {
        self.record(ConnectorCall::Report {
            credential: cred.clone(),
            job_ids: job_ids.to_vec(),
        });
        self.next(&self.report, "report result")
    }

    async fn inbox(
        &self,
        cred: &Credential,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        self.record(ConnectorCall::Inbox {
            credential: cred.clone(),
            from,
            to,
        });
        self.next(&self.inbox, "inbox result")
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
/// plus `code_challenge` and `code_challenge_method=S256` when a challenge is given, unless
/// `refuse_authorize` queued a refusal) and whose exchanges and asset lists answer from the
/// queues `push_exchange` and `push_assets` fill.
pub struct ScriptedOAuth {
    provider: Provider,
    calls: Mutex<Vec<OAuthCall>>,
    /// Refusals of the next authorize URLs, in order; none queued builds the URL.
    authorize: Script<ConnectorError>,
    exchange: Script<Result<Credential, ConnectorError>>,
    assets: Script<Result<Vec<Asset>, ConnectorError>>,
}

impl ScriptedOAuth {
    /// A provider's OAuth flow with nothing queued.
    pub fn new(provider: Provider) -> Self {
        ScriptedOAuth {
            provider,
            calls: Mutex::new(Vec::new()),
            authorize: Script::default(),
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

    /// Makes the next authorize URL a refusal with `error` (each queued refusal answers once).
    pub fn refuse_authorize(&self, error: ConnectorError) {
        self.authorize.push(error);
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
    ) -> Result<Url, ConnectorError> {
        self.record(OAuthCall::AuthorizeUrl {
            client_id: app.client_id().to_owned(),
            redirect: redirect.clone(),
            state: state.to_owned(),
            pkce_challenge: pkce_challenge.map(str::to_owned),
        });
        if let Some(refusal) = self.authorize.try_next() {
            return Err(refusal);
        }
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
            // A LinkedIn flow that asks for the organization scopes says so, so the use cases'
            // tests can tell the two flavours apart.
            if matches!(app, OAuthApp::Linkedin(linkedin) if linkedin.organization_scopes) {
                query.append_pair("organization_scopes", "true");
            }
        }
        Ok(url)
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
// 7); the binary's real registry (`bin/jeeta/src/connectors.rs`) is tested against this fake, so
// this fake never offers more than production does.

/// The providers whose adapters publish posts and read their counters (Meta, X, TikTok,
/// LinkedIn).
const PUBLISHING: &[Provider] = &[
    Provider::Meta,
    Provider::X,
    Provider::Tiktok,
    Provider::Linkedin,
];
/// The providers whose adapters send direct messages, write ad budgets and fetch lead-gen
/// submissions (Meta).
const META_ONLY: &[Provider] = &[Provider::Meta];
/// The providers whose adapters send SMS, place calls, record consent and answer delivery-report
/// and inbox polls (NetGSM).
const NETGSM_ONLY: &[Provider] = &[Provider::Netgsm];

/// A registry over scripted adapters. It starts empty (every getter `None`, like
/// `jt_app::std_impls::EmptyConnectorRegistry`); [`with_connector`](Self::with_connector) and
/// [`with_oauth`](Self::with_oauth) register adapters by their provider. A registered
/// [`ScriptedConnector`] is handed out for its provider's operations where the real adapter offers
/// them: SMS, calls, consent and delivery reports for NetGSM; publishing and counters for Meta,
/// X, TikTok and LinkedIn; messaging, ad budgets and lead-gen for Meta. Clones share the adapters.
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

    fn mail_sender(&self, provider: Provider) -> Option<Arc<dyn MailSender>> {
        self.offered(provider, &[Provider::Mail])
            .map(|c| c as Arc<dyn MailSender>)
    }

    fn mailbox_poller(&self, provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        self.offered(provider, &[Provider::Mail])
            .map(|c| c as Arc<dyn MailboxPoller>)
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

    fn delivery_reports(&self, provider: Provider) -> Option<Arc<dyn DeliveryReports>> {
        self.offered(provider, NETGSM_ONLY)
            .map(|c| c as Arc<dyn DeliveryReports>)
    }
}
