//! The scheduled jobs over the in-memory fakes and scripted provider adapters: token refresh
//! (with its compare-and-swap), probes of stale connections (bounded concurrency), the NetGSM
//! delivery-report and inbox polls, and the purges. One test per rule.

mod support;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, DeliveryState,
    DeliveryStatus, InboundEventDraft, InsightsReader, LeadGenFetcher, MessagingSender,
    OAuthProvider, Publisher, SmsSender, Telephony,
};
use jt_app::ports::{OAuthPendingId, OAuthPendingRow, ProbeRun, ProbeRunId, SecretBox, UnitOfWork};
use jt_app::usecases::jobs::{self, Job, JobReport};
use jt_app::usecases::webhook;
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{
    ConnectorError, Credential, EventKind, InboundEvent, InboundEventId, NetgsmPurpose,
    ProbeResult, Provider,
};
use jt_ledger::Actor;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, InMemoryUow, PlainSecretBox, ScriptedConnector, ScriptedRegistry,
    StoredCapability,
};
use serde_json::{Value, json};
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

const NOW: OffsetDateTime = FIXED_NOW;

/// Every secret the capabilities below are sealed with; none may come back out.
const SECRETS: &[&str] = &[
    "IGQ-old",
    "IGQ-new",
    "x-access-old",
    "x-refresh-old",
    "x-access-new",
    "x-refresh-new",
    "netgsm-pass",
    "EAAB-page",
];

// ---------------------------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------------------------

/// The world "Acme", active, with a scripted adapter per provider.
struct Rig {
    w: World,
    meta: Arc<ScriptedConnector>,
    netgsm: Arc<ScriptedConnector>,
    x: Arc<ScriptedConnector>,
}

async fn rig() -> Rig {
    rig_with(ScriptedConnector::new(Provider::Netgsm)).await
}

/// The rig with `netgsm` as the NetGSM adapter.
async fn rig_with(netgsm: ScriptedConnector) -> Rig {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
    let netgsm = Arc::new(netgsm);
    let x = Arc::new(ScriptedConnector::new(Provider::X));
    w.deps.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(meta.clone())
            .with_connector(netgsm.clone())
            .with_connector(x.clone()),
    );
    Rig { w, meta, netgsm, x }
}

fn rfc3339(at: OffsetDateTime) -> String {
    at.format(&Rfc3339).unwrap()
}

/// A Meta (Instagram login) token expiring at `expires_at`.
fn instagram_token(token: &str, expires_at: OffsetDateTime) -> Credential {
    Credential::OAuth {
        access_token: token.into(),
        refresh_token: None,
        expires_at: Some(expires_at),
        scopes: vec!["instagram_business_basic".into()],
    }
}

/// An X token pair expiring at `expires_at`.
fn x_token(access: &str, refresh: &str, expires_at: OffsetDateTime) -> Credential {
    Credential::OAuth {
        access_token: access.into(),
        refresh_token: Some(refresh.into()),
        expires_at: Some(expires_at),
        scopes: vec!["tweet.write".into(), "offline.access".into()],
    }
}

/// A NetGSM SMS sub-user sending as `msgheader`.
fn netgsm_line(msgheader: &str) -> Credential {
    Credential::NetgsmSms {
        usercode: "8508850000".into(),
        password: "netgsm-pass".into(),
        msgheader: msgheader.into(),
    }
}

/// The sealed form of `credential` in `ws`, as the use cases seal it.
fn sealed(ws: WorkspaceId, credential: &Credential) -> Vec<u8> {
    PlainSecretBox
        .seal(ws, &serde_json::to_vec(credential).unwrap())
        .unwrap()
}

/// `public` with the credential's public facts, as connecting writes them.
fn with_access(credential: &Credential, mut public: Value) -> Value {
    if public.is_null() {
        public = json!({});
    }
    public["access"] = credential.redact_for_public();
    public
}

/// The last probe, `at`, as a probe writes it into `connector_public.health`.
fn probed_at(at: OffsetDateTime) -> Value {
    json!({ "ok": true, "at": rfc3339(at), "latency_ms": 12, "error_kind": null })
}

impl Rig {
    fn ws(&self) -> WorkspaceId {
        self.w.ws
    }

    /// Stores a connector capability of `kind` holding `external_id`, in `status`, with
    /// `connector_public` as given and sealed `credential` (raw `bytes` when given instead).
    async fn store(
        &self,
        ws: WorkspaceId,
        kind: &str,
        external_id: &str,
        status: StoredStatus,
        public: Value,
        sealed_bytes: Option<Vec<u8>>,
    ) -> CapabilityId {
        let mut c = Capability::new(
            CapabilityId::new_v7(),
            ws,
            NewCapability {
                kind_key: kind.into(),
                name: format!("{kind} {external_id}"),
                external_id: Some(external_id.into()),
                ..NewCapability::default()
            },
            NOW - Duration::days(10),
        )
        .unwrap();
        c.status = status;
        c.connector_public = public;
        if status == StoredStatus::Verified {
            c.last_verified_at = Some(NOW - Duration::days(1));
        }
        let id = c.id;
        let mut t = self.w.uow.tenant(ws).await.unwrap();
        t.capabilities().insert(c, sealed_bytes).await.unwrap();
        t.commit().await.unwrap();
        id
    }

    /// [`Rig::store`] in the rig's workspace, sealing `credential` and writing its public facts.
    async fn connected(
        &self,
        kind: &str,
        external_id: &str,
        status: StoredStatus,
        credential: &Credential,
        public: Value,
    ) -> CapabilityId {
        self.store(
            self.ws(),
            kind,
            external_id,
            status,
            with_access(credential, public),
            Some(sealed(self.ws(), credential)),
        )
        .await
    }

    fn stored(&self, id: CapabilityId) -> StoredCapability {
        self.w
            .uow
            .snapshot()
            .capabilities
            .into_iter()
            .find(|s| s.capability.id == id)
            .expect("the capability is stored")
    }

    fn capability(&self, id: CapabilityId) -> Capability {
        self.stored(id).capability
    }

    /// The credential sealed for capability `id`, opened.
    fn credential(&self, id: CapabilityId) -> Credential {
        let stored = self.stored(id);
        let ws = stored.capability.workspace_id;
        let plain = PlainSecretBox
            .open(ws, &stored.sealed.expect("sealed"))
            .unwrap();
        serde_json::from_slice(&plain).unwrap()
    }

    fn events(&self) -> Vec<InboundEvent> {
        self.w
            .uow
            .snapshot()
            .inbound_events
            .into_iter()
            .map(|s| s.event)
            .collect()
    }

    /// Asserts no secret appears in the ledger or in any capability's stored fields.
    fn assert_no_secret_leaked(&self) {
        let state = self.w.uow.snapshot();
        let ledger =
            serde_json::to_string(&state.ledger.iter().map(|r| &r.entry).collect::<Vec<_>>())
                .unwrap();
        let capabilities = serde_json::to_string(
            &state
                .capabilities
                .iter()
                .map(|s| &s.capability)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        for secret in SECRETS {
            assert!(!ledger.contains(secret), "{secret} in the ledger");
            assert!(!capabilities.contains(secret), "{secret} in a capability");
        }
    }
}

fn report(touched: u64, changed: u64, skipped: u64, failed: u64) -> JobReport {
    JobReport {
        touched,
        changed,
        skipped,
        failed,
    }
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

#[test]
fn every_job_has_a_lock_named_after_it() {
    let names: Vec<&str> = Job::ALL.iter().map(Job::name).collect();
    assert_eq!(
        names,
        [
            "refresh_tokens",
            "probe_all",
            "netgsm_dlr_poll",
            "netgsm_inbox_poll",
            "purge_raw_bodies",
            "purge_oauth_pending",
            "purge_probe_runs",
        ]
    );
    for job in Job::ALL {
        assert_eq!(job.lock_name(), format!("jeeta.jobs.{}", job.name()));
    }
}

// ---------------------------------------------------------------------------------------------
// refresh_tokens
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn refresh_marks_unreachable_on_auth_error() {
    let r = rig().await;
    let token = instagram_token("IGQ-old", NOW + Duration::days(3));
    let ig = r
        .connected(
            "instagram",
            "ig-1",
            StoredStatus::Verified,
            &token,
            json!({}),
        )
        .await;
    r.meta.push_refresh(Err(ConnectorError::auth(
        "the session has been invalidated",
    )));

    let out = jobs::run_refresh_tokens(&r.w.deps, NOW).await;
    assert_eq!(out, report(1, 1, 0, 1));
    assert_eq!(
        r.meta.calls(),
        [ConnectorCall::Refresh {
            credential: token.clone()
        }]
    );
    let c = r.capability(ig);
    assert_eq!(c.status, StoredStatus::Unreachable);
    assert_eq!(c.connector_public["reconnect_required"], json!(true));
    // The credential stays as it was: only the owner can renew it.
    assert_eq!(r.credential(ig), token);
    let entries = r.w.entries("connector.refresh_failed");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].payload,
        json!({ "kind_key": "instagram", "error_kind": "auth" })
    );
    assert_eq!(
        entries[0].actor,
        Actor::System {
            component: "scheduler:refresh_tokens".into()
        }
    );
    assert_eq!(entries[0].at, NOW);
    r.assert_no_secret_leaked();

    // A capability waiting for its owner to reconnect is not asked again: no call, no entry.
    let again = jobs::run_refresh_tokens(&r.w.deps, NOW + Duration::hours(1)).await;
    assert_eq!(again, report(0, 0, 0, 0));
    assert_eq!(r.meta.calls().len(), 1);
    assert_eq!(r.w.entries("connector.refresh_failed").len(), 1);
}

#[tokio::test]
async fn refresh_takes_only_tokens_expiring_within_seven_days() {
    let r = rig().await;
    let soon = instagram_token("IGQ-old", NOW + Duration::days(6));
    let later = instagram_token("IGQ-old", NOW + Duration::days(8));
    let due = r
        .connected(
            "instagram",
            "ig-soon",
            StoredStatus::Verified,
            &soon,
            json!({}),
        )
        .await;
    r.connected(
        "instagram",
        "ig-later",
        StoredStatus::Verified,
        &later,
        json!({}),
    )
    .await;
    // Credentials with no expiry of their own are never refreshed (a NetGSM line, a page token).
    r.connected(
        "sms_line",
        "ACME",
        StoredStatus::Verified,
        &netgsm_line("ACME"),
        json!({}),
    )
    .await;
    // Nor is a retired capability, one without credentials, or one of another provider's kind
    // without an expiry.
    r.connected(
        "instagram",
        "ig-retired",
        StoredStatus::Retired,
        &soon,
        json!({}),
    )
    .await;
    r.store(
        r.ws(),
        "instagram",
        "ig-bare",
        StoredStatus::Declared,
        with_access(&soon, json!({})),
        None,
    )
    .await;
    // The provider says the token needs no renewal yet.
    r.meta.push_refresh(Ok(None));

    let out = jobs::run_refresh_tokens(&r.w.deps, NOW).await;
    assert_eq!(out, report(1, 0, 0, 0));
    assert_eq!(
        r.meta.calls(),
        [ConnectorCall::Refresh {
            credential: soon.clone()
        }]
    );
    assert!(r.netgsm.calls().is_empty());
    assert_eq!(r.credential(due), soon);
    assert_eq!(r.capability(due).status, StoredStatus::Verified);
}

#[tokio::test]
async fn refresh_x_always_rotates() {
    let r = rig().await;
    // An X token far from its expiry is refreshed all the same: its refresh token rotates.
    let old = x_token("x-access-old", "x-refresh-old", NOW + Duration::days(30));
    let account = r
        .connected("x", "x-user-1", StoredStatus::Verified, &old, json!({}))
        .await;
    let new = x_token("x-access-new", "x-refresh-new", NOW + Duration::hours(2));
    r.x.push_refresh(Ok(Some(new.clone())));

    let out = jobs::run_refresh_tokens(&r.w.deps, NOW).await;
    assert_eq!(out, report(1, 1, 0, 0));
    assert_eq!(
        r.x.calls(),
        [ConnectorCall::Refresh {
            credential: old.clone()
        }]
    );
    assert_eq!(r.credential(account), new);
    let c = r.capability(account);
    // The public facts follow the new credential; the status does not move (a probe decides it).
    assert_eq!(c.connector_public["access"], new.redact_for_public());
    assert_eq!(
        c.connector_public["access"]["expires_at"],
        json!(rfc3339(NOW + Duration::hours(2)))
    );
    assert_eq!(c.status, StoredStatus::Verified);
    assert_eq!(c.updated_at, NOW);
    // A renewal is routine: no ledger entry.
    assert!(r.w.ledger("connector.").is_empty());
    r.assert_no_secret_leaked();
}

/// A Meta adapter whose refresh, while it runs, has another writer replace the capability's
/// credential (an owner reconnecting at that moment), then answers `answer`.
struct Racing {
    uow: InMemoryUow,
    ws: WorkspaceId,
    target: Mutex<Option<CapabilityId>>,
    replacement: Vec<u8>,
    answer: Mutex<Option<Result<Option<Credential>, ConnectorError>>>,
}

#[async_trait]
impl Connector for Racing {
    fn provider(&self) -> Provider {
        Provider::Meta
    }

    fn hosts(&self) -> &'static [&'static str] {
        &[]
    }

    async fn probe(&self, _cred: &Credential, _public: &Value) -> ProbeResult {
        panic!("not probed here")
    }

    async fn refresh(&self, _cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        let id = self.target.lock().unwrap().expect("a target");
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.capabilities()
            .set_sealed(id, Some(self.replacement.clone()), NOW)
            .await
            .unwrap();
        t.commit().await.unwrap();
        self.answer.lock().unwrap().take().expect("one refresh")
    }
}

/// A registry with one adapter.
struct Only(Arc<dyn Connector>);

impl ConnectorRegistry for Only {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        (provider == self.0.provider()).then(|| Arc::clone(&self.0))
    }
    fn oauth(&self, _: Provider) -> Option<Arc<dyn OAuthProvider>> {
        None
    }
    fn sms(&self, _: Provider) -> Option<Arc<dyn SmsSender>> {
        None
    }
    fn publisher(&self, _: Provider) -> Option<Arc<dyn Publisher>> {
        None
    }
    fn insights(&self, _: Provider) -> Option<Arc<dyn InsightsReader>> {
        None
    }
    fn messaging(&self, _: Provider) -> Option<Arc<dyn MessagingSender>> {
        None
    }
    fn ads(&self, _: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        None
    }
    fn leadgen(&self, _: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        None
    }
    fn telephony(&self, _: Provider) -> Option<Arc<dyn Telephony>> {
        None
    }
    fn consent(&self, _: Provider) -> Option<Arc<dyn ConsentSync>> {
        None
    }
    fn delivery_reports(&self, _: Provider) -> Option<Arc<dyn DeliveryReports>> {
        None
    }
}

#[tokio::test]
async fn refresh_skips_when_the_credential_changed_underneath() {
    for answer in [
        Ok(Some(instagram_token("IGQ-new", NOW + Duration::days(60)))),
        Err(ConnectorError::auth("expired")),
    ] {
        let mut r = rig().await;
        let old = instagram_token("IGQ-old", NOW + Duration::days(2));
        let ig = r
            .connected("instagram", "ig-1", StoredStatus::Verified, &old, json!({}))
            .await;
        // What the owner's reconnection seals while the refresh is out at the provider.
        let theirs = instagram_token("EAAB-page", NOW + Duration::days(59));
        let racing = Arc::new(Racing {
            uow: r.w.uow.clone(),
            ws: r.ws(),
            target: Mutex::new(Some(ig)),
            replacement: sealed(r.ws(), &theirs),
            answer: Mutex::new(Some(answer.clone())),
        });
        r.w.deps.connectors = Arc::new(Only(racing));

        let out = jobs::run_refresh_tokens(&r.w.deps, NOW).await;
        // The refresh answered about a credential that is no longer there: nothing is written
        // over the newer one, and an expired old token does not mark the new one unreachable.
        assert_eq!(out.changed, 0, "{answer:?}");
        assert_eq!(out.skipped, 1, "{answer:?}");
        assert_eq!(r.credential(ig), theirs, "{answer:?}");
        let c = r.capability(ig);
        assert_eq!(c.status, StoredStatus::Verified, "{answer:?}");
        assert_eq!(
            c.connector_public["access"],
            old.redact_for_public(),
            "{answer:?}"
        );
        assert_ne!(c.connector_public["reconnect_required"], json!(true));
        assert!(r.w.entries("connector.refresh_failed").is_empty());
    }
}

// ---------------------------------------------------------------------------------------------
// probe_all
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_all_skips_recent() {
    let r = rig().await;
    let line = netgsm_line("ACME");
    // Probed half an hour ago: not again yet.
    let recent = r
        .connected(
            "sms_line",
            "ACME",
            StoredStatus::Verified,
            &line,
            json!({ "health": probed_at(NOW - Duration::minutes(30)) }),
        )
        .await;
    // Probed two hours ago, and never: both are probed.
    let stale = r
        .connected(
            "sms_line",
            "ACME2",
            StoredStatus::Verified,
            &netgsm_line("ACME2"),
            json!({ "health": probed_at(NOW - Duration::hours(2)) }),
        )
        .await;
    let page_token = Credential::PageToken {
        page_id: "page-1".into(),
        token: "EAAB-page".into(),
    };
    let never = r
        .connected(
            "facebook_page",
            "page-1",
            StoredStatus::Declared,
            &page_token,
            json!({}),
        )
        .await;
    // Never probed: a declared capability without credentials, and a retired one.
    r.store(
        r.ws(),
        "sms_line",
        "BARE",
        StoredStatus::Declared,
        json!({}),
        None,
    )
    .await;
    r.connected(
        "sms_line",
        "GONE",
        StoredStatus::Retired,
        &netgsm_line("GONE"),
        json!({}),
    )
    .await;
    r.netgsm.push_probe(ProbeResult::success(
        20,
        json!({ "account_id": "ACME2", "balance": 12 }),
    ));
    r.meta
        .push_probe(ProbeResult::success(30, json!({ "account_id": "page-1" })));

    let out = jobs::run_probe_all(&r.w.deps, NOW).await;
    // The page went from declared to verified; the line stayed verified.
    assert_eq!(out, report(2, 1, 0, 0));
    assert_eq!(r.netgsm.calls().len(), 1);
    assert_eq!(r.meta.calls().len(), 1);
    assert_eq!(
        r.capability(recent).connector_public["health"],
        probed_at(NOW - Duration::minutes(30))
    );
    for id in [stale, never] {
        let c = r.capability(id);
        assert_eq!(c.status, StoredStatus::Verified);
        assert_eq!(c.connector_public["health"]["at"], json!(rfc3339(NOW)));
        assert_eq!(c.last_verified_at, Some(NOW));
    }
    // Same side effects as the use case: a probe run each, and `connector.probe` only for the
    // status that changed, by the scheduler.
    let runs = r.w.uow.snapshot().probe_runs;
    assert_eq!(runs.len(), 2);
    let entries = r.w.entries("connector.probe");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].subject.as_ref().unwrap().id, never.to_string());
    assert_eq!(
        entries[0].actor,
        Actor::System {
            component: "scheduler:probe_all".into()
        }
    );

    // An hour later the recent one is due, the others not yet.
    r.netgsm.push_probe(ProbeResult::success(
        20,
        json!({ "account_id": "ACME", "balance": 12 }),
    ));
    let later = jobs::run_probe_all(&r.w.deps, NOW + Duration::minutes(30)).await;
    assert_eq!(later, report(1, 0, 0, 0));
    assert_eq!(r.netgsm.calls().len(), 2);
    r.assert_no_secret_leaked();
}

#[tokio::test]
async fn probe_all_bounds_concurrency_to_four() {
    let r = rig_with(ScriptedConnector::new(Provider::Netgsm).with_probe_yields(25)).await;
    for i in 0..10 {
        let header = format!("LINE{i}");
        r.connected(
            "sms_line",
            &header,
            StoredStatus::Verified,
            &netgsm_line(&header),
            json!({}),
        )
        .await;
        r.netgsm
            .push_probe(ProbeResult::failure(5, ConnectorError::transient("busy")));
    }

    let out = jobs::run_probe_all(&r.w.deps, NOW).await;
    assert_eq!(out, report(10, 0, 0, 0));
    assert_eq!(r.netgsm.calls().len(), 10);
    // They overlapped, and never more than four at once.
    assert_eq!(r.netgsm.max_probes_in_flight(), 4);
}

#[tokio::test]
async fn one_failing_capability_does_not_abort_the_job() {
    let r = rig().await;
    // A line whose sealed bytes cannot be opened, between two good ones.
    r.connected(
        "sms_line",
        "GOOD1",
        StoredStatus::Verified,
        &netgsm_line("GOOD1"),
        json!({}),
    )
    .await;
    let broken = r
        .store(
            r.ws(),
            "sms_line",
            "BROKEN",
            StoredStatus::Verified,
            json!({}),
            Some(b"not sealed by anyone".to_vec()),
        )
        .await;
    r.connected(
        "sms_line",
        "GOOD2",
        StoredStatus::Verified,
        &netgsm_line("GOOD2"),
        json!({}),
    )
    .await;
    for account in ["GOOD1", "GOOD2"] {
        r.netgsm
            .push_probe(ProbeResult::success(10, json!({ "account_id": account })));
    }
    let out = jobs::run_probe_all(&r.w.deps, NOW).await;
    assert_eq!(out, report(3, 0, 0, 1));
    assert_eq!(r.netgsm.calls().len(), 2);
    assert_eq!(r.capability(broken).status, StoredStatus::Verified);

    // Refresh: one provider failure (busy) and one rotation in the same run.
    let first = x_token("x-access-old", "x-refresh-old", NOW + Duration::hours(1));
    let second = x_token("x-access-old", "x-refresh-old", NOW + Duration::hours(1));
    let a = r
        .connected("x", "x-a", StoredStatus::Verified, &first, json!({}))
        .await;
    let b = r
        .connected("x", "x-b", StoredStatus::Verified, &second, json!({}))
        .await;
    let new = x_token("x-access-new", "x-refresh-new", NOW + Duration::hours(2));
    r.x.push_refresh(Err(ConnectorError::transient("timeout")));
    r.x.push_refresh(Ok(Some(new.clone())));
    let out = jobs::run_refresh_tokens(&r.w.deps, NOW).await;
    assert_eq!(out, report(2, 1, 0, 1));
    // A busy provider changes nothing; the other capability is renewed.
    assert_eq!(r.credential(a), first);
    assert_eq!(r.capability(a).status, StoredStatus::Verified);
    assert_eq!(r.credential(b), new);
    assert!(r.w.entries("connector.refresh_failed").is_empty());
}

#[tokio::test]
async fn provider_jobs_skip_workspaces_that_are_not_active() {
    let r = rig().await;
    // A second workspace, still waiting for payment, with a due token and a stale line.
    let (beta, _) = r.w.other_workspace().await;
    let token = instagram_token("IGQ-old", NOW + Duration::days(1));
    let line = netgsm_line("BETA");
    r.store(
        beta,
        "instagram",
        "ig-beta",
        StoredStatus::Verified,
        with_access(&token, json!({})),
        Some(sealed(beta, &token)),
    )
    .await;
    r.store(
        beta,
        "sms_line",
        "BETA",
        StoredStatus::Verified,
        json!({}),
        Some(sealed(beta, &line)),
    )
    .await;

    assert_eq!(
        jobs::run_refresh_tokens(&r.w.deps, NOW).await,
        report(0, 0, 0, 0)
    );
    assert_eq!(
        jobs::run_probe_all(&r.w.deps, NOW).await,
        report(0, 0, 0, 0)
    );
    assert_eq!(
        jobs::run_netgsm_inbox_poll(&r.w.deps, NOW).await,
        report(0, 0, 0, 0)
    );
    assert!(r.meta.calls().is_empty());
    assert!(r.netgsm.calls().is_empty());
}

// ---------------------------------------------------------------------------------------------
// NetGSM polls
// ---------------------------------------------------------------------------------------------

/// An incoming SMS as NetGSM's inbox (and its MO webhook) names it.
fn mo(gorevid: &str, text: &str) -> InboundEventDraft {
    InboundEventDraft {
        external_id: format!("netgsm-mo:{gorevid}"),
        kind: EventKind::Message,
        payload: json!({
            "netgsm_mo": { "mesaj": text, "ceptel": "905550000000", "gorevid": gorevid }
        }),
        occurred_at: Some(NOW - Duration::minutes(20)),
    }
}

#[tokio::test]
async fn inbox_poll_always_sends_both_dates() {
    let r = rig().await;
    let creds = netgsm_line("ACME");
    let line = r
        .connected(
            "sms_line",
            "ACME",
            StoredStatus::Verified,
            &creds,
            json!({}),
        )
        .await;
    // Not polled: a line not verified, and a PBX.
    r.connected(
        "sms_line",
        "NEW",
        StoredStatus::Declared,
        &netgsm_line("NEW"),
        json!({}),
    )
    .await;
    let pbx = Credential::NetgsmPbx {
        username: "8508850000".into(),
        password: "netgsm-pass".into(),
        trunk: None,
        pbxnum: None,
    };
    r.connected(
        "netgsm_pbx",
        "8508850000",
        StoredStatus::Verified,
        &pbx,
        json!({}),
    )
    .await;
    r.netgsm.push_inbox(Ok(vec![mo("101", "Merhaba")]));

    let out = jobs::run_netgsm_inbox_poll(&r.w.deps, NOW).await;
    assert_eq!(out, report(1, 1, 0, 0));
    // The last two hours, both ends always given.
    assert_eq!(
        r.netgsm.calls(),
        [ConnectorCall::Inbox {
            credential: creds,
            from: NOW - Duration::hours(2),
            to: NOW,
        }]
    );
    let events = r.events();
    assert_eq!(events.len(), 1);
    let e = &events[0];
    assert_eq!(e.workspace_id, r.ws());
    assert_eq!(e.provider, Provider::Netgsm);
    assert_eq!(e.capability_id, Some(line));
    assert_eq!(e.external_id, "netgsm-mo:101");
    assert_eq!(e.kind, EventKind::Message);
    assert_eq!(e.received_at, NOW);
    assert_eq!(e.processed_at, None);
    assert_eq!(e.payload["netgsm_mo"]["mesaj"], "Merhaba");
    assert_eq!(
        e.payload["occurred_at"],
        json!(rfc3339(NOW - Duration::minutes(20)))
    );
    // A poll has no raw body to keep.
    assert_eq!(r.w.uow.snapshot().inbound_events[0].raw, None);
    // Inbound events are records of the outside world: no ledger entry.
    assert!(r.w.ledger("events.").is_empty());
}

#[tokio::test]
async fn inbox_poll_dedupes_against_webhook_events() {
    let r = rig().await;
    let line = r
        .connected(
            "sms_line",
            "ACME",
            StoredStatus::Verified,
            &netgsm_line("ACME"),
            json!({}),
        )
        .await;
    // The webhook delivered message 7 first.
    webhook::receive_netgsm(
        &r.w.deps,
        r.ws(),
        NetgsmPurpose::Mo,
        vec![mo("7", "ilk")],
        b"mesaj=ilk&gorevid=7",
    )
    .await
    .unwrap();
    // The inbox finds it again, with one the webhook missed.
    r.netgsm
        .push_inbox(Ok(vec![mo("8", "ikinci"), mo("7", "ilk")]));
    let out = jobs::run_netgsm_inbox_poll(&r.w.deps, NOW).await;
    assert_eq!(out, report(1, 1, 1, 0));
    let mut ids: Vec<String> = r.events().into_iter().map(|e| e.external_id).collect();
    ids.sort();
    assert_eq!(ids, ["netgsm-mo:7", "netgsm-mo:8"]);
    let polled = r
        .events()
        .into_iter()
        .find(|e| e.external_id == "netgsm-mo:8")
        .unwrap();
    assert_eq!(polled.capability_id, Some(line));

    // The next poll overlaps the last one: nothing is stored twice.
    r.netgsm
        .push_inbox(Ok(vec![mo("8", "ikinci"), mo("7", "ilk")]));
    let again = jobs::run_netgsm_inbox_poll(&r.w.deps, NOW + Duration::hours(1)).await;
    assert_eq!(again, report(1, 0, 2, 0));
    assert_eq!(r.events().len(), 2);
}

#[tokio::test]
async fn inbox_poll_failure_is_counted_and_the_next_line_polled() {
    let r = rig().await;
    for header in ["ONE", "TWO"] {
        r.connected(
            "sms_line",
            header,
            StoredStatus::Verified,
            &netgsm_line(header),
            json!({}),
        )
        .await;
    }
    r.netgsm.push_inbox(Err(ConnectorError::throttle(None)));
    r.netgsm.push_inbox(Ok(vec![mo("9", "selam")]));
    let out = jobs::run_netgsm_inbox_poll(&r.w.deps, NOW).await;
    assert_eq!(out, report(2, 1, 0, 1));
    assert_eq!(r.events().len(), 1);
}

#[tokio::test]
async fn dlr_poll_asks_only_when_jobs_wait_and_records_what_it_hears() {
    let r = rig().await;
    let creds = netgsm_line("ACME");
    r.connected(
        "sms_line",
        "ACME",
        StoredStatus::Verified,
        &creds,
        json!({}),
    )
    .await;
    // Nothing waits: no provider is asked.
    assert_eq!(
        jobs::run_netgsm_dlr_poll(&r.w.deps, NOW).await,
        report(0, 0, 0, 0)
    );
    assert!(r.netgsm.calls().is_empty());

    r.w.uow.add_outbound_job(r.ws(), "J1");
    r.w.uow.add_outbound_job(r.ws(), "J2");
    let delivered = DeliveryStatus {
        job_id: "J1".into(),
        recipient: "905550000000".into(),
        status: DeliveryState::Delivered,
        at: Some(NOW - Duration::minutes(1)),
        raw_code: "1".into(),
    };
    let waiting = DeliveryStatus {
        job_id: "J2".into(),
        recipient: "905550000001".into(),
        status: DeliveryState::Pending,
        at: None,
        raw_code: "0".into(),
    };
    r.netgsm
        .push_report(Ok(vec![delivered.clone(), waiting.clone()]));
    let out = jobs::run_netgsm_dlr_poll(&r.w.deps, NOW).await;
    assert_eq!(out, report(2, 2, 0, 0));
    assert_eq!(
        r.netgsm.calls(),
        [ConnectorCall::Report {
            credential: creds.clone(),
            job_ids: vec!["J1".into(), "J2".into()],
        }]
    );
    let jobs_now = r.w.uow.snapshot().outbound_jobs;
    assert_eq!(jobs_now[0].status, Some(delivered));
    assert_eq!(jobs_now[1].status, Some(waiting));

    // J1 is final; only J2 is asked about next time.
    r.netgsm.push_report(Ok(vec![]));
    let out = jobs::run_netgsm_dlr_poll(&r.w.deps, NOW + Duration::minutes(1)).await;
    assert_eq!(out, report(1, 0, 0, 0));
    assert_eq!(
        r.netgsm.calls()[1],
        ConnectorCall::Report {
            credential: creds,
            job_ids: vec!["J2".into()],
        }
    );
}

// ---------------------------------------------------------------------------------------------
// Purges
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn purges_remove_only_what_is_past_its_time() {
    let r = rig().await;
    let ws = r.ws();
    let line = r
        .connected(
            "sms_line",
            "ACME",
            StoredStatus::Verified,
            &netgsm_line("ACME"),
            json!({}),
        )
        .await;
    let mut t = r.w.uow.tenant(ws).await.unwrap();
    // Raw bodies: one 31 days old, one 29.
    for (id, days) in [("old", 31), ("young", 29)] {
        t.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id: InboundEventId::new_v7(),
                    workspace_id: ws,
                    provider: Provider::Netgsm,
                    capability_id: Some(line),
                    external_id: format!("netgsm-mo:{id}"),
                    kind: EventKind::Message,
                    payload: json!({}),
                    received_at: NOW - Duration::days(days),
                    processed_at: None,
                },
                Some(b"raw".to_vec()),
            )
            .await
            .unwrap();
    }
    // Pending OAuth flows: one expired, one still open.
    for (state, expires_at) in [
        ("expired", NOW - Duration::minutes(1)),
        ("open", NOW + Duration::minutes(5)),
    ] {
        t.oauth_pending()
            .insert(OAuthPendingRow {
                id: OAuthPendingId::new_v7(),
                workspace_id: ws,
                provider: Provider::Meta,
                kind_key: "facebook_page".into(),
                state_hash: format!("hash-{state}"),
                started_by: r.w.owner,
                capability_id: None,
                pkce_verifier_sealed: None,
                assets_sealed: None,
                assets_public: json!([]),
                expires_at,
                created_at: NOW - Duration::minutes(30),
            })
            .await
            .unwrap();
    }
    // Probe runs: 31 days old and 29.
    for days in [31, 29] {
        t.probe_runs()
            .append(ProbeRun {
                id: ProbeRunId::new_v7(),
                workspace_id: ws,
                capability_id: line,
                at: NOW - Duration::days(days),
                ok: true,
                error_kind: None,
                latency_ms: 10,
                facts: json!({}),
            })
            .await
            .unwrap();
    }
    t.commit().await.unwrap();

    assert_eq!(
        jobs::run_purge_raw_bodies(&r.w.deps, NOW).await,
        report(1, 1, 0, 0)
    );
    assert_eq!(
        jobs::run_purge_oauth_pending(&r.w.deps, NOW).await,
        report(1, 1, 0, 0)
    );
    assert_eq!(
        jobs::run_purge_probe_runs(&r.w.deps, NOW).await,
        report(1, 1, 0, 0)
    );

    let state = r.w.uow.snapshot();
    let raw: Vec<(String, bool)> = state
        .inbound_events
        .iter()
        .map(|s| (s.event.external_id.clone(), s.raw.is_some()))
        .collect();
    assert_eq!(
        raw,
        [
            ("netgsm-mo:old".to_owned(), false),
            ("netgsm-mo:young".to_owned(), true)
        ]
    );
    let flows: Vec<&str> = state
        .oauth_pending
        .iter()
        .map(|p| p.state_hash.as_str())
        .collect();
    assert_eq!(flows, ["hash-open"]);
    let runs: Vec<OffsetDateTime> = state.probe_runs.iter().map(|r| r.at).collect();
    assert_eq!(runs, [NOW - Duration::days(29)]);
}
