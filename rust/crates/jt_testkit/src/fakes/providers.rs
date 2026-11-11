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
    AdAccountLimits, AdCampaignWriter, AdDay, AdLevel, AdPlacement, AdSetSpec, AdSpec,
    CampaignProviderState, CampaignSpec, CreativeSpec, LeadFormSpec,
};

use jt_app::ports::connectors::{
    AccountMetrics, AdAccountContext, AdBudgetWriter, AdInsights, AdSet, AdSetInsights, AdStatus,
    AppSync, Asset, Connector, ConnectorRegistry, ConsentRow, ConsentSync, DeliveryReports,
    DeliveryStatus, InboundEventDraft, InsightsReader, InstagramApp, IysAnswer, LeadGenFetcher,
    LeadGenRecord, LinkedinApp, MailMessage, MailSender, MailboxCursor, MailboxPoller,
    MessagingSender, MetaApp, ModerationAction, OAuthApp, OAuthFlow, OAuthProvider,
    PlatformAppConfig, PlatformScheduled, PolledMail, PostMetrics, PrivateReceipt, PublicPoller,
    PublicSurface, PublicTarget, PublishReceipt, PublishRequest, PublishResolution, Publisher,
    RecentPost, Scheduled, SendReceipt, SmsConsentFilter, SmsSender, SubjectFacts, Telephony,
    TiktokApp, TiktokCreator, Url, XApp,
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
    /// The Hepsiburada integrator user; `None` by default (the merchant id stands in for it).
    pub hepsiburada_integrator_user: Option<String>,
    pub public_base_url: Option<Url>,
    /// The platform switch `JEETA_OUTREACH_ENABLED`; off by default, as on a real platform.
    pub outreach_enabled: bool,
}

impl Default for FakeAppConfig {
    fn default() -> Self {
        FakeAppConfig {
            meta: None,
            instagram: None,
            x: None,
            tiktok: None,
            linkedin: None,
            hepsiburada_integrator_user: None,
            public_base_url: Some(Url::parse(TEST_PUBLIC_BASE_URL).expect("a valid test URL")),
            outreach_enabled: false,
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
                comment_scopes: false,
            }),
            instagram: Some(InstagramApp {
                app_id: "instagram-app-id".into(),
                app_secret: "instagram-app-secret".into(),
                comment_scopes: false,
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

    fn hepsiburada_integrator_user(&self) -> Option<String> {
        self.hepsiburada_integrator_user.clone()
    }

    fn public_base_url(&self) -> Option<Url> {
        self.public_base_url.clone()
    }

    fn outreach_enabled(&self) -> bool {
        self.outreach_enabled
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
    AccountLimits {
        credential: Credential,
        public: Value,
    },
    FindByName {
        credential: Credential,
        public: Value,
        level: AdLevel,
        name: String,
    },
    CreateCampaign {
        credential: Credential,
        public: Value,
        spec: CampaignSpec,
    },
    CreateAdset {
        credential: Credential,
        public: Value,
        spec: AdSetSpec,
    },
    UploadImage {
        credential: Credential,
        public: Value,
        bytes: Vec<u8>,
        name: String,
    },
    CreateLeadForm {
        credential: Credential,
        public: Value,
        spec: LeadFormSpec,
    },
    CreateCreative {
        credential: Credential,
        public: Value,
        spec: CreativeSpec,
    },
    CreateAd {
        credential: Credential,
        public: Value,
        spec: AdSpec,
    },
    CampaignState {
        credential: Credential,
        public: Value,
        campaign_id: String,
    },
    AdDays {
        credential: Credential,
        public: Value,
        campaign_id: String,
        objective: jt_app::ports::connectors::AdObjective,
        since: Date,
        until: Date,
    },
    Preview {
        credential: Credential,
        public: Value,
        creative: CreativeSpec,
        placement: AdPlacement,
    },

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
        filter: SmsConsentFilter,
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
    /// A post left with the provider's own scheduler to go out at `at`.
    Schedule {
        credential: Credential,
        public: Value,
        request: PublishRequest,
        at: OffsetDateTime,
    },
    /// A scheduled post asked back from the provider.
    Withdraw {
        credential: Credential,
        public: Value,
        receipt: PublishReceipt,
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
    ConsentSearch {
        credential: Credential,
        recipient: String,
        channel: String,
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
    account_limits: Script<Result<AdAccountLimits, ConnectorError>>,
    find_by_name: Script<Result<Option<String>, ConnectorError>>,
    create_campaign: Script<Result<String, ConnectorError>>,
    create_adset: Script<Result<String, ConnectorError>>,
    upload_image: Script<Result<String, ConnectorError>>,
    create_lead_form: Script<Result<String, ConnectorError>>,
    create_creative: Script<Result<String, ConnectorError>>,
    create_ad: Script<Result<String, ConnectorError>>,
    campaign_state: Script<Result<CampaignProviderState, ConnectorError>>,
    ad_days: Script<Result<Vec<AdDay>, ConnectorError>>,
    preview: Script<Result<String, ConnectorError>>,

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
    mailbox_poll: Script<Result<(Vec<PolledMail>, MailboxCursor), ConnectorError>>,
    send_hooks: Script<SendHook>,
    ad_read_hooks: Script<SendHook>,
    publish: Script<Result<PublishReceipt, ConnectorError>>,
    /// Publication statuses answer from here, `Ok(None)` (the trait's default: the receipt is the
    /// post) when nothing is queued; the receipts asked about are kept apart from
    /// [`ScriptedConnector::calls`] (see [`ScriptedConnector::resolve_calls`]).
    resolve: Script<Result<Option<PublishResolution>, ConnectorError>>,
    resolve_calls: Mutex<Vec<PublishReceipt>>,
    /// The window this provider's own scheduler takes a post in
    /// ([`ScriptedConnector::with_scheduler`]); `None`, as the trait's default: it has none. It
    /// takes a post that is not a story and carries at most one medium, as the one real
    /// scheduler does.
    schedule_window: Option<(time::Duration, time::Duration)>,
    /// Posts left with the scheduler answer from here; each is a recorded
    /// [`ConnectorCall::Schedule`].
    schedule: Script<Result<PublishReceipt, ConnectorError>>,
    /// Where a scheduled post stands answers from here, `Ok(Scheduled::Waiting)` when nothing is
    /// queued; the receipts asked about are kept apart from [`ScriptedConnector::calls`] (see
    /// [`ScriptedConnector::scheduled_calls`]).
    scheduled: Script<Result<Scheduled, ConnectorError>>,
    scheduled_calls: Mutex<Vec<PublishReceipt>>,
    /// Withdrawals answer from here; each is a recorded [`ConnectorCall::Withdraw`].
    withdraw: Script<Result<bool, ConnectorError>>,
    /// What [`Publisher::scheduled_list`] answers next; `Ok(None)` when nothing is queued.
    scheduled_list: Mutex<VecDeque<Result<Option<Vec<PlatformScheduled>>, ConnectorError>>>,
    /// Revocations answer from here, `Ok(())` (the trait's default) when nothing is queued; the
    /// credentials revoked are kept apart from [`ScriptedConnector::calls`] (see
    /// [`ScriptedConnector::revoke_calls`]).
    revoke: Script<Result<(), ConnectorError>>,
    revoke_calls: Mutex<Vec<Credential>>,
    /// The account's posting settings answer from here, `Ok(None)` (the trait's default: no
    /// posting screen) when nothing is queued; the accounts asked about (their `public`) are kept
    /// apart from [`ScriptedConnector::calls`] (see [`ScriptedConnector::creator_info_calls`]).
    creator_info: Script<Result<Option<TiktokCreator>, ConnectorError>>,
    creator_info_calls: Mutex<Vec<Value>>,
    post_metrics: Script<Result<PostMetrics, ConnectorError>>,
    account_metrics: Script<Result<AccountMetrics, ConnectorError>>,
    /// An account's recent posts answer from here, `Ok(None)` (the trait's default: not listed)
    /// when nothing is queued; the limits asked for are kept apart from
    /// [`ScriptedConnector::calls`] (see [`ScriptedConnector::recent_posts_calls`]).
    recent_posts: Script<Result<Option<Vec<RecentPost>>, ConnectorError>>,
    recent_posts_calls: Mutex<Vec<u32>>,
    send_text: Script<Result<SendReceipt, ConnectorError>>,
    /// Sender-name lookups answer from here, `Ok(None)` when nothing is queued; they are kept
    /// apart from [`ScriptedConnector::calls`] (see [`ScriptedConnector::sender_name_calls`]).
    sender_name: Script<Result<Option<String>, ConnectorError>>,
    sender_name_calls: Mutex<Vec<String>>,
    /// The WhatsApp Business app's one-time sharing answers from here, `Ok(None)` (the trait's
    /// default) when nothing is queued; the requests (their `public`'s external id, and what was
    /// asked) are kept apart from [`ScriptedConnector::calls`] (see
    /// [`ScriptedConnector::app_sync_calls`]).
    app_sync: Script<Result<Option<SendReceipt>, ConnectorError>>,
    app_sync_calls: Mutex<Vec<(Value, AppSync)>>,
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
    consent_search: Script<Result<IysAnswer, ConnectorError>>,
    report: Script<Result<Vec<DeliveryStatus>, ConnectorError>>,
    inbox: Script<Result<Vec<InboundEventDraft>, ConnectorError>>,
}

impl ScriptedConnector {
    pub fn push_account_limits(&self, result: Result<AdAccountLimits, ConnectorError>) {
        self.account_limits.push(result);
    }
    pub fn push_find_by_name(&self, result: Result<Option<String>, ConnectorError>) {
        self.find_by_name.push(result);
    }
    pub fn push_create_campaign(&self, result: Result<String, ConnectorError>) {
        self.create_campaign.push(result);
    }
    pub fn push_create_adset(&self, result: Result<String, ConnectorError>) {
        self.create_adset.push(result);
    }
    pub fn push_upload_image(&self, result: Result<String, ConnectorError>) {
        self.upload_image.push(result);
    }
    pub fn push_create_lead_form(&self, result: Result<String, ConnectorError>) {
        self.create_lead_form.push(result);
    }
    pub fn push_create_creative(&self, result: Result<String, ConnectorError>) {
        self.create_creative.push(result);
    }
    pub fn push_create_ad(&self, result: Result<String, ConnectorError>) {
        self.create_ad.push(result);
    }
    pub fn push_campaign_state(&self, result: Result<CampaignProviderState, ConnectorError>) {
        self.campaign_state.push(result);
    }
    pub fn push_ad_days(&self, result: Result<Vec<AdDay>, ConnectorError>) {
        self.ad_days.push(result);
    }
    pub fn push_preview(&self, result: Result<String, ConnectorError>) {
        self.preview.push(result);
    }

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
            account_limits: Script::default(),
            find_by_name: Script::default(),
            create_campaign: Script::default(),
            create_adset: Script::default(),
            upload_image: Script::default(),
            create_lead_form: Script::default(),
            create_creative: Script::default(),
            create_ad: Script::default(),
            campaign_state: Script::default(),
            ad_days: Script::default(),
            preview: Script::default(),
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
            schedule_window: None,
            schedule: Script::default(),
            scheduled: Script::default(),
            scheduled_calls: Mutex::default(),
            withdraw: Script::default(),
            scheduled_list: Mutex::default(),
            revoke: Script::default(),
            revoke_calls: Mutex::default(),
            creator_info: Script::default(),
            creator_info_calls: Mutex::default(),
            post_metrics: Script::default(),
            account_metrics: Script::default(),
            recent_posts: Script::default(),
            recent_posts_calls: Mutex::default(),
            send_text: Script::default(),
            sender_name: Script::default(),
            sender_name_calls: Mutex::default(),
            app_sync: Script::default(),
            app_sync_calls: Mutex::default(),
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
            consent_search: Script::default(),
            report: Script::default(),
            inbox: Script::default(),
        }
    }

    /// The adapter answering `hosts` from [`Connector::hosts`].
    pub fn with_hosts(mut self, hosts: &'static [&'static str]) -> Self {
        self.hosts = hosts;
        self
    }

    /// The adapter with a scheduler of its own that takes a post between `earliest` and
    /// `latest` ahead of its time ([`Publisher::schedule_window`]).
    pub fn with_scheduler(mut self, earliest: time::Duration, latest: time::Duration) -> Self {
        self.schedule_window = Some((earliest, latest));
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

    /// A poll's answer of drafts alone: emails without attachments' bytes.
    pub fn push_mailbox_poll(
        &self,
        result: Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError>,
    ) {
        self.mailbox_poll.push(
            result.map(|(drafts, cursor)| {
                (drafts.into_iter().map(PolledMail::from).collect(), cursor)
            }),
        );
    }

    /// A poll's answer of emails with their attachments' bytes.
    pub fn push_mailbox_poll_mail(
        &self,
        result: Result<(Vec<PolledMail>, MailboxCursor), ConnectorError>,
    ) {
        self.mailbox_poll.push(result);
    }

    pub fn push_publish(&self, result: Result<PublishReceipt, ConnectorError>) {
        self.publish.push(result);
    }

    /// Queues what the next [`Publisher::schedule`] answers.
    pub fn push_schedule(&self, result: Result<PublishReceipt, ConnectorError>) {
        self.schedule.push(result);
    }

    /// Queues what the next [`Publisher::scheduled`] answers.
    pub fn push_scheduled(&self, result: Result<Scheduled, ConnectorError>) {
        self.scheduled.push(result);
    }

    /// The receipts [`Publisher::scheduled`] was asked about, in order.
    pub fn scheduled_calls(&self) -> Vec<PublishReceipt> {
        lock(&self.scheduled_calls).clone()
    }

    /// Queues what the next [`Publisher::withdraw`] answers.
    pub fn push_withdraw(&self, result: Result<bool, ConnectorError>) {
        self.withdraw.push(result);
    }

    /// Queues what the next [`Publisher::scheduled_list`] answers (it answers `Ok(None)`, a
    /// provider without a scheduler to read, while nothing is queued).
    pub fn push_scheduled_list(
        &self,
        result: Result<Option<Vec<PlatformScheduled>>, ConnectorError>,
    ) {
        lock(&self.scheduled_list).push_back(result);
    }

    /// Queues what the next [`Publisher::resolve`] answers.
    pub fn push_resolve(&self, result: Result<Option<PublishResolution>, ConnectorError>) {
        self.resolve.push(result);
    }

    /// The receipts [`Publisher::resolve`] was asked about, in order.
    pub fn resolve_calls(&self) -> Vec<PublishReceipt> {
        lock(&self.resolve_calls).clone()
    }

    /// Queues what the next [`Connector::revoke`] answers.
    pub fn push_revoke(&self, result: Result<(), ConnectorError>) {
        self.revoke.push(result);
    }

    /// The credentials [`Connector::revoke`] was asked to give back, in order.
    pub fn revoke_calls(&self) -> Vec<Credential> {
        lock(&self.revoke_calls).clone()
    }

    /// Queues what the next [`Publisher::creator_info`] answers.
    pub fn push_creator_info(&self, result: Result<Option<TiktokCreator>, ConnectorError>) {
        self.creator_info.push(result);
    }

    /// The accounts (their `public`) [`Publisher::creator_info`] was asked about, in order.
    pub fn creator_info_calls(&self) -> Vec<Value> {
        lock(&self.creator_info_calls).clone()
    }

    pub fn push_post_metrics(&self, result: Result<PostMetrics, ConnectorError>) {
        self.post_metrics.push(result);
    }

    pub fn push_account_metrics(&self, result: Result<AccountMetrics, ConnectorError>) {
        self.account_metrics.push(result);
    }

    /// Queues what the next [`InsightsReader::recent_posts`] answers.
    pub fn push_recent_posts(&self, result: Result<Option<Vec<RecentPost>>, ConnectorError>) {
        self.recent_posts.push(result);
    }

    /// The limits [`InsightsReader::recent_posts`] was asked for, in order.
    pub fn recent_posts_calls(&self) -> Vec<u32> {
        lock(&self.recent_posts_calls).clone()
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

    pub fn push_app_sync(&self, result: Result<Option<SendReceipt>, ConnectorError>) {
        self.app_sync.push(result);
    }

    /// The WhatsApp Business app's sharing requests so far: the account asked about
    /// (`public["external_id"]`) and what was asked, in order.
    pub fn app_sync_calls(&self) -> Vec<(Value, AppSync)> {
        lock(&self.app_sync_calls).clone()
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

    /// Queues the answer of the next consent lookup (`ConsentSync::search`).
    pub fn push_consent_search(&self, result: Result<IysAnswer, ConnectorError>) {
        self.consent_search.push(result);
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

    async fn revoke(&self, cred: &Credential) -> Result<(), ConnectorError> {
        lock(&self.revoke_calls).push(cred.clone());
        self.revoke.try_next().unwrap_or(Ok(()))
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
        filter: SmsConsentFilter,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(ConnectorCall::SendSms {
            credential: cred.clone(),
            to: to.to_owned(),
            text: text.to_owned(),
            reference: reference.map(str::to_owned),
            filter,
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
    ) -> Result<(Vec<PolledMail>, MailboxCursor), ConnectorError> {
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
    fn schedule_window(
        &self,
        _public: &Value,
        request: &PublishRequest,
    ) -> Option<(time::Duration, time::Duration)> {
        if request.format == Some(jt_app::ports::connectors::PostFormat::Story)
            || request.media_urls.len() + request.media.len() > 1
        {
            return None;
        }
        self.schedule_window
    }

    async fn schedule(
        &self,
        cred: &Credential,
        public: &Value,
        request: &PublishRequest,
        at: OffsetDateTime,
    ) -> Result<PublishReceipt, ConnectorError> {
        self.record(ConnectorCall::Schedule {
            credential: cred.clone(),
            public: public.clone(),
            request: request.clone(),
            at,
        });
        self.after_send().await;
        self.next(&self.schedule, "schedule result")
    }

    async fn scheduled(
        &self,
        _cred: &Credential,
        _public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<Scheduled, ConnectorError> {
        lock(&self.scheduled_calls).push(receipt.clone());
        self.scheduled.try_next().unwrap_or(Ok(Scheduled::Waiting))
    }

    async fn withdraw(
        &self,
        cred: &Credential,
        public: &Value,
        receipt: &PublishReceipt,
    ) -> Result<bool, ConnectorError> {
        self.record(ConnectorCall::Withdraw {
            credential: cred.clone(),
            public: public.clone(),
            receipt: receipt.clone(),
        });
        self.next(&self.withdraw, "withdraw result")
    }

    async fn scheduled_list(
        &self,
        _cred: &Credential,
        _public: &Value,
    ) -> Result<Option<Vec<PlatformScheduled>>, ConnectorError> {
        lock(&self.scheduled_list).pop_front().unwrap_or(Ok(None))
    }

    /// The post is there: a scripted provider reads back what it published.
    async fn read_back(
        &self,
        _cred: &Credential,
        _public: &Value,
        _external_id: &str,
    ) -> Result<(), ConnectorError> {
        Ok(())
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

    async fn creator_info(
        &self,
        _cred: &Credential,
        public: &Value,
    ) -> Result<Option<TiktokCreator>, ConnectorError> {
        lock(&self.creator_info_calls).push(public.clone());
        self.creator_info.try_next().unwrap_or(Ok(None))
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

    async fn recent_posts(
        &self,
        _cred: &Credential,
        _public: &Value,
        limit: u32,
    ) -> Result<Option<Vec<RecentPost>>, ConnectorError> {
        lock(&self.recent_posts_calls).push(limit);
        self.recent_posts.try_next().unwrap_or(Ok(None))
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

    async fn request_app_sync(
        &self,
        _cred: &Credential,
        public: &Value,
        sync: AppSync,
    ) -> Result<Option<SendReceipt>, ConnectorError> {
        lock(&self.app_sync_calls).push((public["external_id"].clone(), sync));
        self.app_sync.try_next().unwrap_or(Ok(None))
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

    async fn search(
        &self,
        cred: &Credential,
        recipient: &str,
        channel: &str,
    ) -> Result<IysAnswer, ConnectorError> {
        self.record(ConnectorCall::ConsentSearch {
            credential: cred.clone(),
            recipient: recipient.to_owned(),
            channel: channel.to_owned(),
        });
        self.next(&self.consent_search, "consent search result")
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
// The scripted public surface
// ---------------------------------------------------------------------------------------------

/// One call a [`ScriptedPublic`] received, with its arguments.
#[derive(Clone, Debug, PartialEq)]
pub enum PublicCall {
    ReplyPublic {
        credential: Credential,
        public: Value,
        target: PublicTarget,
        text: String,
    },
    ReplyPrivate {
        credential: Credential,
        public: Value,
        target: PublicTarget,
        text: String,
    },
    Moderate {
        credential: Credential,
        public: Value,
        target: PublicTarget,
        action: ModerationAction,
    },
    Subject {
        public: Value,
        subject_external_id: String,
    },
}

/// A provider's replies and moderation on public items ([`PublicSurface`]), answering from the
/// queues its `push_*` methods fill and recording every call. A reply or a moderation with
/// nothing queued panics; [`PublicSurface::subject`] answers `Ok(None)` (the trait's default)
/// when nothing is queued. A hook queued with [`ScriptedPublic::push_hook`] runs inside the next
/// reply or moderation call, before its answer: a provider call during which the world changes.
/// Registered in a [`ScriptedRegistry`] with [`ScriptedRegistry::with_public`] only, as the
/// binary offers one only for a provider whose adapter has one.
pub struct ScriptedPublic {
    provider: Provider,
    calls: Mutex<Vec<PublicCall>>,
    hooks: Script<SendHook>,
    reply_public: Script<Result<SendReceipt, ConnectorError>>,
    reply_private: Script<Result<PrivateReceipt, ConnectorError>>,
    moderate: Script<Result<(), ConnectorError>>,
    subject: Script<Result<Option<SubjectFacts>, ConnectorError>>,
}

impl ScriptedPublic {
    /// A public surface of `provider` with nothing queued.
    pub fn new(provider: Provider) -> Self {
        ScriptedPublic {
            provider,
            calls: Mutex::new(Vec::new()),
            hooks: Script::default(),
            reply_public: Script::default(),
            reply_private: Script::default(),
            moderate: Script::default(),
            subject: Script::default(),
        }
    }

    /// The provider whose surface this is.
    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<PublicCall> {
        lock(&self.calls).clone()
    }

    pub fn push_reply_public(&self, result: Result<SendReceipt, ConnectorError>) {
        self.reply_public.push(result);
    }

    pub fn push_reply_private(&self, result: Result<PrivateReceipt, ConnectorError>) {
        self.reply_private.push(result);
    }

    pub fn push_moderate(&self, result: Result<(), ConnectorError>) {
        self.moderate.push(result);
    }

    /// Queues what the next [`PublicSurface::subject`] answers.
    pub fn push_subject(&self, result: Result<Option<SubjectFacts>, ConnectorError>) {
        self.subject.push(result);
    }

    /// Runs `hook` inside the next reply or moderation call, before it answers.
    pub fn push_hook<F, Fut>(&self, hook: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.hooks.push(Box::new(move || Box::pin(hook())));
    }

    async fn during_call(&self) {
        if let Some(hook) = self.hooks.try_next() {
            hook().await;
        }
    }

    fn record(&self, call: PublicCall) {
        lock(&self.calls).push(call);
    }
}

#[async_trait]
impl PublicSurface for ScriptedPublic {
    async fn reply_public(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<SendReceipt, ConnectorError> {
        self.record(PublicCall::ReplyPublic {
            credential: cred.clone(),
            public: public.clone(),
            target: target.clone(),
            text: text.to_owned(),
        });
        self.during_call().await;
        self.reply_public
            .next("ScriptedPublic", self.provider, "reply_public result")
    }

    async fn reply_private(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        text: &str,
    ) -> Result<PrivateReceipt, ConnectorError> {
        self.record(PublicCall::ReplyPrivate {
            credential: cred.clone(),
            public: public.clone(),
            target: target.clone(),
            text: text.to_owned(),
        });
        self.during_call().await;
        self.reply_private
            .next("ScriptedPublic", self.provider, "reply_private result")
    }

    async fn moderate(
        &self,
        cred: &Credential,
        public: &Value,
        target: &PublicTarget,
        action: ModerationAction,
    ) -> Result<(), ConnectorError> {
        self.record(PublicCall::Moderate {
            credential: cred.clone(),
            public: public.clone(),
            target: target.clone(),
            action,
        });
        self.during_call().await;
        self.moderate
            .next("ScriptedPublic", self.provider, "moderate result")
    }

    async fn subject(
        &self,
        _cred: &Credential,
        public: &Value,
        subject_external_id: &str,
    ) -> Result<Option<SubjectFacts>, ConnectorError> {
        self.record(PublicCall::Subject {
            public: public.clone(),
            subject_external_id: subject_external_id.to_owned(),
        });
        self.subject.try_next().unwrap_or(Ok(None))
    }
}

/// One call a [`ScriptedPoller`] answered.
#[derive(Clone, Debug, PartialEq)]
pub enum PollCall {
    Poll {
        ws: WorkspaceId,
        public: Value,
        cursor: Value,
    },
    Reconcile {
        public: Value,
        targets: Vec<PublicTarget>,
    },
}

/// A provider's poll of public items ([`PublicPoller`]), answering from the queues its `push_*`
/// methods fill and recording every call: a poll with nothing queued finds nothing and keeps its
/// cursor; a reconciliation with nothing queued finds nothing. A hook queued with
/// [`ScriptedPoller::push_hook`] runs inside the next call, before its answer. Registered in a
/// [`ScriptedRegistry`] with [`ScriptedRegistry::with_poller`].
pub struct ScriptedPoller {
    provider: Provider,
    calls: Mutex<Vec<PollCall>>,
    hooks: Script<SendHook>,
    poll: Script<Result<(Vec<InboundEventDraft>, Value), ConnectorError>>,
    reconcile: Script<Result<Vec<InboundEventDraft>, ConnectorError>>,
}

impl ScriptedPoller {
    /// A poller of `provider` with nothing queued.
    pub fn new(provider: Provider) -> Self {
        ScriptedPoller {
            provider,
            calls: Mutex::new(Vec::new()),
            hooks: Script::default(),
            poll: Script::default(),
            reconcile: Script::default(),
        }
    }

    /// Every call so far, in order.
    pub fn calls(&self) -> Vec<PollCall> {
        lock(&self.calls).clone()
    }

    /// Queues what the next poll answers: its drafts and the next cursor.
    pub fn push_poll(&self, result: Result<(Vec<InboundEventDraft>, Value), ConnectorError>) {
        self.poll.push(result);
    }

    /// Queues what the next reconciliation answers.
    pub fn push_reconcile(&self, result: Result<Vec<InboundEventDraft>, ConnectorError>) {
        self.reconcile.push(result);
    }

    /// Runs `hook` inside the next call, before it answers.
    pub fn push_hook<F, Fut>(&self, hook: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        self.hooks.push(Box::new(move || Box::pin(hook())));
    }

    async fn during_call(&self) {
        if let Some(hook) = self.hooks.try_next() {
            hook().await;
        }
    }
}

#[async_trait]
impl PublicPoller for ScriptedPoller {
    async fn poll(
        &self,
        ws: WorkspaceId,
        _cred: &Credential,
        public: &Value,
        cursor: &Value,
    ) -> Result<(Vec<InboundEventDraft>, Value), ConnectorError> {
        lock(&self.calls).push(PollCall::Poll {
            ws,
            public: public.clone(),
            cursor: cursor.clone(),
        });
        self.during_call().await;
        self.poll
            .try_next()
            .unwrap_or_else(|| Ok((Vec::new(), cursor.clone())))
    }

    async fn reconcile(
        &self,
        _cred: &Credential,
        public: &Value,
        targets: &[PublicTarget],
    ) -> Result<Vec<InboundEventDraft>, ConnectorError> {
        lock(&self.calls).push(PollCall::Reconcile {
            public: public.clone(),
            targets: targets.to_vec(),
        });
        self.during_call().await;
        self.reconcile.try_next().unwrap_or_else(|| Ok(Vec::new()))
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
    /// The sign-in variant each call ran (see [`ScriptedOAuth::flows`]).
    flows: Mutex<Vec<(&'static str, Option<OAuthFlow>)>>,
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
            flows: Mutex::default(),
        }
    }

    /// The sign-in variant each call ran, in order, by the call's name (`authorize_url`,
    /// `exchange`, `list_assets`): what the use cases asked the `*_for` forms with.
    pub fn flows(&self) -> Vec<(&'static str, Option<OAuthFlow>)> {
        lock(&self.flows).clone()
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

    /// As [`ScriptedOAuth::authorize_url`], the flow recorded ([`ScriptedOAuth::flows`]) and, when
    /// there is one, named in the URL (`flow=<key>`).
    fn authorize_url_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        state: &str,
        pkce_challenge: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Url, ConnectorError> {
        lock(&self.flows).push(("authorize_url", flow));
        let mut url = self.authorize_url(app, redirect, state, pkce_challenge)?;
        if let Some(flow) = flow {
            url.query_pairs_mut().append_pair("flow", flow.key());
        }
        Ok(url)
    }

    async fn exchange_for(
        &self,
        app: &OAuthApp,
        redirect: &Url,
        code: &str,
        pkce_verifier: Option<&str>,
        flow: Option<OAuthFlow>,
    ) -> Result<Credential, ConnectorError> {
        lock(&self.flows).push(("exchange", flow));
        self.exchange(app, redirect, code, pkce_verifier).await
    }

    async fn list_assets_for(
        &self,
        cred: &Credential,
        flow: Option<OAuthFlow>,
    ) -> Result<Vec<Asset>, ConnectorError> {
        lock(&self.flows).push(("list_assets", flow));
        self.list_assets(cred).await
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
    public: BTreeMap<Provider, Arc<ScriptedPublic>>,
    pollers: BTreeMap<Provider, Arc<ScriptedPoller>>,
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

    /// Registers `public` as its provider's public surface ([`ConnectorRegistry::public`]),
    /// replacing any registered before. Only explicitly: no production adapter offers one yet.
    pub fn with_public(mut self, public: Arc<ScriptedPublic>) -> Self {
        self.public.insert(public.provider, public);
        self
    }

    /// Registers `poller` as its provider's public poll ([`ConnectorRegistry::public_poller`]),
    /// replacing any registered before.
    pub fn with_poller(mut self, poller: Arc<ScriptedPoller>) -> Self {
        self.pollers.insert(poller.provider, poller);
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

    fn ad_campaigns(&self, provider: Provider) -> Option<Arc<dyn AdCampaignWriter>> {
        self.offered(provider, META_ONLY)
            .map(|c| c as Arc<dyn AdCampaignWriter>)
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

    fn public(&self, provider: Provider) -> Option<Arc<dyn PublicSurface>> {
        self.public
            .get(&provider)
            .cloned()
            .map(|p| p as Arc<dyn PublicSurface>)
    }

    fn public_poller(&self, provider: Provider) -> Option<Arc<dyn PublicPoller>> {
        self.pollers
            .get(&provider)
            .cloned()
            .map(|p| p as Arc<dyn PublicPoller>)
    }
}

#[async_trait]
impl AdCampaignWriter for ScriptedConnector {
    async fn account_limits(
        &self,
        cred: &Credential,
        public: &Value,
    ) -> Result<AdAccountLimits, ConnectorError> {
        self.record(ConnectorCall::AccountLimits {
            credential: cred.clone(),
            public: public.clone(),
        });
        self.account_limits
            .next("connector", self.provider, "account_limits")
    }
    async fn find_by_name(
        &self,
        cred: &Credential,
        public: &Value,
        level: AdLevel,
        name: &str,
    ) -> Result<Option<String>, ConnectorError> {
        self.record(ConnectorCall::FindByName {
            credential: cred.clone(),
            public: public.clone(),
            level,
            name: name.to_owned(),
        });
        self.find_by_name
            .next("connector", self.provider, "find_by_name")
    }
    async fn create_campaign(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CampaignSpec,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::CreateCampaign {
            credential: cred.clone(),
            public: public.clone(),
            spec: spec.clone(),
        });
        self.create_campaign
            .next("connector", self.provider, "create_campaign")
    }
    async fn create_adset(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSetSpec,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::CreateAdset {
            credential: cred.clone(),
            public: public.clone(),
            spec: spec.clone(),
        });
        self.create_adset
            .next("connector", self.provider, "create_adset")
    }
    async fn upload_image(
        &self,
        cred: &Credential,
        public: &Value,
        bytes: &[u8],
        name: &str,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::UploadImage {
            credential: cred.clone(),
            public: public.clone(),
            bytes: bytes.to_owned(),
            name: name.to_owned(),
        });
        self.upload_image
            .next("connector", self.provider, "upload_image")
    }
    async fn create_lead_form(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &LeadFormSpec,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::CreateLeadForm {
            credential: cred.clone(),
            public: public.clone(),
            spec: spec.clone(),
        });
        self.create_lead_form
            .next("connector", self.provider, "create_lead_form")
    }
    async fn create_creative(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &CreativeSpec,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::CreateCreative {
            credential: cred.clone(),
            public: public.clone(),
            spec: spec.clone(),
        });
        self.create_creative
            .next("connector", self.provider, "create_creative")
    }
    async fn create_ad(
        &self,
        cred: &Credential,
        public: &Value,
        spec: &AdSpec,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::CreateAd {
            credential: cred.clone(),
            public: public.clone(),
            spec: spec.clone(),
        });
        self.create_ad.next("connector", self.provider, "create_ad")
    }
    async fn campaign_state(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
    ) -> Result<CampaignProviderState, ConnectorError> {
        self.record(ConnectorCall::CampaignState {
            credential: cred.clone(),
            public: public.clone(),
            campaign_id: campaign_id.to_owned(),
        });
        self.campaign_state
            .next("connector", self.provider, "campaign_state")
    }
    async fn ad_days(
        &self,
        cred: &Credential,
        public: &Value,
        campaign_id: &str,
        objective: jt_app::ports::connectors::AdObjective,
        since: Date,
        until: Date,
    ) -> Result<Vec<AdDay>, ConnectorError> {
        self.record(ConnectorCall::AdDays {
            credential: cred.clone(),
            public: public.clone(),
            campaign_id: campaign_id.to_owned(),
            objective,
            since,
            until,
        });
        self.ad_days.next("connector", self.provider, "ad_days")
    }
    async fn preview(
        &self,
        cred: &Credential,
        public: &Value,
        creative: &CreativeSpec,
        placement: AdPlacement,
    ) -> Result<String, ConnectorError> {
        self.record(ConnectorCall::Preview {
            credential: cred.clone(),
            public: public.clone(),
            creative: creative.clone(),
            placement,
        });
        self.preview.next("connector", self.provider, "preview")
    }
}
