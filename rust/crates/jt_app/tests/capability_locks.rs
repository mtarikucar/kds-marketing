//! Every capability mutation reads the capability through `CapabilityRepo::lock` before it reads
//! it any other way and before any write, in the bundle that writes, so concurrent mutations of
//! one capability take turns instead of writing back what the other changed. Likewise every
//! change of a budget item, and every link to it or spend from it, reads the item through
//! `BudgetRepo::lock_item` first (after the capability, when it locks one too).
//!
//! The fakes sit behind a [`Spy`] that records, in order, every capability, group and budget repo
//! call each tenant bundle makes.

mod support;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    AgentConnectionRepo, ApiKeyRepo, BudgetRepo, CapabilityFilter, CapabilityGroupRepo,
    CapabilityRepo, ConsultationRepo, HypothesisRepo, InboundEventRepo, LedgerRepo, MembershipRepo,
    OAuthPendingRepo, OutboundJobRepo, PlatformRepos, ProbeRunRepo, RoleRepo, StrategyRepo,
    TenantRepos, UnitOfWork, UserRepos, WorkspacePolicyRepo, WorkspaceRepo,
};
use jt_app::usecases::Deps;
use jt_app::usecases::budget::{self, BudgetItemInput, UpdateBudgetItem};
use jt_app::usecases::capabilities::{self, UpdateCapability};
use jt_app::usecases::connector::{self, CredentialInput, SetCredentials};
use jt_app::usecases::groups;
use jt_capability::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, Capability, CapabilityGroup,
    CapabilityGroupId, CapabilityId, Evidence, Period, Policy, StoredStatus, Unit,
};
use jt_connector::{ProbeResult, Provider};
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{InMemoryUow, ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use support::*;
use time::OffsetDateTime;

/// Calls that write a capability, a group membership or a budget link.
const WRITES: &[&str] = &[
    "capabilities.insert",
    "capabilities.update",
    "capabilities.set_sealed",
    "capabilities.set_status",
    "groups.insert",
    "groups.rename",
    "groups.delete",
    "groups.add_member",
    "groups.remove_member",
    "budget.insert_item",
    "budget.update_item",
    "budget.link",
    "budget.unlink",
    "budget.unlink_item",
    "budget.append_spend",
];

#[derive(Clone)]
struct Spy {
    inner: InMemoryUow,
    log: Arc<Mutex<Vec<&'static str>>>,
}

impl Spy {
    fn push(&self, call: &'static str) {
        self.log.lock().unwrap().push(call);
    }

    fn take(&self) -> Vec<&'static str> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

#[async_trait]
impl UnitOfWork for Spy {
    async fn tenant(&self, ws: WorkspaceId) -> Result<Box<dyn TenantRepos>, AppError> {
        Ok(Box::new(SpyTenant {
            inner: self.inner.tenant(ws).await?,
            spy: self.clone(),
        }))
    }

    async fn platform(&self) -> Result<Box<dyn PlatformRepos>, AppError> {
        self.inner.platform().await
    }

    async fn user(&self) -> Result<Box<dyn UserRepos>, AppError> {
        self.inner.user().await
    }
}

struct SpyTenant {
    inner: Box<dyn TenantRepos>,
    spy: Spy,
}

#[async_trait]
impl TenantRepos for SpyTenant {
    fn consents(&mut self) -> &mut dyn jt_app::ports::inbox::ConsentRepo {
        self.inner.consents()
    }
    fn suppressions(&mut self) -> &mut dyn jt_app::ports::inbox::SuppressionRepo {
        self.inner.suppressions()
    }
    fn quotes(&mut self) -> &mut dyn jt_app::ports::inbox::QuoteRepo {
        self.inner.quotes()
    }
    fn appointments(&mut self) -> &mut dyn jt_app::ports::inbox::AppointmentRepo {
        self.inner.appointments()
    }
    fn commissions(&mut self) -> &mut dyn jt_app::ports::inbox::CommissionRepo {
        self.inner.commissions()
    }
    fn erasure(&mut self) -> &mut dyn jt_app::ports::inbox::ErasureRepo {
        self.inner.erasure()
    }
    fn mail_cursors(&mut self) -> &mut dyn jt_app::ports::inbox::MailCursorRepo {
        self.inner.mail_cursors()
    }
    fn attribution(&mut self) -> &mut dyn jt_app::ports::inbox::AttributionRepo {
        self.inner.attribution()
    }

    fn people(&mut self) -> &mut dyn jt_app::ports::inbox::PersonRepo {
        self.inner.people()
    }
    fn identities(&mut self) -> &mut dyn jt_app::ports::inbox::IdentityRepo {
        self.inner.identities()
    }
    fn conversations(&mut self) -> &mut dyn jt_app::ports::inbox::ConversationRepo {
        self.inner.conversations()
    }
    fn messages(&mut self) -> &mut dyn jt_app::ports::inbox::MessageRepo {
        self.inner.messages()
    }
    fn journeys(&mut self) -> &mut dyn jt_app::ports::inbox::JourneyRepo {
        self.inner.journeys()
    }
    fn tasks(&mut self) -> &mut dyn jt_app::ports::inbox::TaskRepo {
        self.inner.tasks()
    }
    fn notes(&mut self) -> &mut dyn jt_app::ports::inbox::NoteRepo {
        self.inner.notes()
    }
    fn merges(&mut self) -> &mut dyn jt_app::ports::inbox::MergeRepo {
        self.inner.merges()
    }
    fn lost_reasons(&mut self) -> &mut dyn jt_app::ports::inbox::LostReasonRepo {
        self.inner.lost_reasons()
    }
    fn consumption(&mut self) -> &mut dyn jt_app::ports::inbox::ConsumptionRepo {
        self.inner.consumption()
    }
    fn request_keys(&mut self) -> &mut dyn jt_app::ports::inbox::RequestKeyRepo {
        self.inner.request_keys()
    }
    fn outbox(&mut self) -> &mut dyn jt_app::ports::inbox::OutboxRepo {
        self.inner.outbox()
    }
    fn roles(&mut self) -> &mut dyn RoleRepo {
        self.inner.roles()
    }

    fn memberships(&mut self) -> &mut dyn MembershipRepo {
        self.inner.memberships()
    }

    fn api_keys(&mut self) -> &mut dyn ApiKeyRepo {
        self.inner.api_keys()
    }

    fn agent_connections(&mut self) -> &mut dyn AgentConnectionRepo {
        self.inner.agent_connections()
    }

    fn ledger(&mut self) -> &mut dyn LedgerRepo {
        self.inner.ledger()
    }

    fn workspace(&mut self) -> &mut dyn WorkspaceRepo {
        self.inner.workspace()
    }

    fn strategy(&mut self) -> &mut dyn StrategyRepo {
        self.inner.strategy()
    }

    fn hypotheses(&mut self) -> &mut dyn HypothesisRepo {
        self.inner.hypotheses()
    }

    fn consultation(&mut self) -> &mut dyn ConsultationRepo {
        self.inner.consultation()
    }

    fn capabilities(&mut self) -> &mut dyn CapabilityRepo {
        self
    }

    fn capability_groups(&mut self) -> &mut dyn CapabilityGroupRepo {
        self
    }

    fn budget(&mut self) -> &mut dyn BudgetRepo {
        self
    }

    fn workspace_policy(&mut self) -> &mut dyn WorkspacePolicyRepo {
        self.inner.workspace_policy()
    }

    fn inbound_events(&mut self) -> &mut dyn InboundEventRepo {
        self.inner.inbound_events()
    }

    fn oauth_pending(&mut self) -> &mut dyn OAuthPendingRepo {
        self.inner.oauth_pending()
    }

    fn probe_runs(&mut self) -> &mut dyn ProbeRunRepo {
        self.inner.probe_runs()
    }

    fn outbound_jobs(&mut self) -> &mut dyn OutboundJobRepo {
        self.inner.outbound_jobs()
    }

    async fn commit(self: Box<Self>) -> Result<(), AppError> {
        self.inner.commit().await
    }
}

#[async_trait]
impl CapabilityRepo for SpyTenant {
    async fn insert(&mut self, c: Capability, sealed: Option<Vec<u8>>) -> Result<(), AppError> {
        self.spy.push("capabilities.insert");
        self.inner.capabilities().insert(c, sealed).await
    }

    async fn find(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        self.spy.push("capabilities.find");
        self.inner.capabilities().find(id).await
    }

    async fn lock(&mut self, id: CapabilityId) -> Result<Option<Capability>, AppError> {
        self.spy.push("capabilities.lock");
        self.inner.capabilities().lock(id).await
    }

    async fn list(&mut self, filter: CapabilityFilter) -> Result<Vec<Capability>, AppError> {
        self.spy.push("capabilities.list");
        self.inner.capabilities().list(filter).await
    }

    async fn update(&mut self, c: Capability) -> Result<(), AppError> {
        self.spy.push("capabilities.update");
        self.inner.capabilities().update(c).await
    }

    async fn set_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.spy.push("capabilities.set_sealed");
        self.inner.capabilities().set_sealed(id, sealed, at).await
    }

    async fn read_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError> {
        self.spy.push("capabilities.read_sealed");
        self.inner.capabilities().read_sealed(id).await
    }

    async fn set_iys_sealed(
        &mut self,
        id: CapabilityId,
        sealed: Option<Vec<u8>>,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.spy.push("capabilities.set_iys_sealed");
        self.inner
            .capabilities()
            .set_iys_sealed(id, sealed, at)
            .await
    }

    async fn read_iys_sealed(&mut self, id: CapabilityId) -> Result<Option<Vec<u8>>, AppError> {
        self.spy.push("capabilities.read_iys_sealed");
        self.inner.capabilities().read_iys_sealed(id).await
    }

    async fn set_status(
        &mut self,
        id: CapabilityId,
        status: StoredStatus,
        at: OffsetDateTime,
    ) -> Result<(), AppError> {
        self.spy.push("capabilities.set_status");
        self.inner.capabilities().set_status(id, status, at).await
    }

    async fn kinds_in_use(&mut self) -> Result<BTreeSet<String>, AppError> {
        self.spy.push("capabilities.kinds_in_use");
        self.inner.capabilities().kinds_in_use().await
    }
}

#[async_trait]
impl CapabilityGroupRepo for SpyTenant {
    async fn insert(&mut self, group: CapabilityGroup, at: OffsetDateTime) -> Result<(), AppError> {
        self.spy.push("groups.insert");
        self.inner.capability_groups().insert(group, at).await
    }

    async fn list(&mut self) -> Result<Vec<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        self.spy.push("groups.list");
        self.inner.capability_groups().list().await
    }

    async fn find(
        &mut self,
        id: CapabilityGroupId,
    ) -> Result<Option<(CapabilityGroup, Vec<CapabilityId>)>, AppError> {
        self.spy.push("groups.find");
        self.inner.capability_groups().find(id).await
    }

    async fn rename(&mut self, id: CapabilityGroupId, name: &str) -> Result<(), AppError> {
        self.spy.push("groups.rename");
        self.inner.capability_groups().rename(id, name).await
    }

    async fn delete(&mut self, id: CapabilityGroupId) -> Result<(), AppError> {
        self.spy.push("groups.delete");
        self.inner.capability_groups().delete(id).await
    }

    async fn add_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        self.spy.push("groups.add_member");
        self.inner
            .capability_groups()
            .add_member(group, capability)
            .await
    }

    async fn remove_member(
        &mut self,
        group: CapabilityGroupId,
        capability: CapabilityId,
    ) -> Result<(), AppError> {
        self.spy.push("groups.remove_member");
        self.inner
            .capability_groups()
            .remove_member(group, capability)
            .await
    }
}

#[async_trait]
impl BudgetRepo for SpyTenant {
    async fn insert_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        self.spy.push("budget.insert_item");
        self.inner.budget().insert_item(item).await
    }

    async fn list_items(&mut self) -> Result<Vec<BudgetItem>, AppError> {
        self.spy.push("budget.list_items");
        self.inner.budget().list_items().await
    }

    async fn find_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        self.spy.push("budget.find_item");
        self.inner.budget().find_item(id).await
    }

    async fn lock_item(&mut self, id: BudgetItemId) -> Result<Option<BudgetItem>, AppError> {
        self.spy.push("budget.lock_item");
        self.inner.budget().lock_item(id).await
    }

    async fn update_item(&mut self, item: BudgetItem) -> Result<(), AppError> {
        self.spy.push("budget.update_item");
        self.inner.budget().update_item(item).await
    }

    async fn unlink_item(&mut self, item: BudgetItemId) -> Result<u64, AppError> {
        self.spy.push("budget.unlink_item");
        self.inner.budget().unlink_item(item).await
    }

    async fn link(&mut self, capability: CapabilityId, item: BudgetItemId) -> Result<(), AppError> {
        self.spy.push("budget.link");
        self.inner.budget().link(capability, item).await
    }

    async fn unlink(
        &mut self,
        capability: CapabilityId,
        item: BudgetItemId,
    ) -> Result<(), AppError> {
        self.spy.push("budget.unlink");
        self.inner.budget().unlink(capability, item).await
    }

    async fn append_spend(&mut self, spend: BudgetSpend) -> Result<BudgetSpendId, AppError> {
        self.spy.push("budget.append_spend");
        self.inner.budget().append_spend(spend).await
    }

    async fn spent_between(
        &mut self,
        item: BudgetItemId,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<i64, AppError> {
        self.spy.push("budget.spent_between");
        self.inner.budget().spent_between(item, from, to).await
    }

    async fn list_spend(
        &mut self,
        item: BudgetItemId,
        limit: u32,
        before: Option<(OffsetDateTime, BudgetSpendId)>,
    ) -> Result<Vec<BudgetSpend>, AppError> {
        self.spy.push("budget.list_spend");
        self.inner.budget().list_spend(item, limit, before).await
    }
}

/// Asserts that `calls`, one mutation's repo calls, read the capability through `lock` first:
/// the first capability call is `lock`, and it comes before every write (of which there is one).
fn locked_first(what: &str, calls: &[&str]) {
    let first_capability_call = calls.iter().find(|c| c.starts_with("capabilities."));
    assert_eq!(
        first_capability_call,
        Some(&"capabilities.lock"),
        "{what}: {calls:?}"
    );
    let lock = calls
        .iter()
        .position(|c| *c == "capabilities.lock")
        .unwrap();
    let first_write = calls
        .iter()
        .position(|c| WRITES.contains(c))
        .unwrap_or_else(|| panic!("{what} wrote nothing: {calls:?}"));
    assert!(lock < first_write, "{what}: {calls:?}");
}

/// Asserts that `calls`, one mutation's repo calls, read the budget item through `lock_item`
/// before reading it any other way and before every write, and after locking the capability when
/// it locks one too.
fn item_locked_first(what: &str, calls: &[&str]) {
    let item_reads = ["budget.find_item", "budget.lock_item"];
    let first_item_read = calls.iter().find(|c| item_reads.contains(c));
    assert_eq!(
        first_item_read,
        Some(&"budget.lock_item"),
        "{what}: {calls:?}"
    );
    let lock = calls.iter().position(|c| *c == "budget.lock_item").unwrap();
    let first_write = calls
        .iter()
        .position(|c| WRITES.contains(c))
        .unwrap_or_else(|| panic!("{what} wrote nothing: {calls:?}"));
    assert!(lock < first_write, "{what}: {calls:?}");
    if let Some(capability_lock) = calls.iter().position(|c| *c == "capabilities.lock") {
        assert!(capability_lock < lock, "{what}: {calls:?}");
    }
}

#[tokio::test]
async fn every_capability_mutation_locks_the_capability_before_writing() {
    let w = world().await;
    let spy = Spy {
        inner: w.uow.clone(),
        log: Arc::default(),
    };
    let deps = Deps {
        uow: Arc::new(spy.clone()),
        ..w.deps.clone()
    };
    let o = &w.owner_ctx;
    let phone = w.declare("phone", "Telefon").await.capability.id;
    let ads = w.declare("meta_ads", "Meta reklam").await.capability.id;
    let cash = budget::create_item(
        &w.deps,
        o,
        BudgetItemInput {
            name: "Kasa".into(),
            kind: BudgetKind::Cash,
            unit: Unit::Currency("TRY".into()),
            cap: 1_000,
            period: Period::Monthly,
        },
    )
    .await
    .unwrap()
    .item
    .id;
    let group = groups::create(&w.deps, o, "Saha".into(), None)
        .await
        .unwrap()
        .group
        .id;
    spy.take();

    let evidence = Evidence {
        text: "adb devices listed it".into(),
        refs: vec![],
    };
    capabilities::verify(&deps, o, phone, evidence)
        .await
        .unwrap();
    locked_first("verify", &spy.take());
    capabilities::set_policy(&deps, o, phone, Policy::default())
        .await
        .unwrap();
    locked_first("set_policy", &spy.take());
    capabilities::mark_unreachable(&deps, o, phone, "şarj bitti".into())
        .await
        .unwrap();
    locked_first("mark_unreachable", &spy.take());
    capabilities::update(
        &deps,
        o,
        phone,
        UpdateCapability {
            name: Some("Saha telefonu".into()),
            ..UpdateCapability::default()
        },
    )
    .await
    .unwrap();
    locked_first("update", &spy.take());
    capabilities::link_budget(&deps, o, ads, cash)
        .await
        .unwrap();
    locked_first("link_budget", &spy.take());
    capabilities::unlink_budget(&deps, o, ads, cash)
        .await
        .unwrap();
    locked_first("unlink_budget", &spy.take());
    groups::add_member(&deps, o, group, ads).await.unwrap();
    locked_first("groups::add_member", &spy.take());
    capabilities::retire(&deps, o, ads, true).await.unwrap();
    locked_first("retire", &spy.take());
}

#[tokio::test]
async fn budget_item_mutations_lock_the_item_before_writing() {
    let w = world().await;
    let spy = Spy {
        inner: w.uow.clone(),
        log: Arc::default(),
    };
    let deps = Deps {
        uow: Arc::new(spy.clone()),
        ..w.deps.clone()
    };
    let o = &w.owner_ctx;
    let ads = w.declare("meta_ads", "Meta reklam").await.capability.id;
    let cash = budget::create_item(
        &w.deps,
        o,
        BudgetItemInput {
            name: "Kasa".into(),
            kind: BudgetKind::Cash,
            unit: Unit::Currency("TRY".into()),
            cap: 1_000,
            period: Period::Monthly,
        },
    )
    .await
    .unwrap()
    .item
    .id;
    spy.take();

    capabilities::link_budget(&deps, o, ads, cash)
        .await
        .unwrap();
    item_locked_first("link_budget", &spy.take());
    budget::record_spend(&deps, o, cash, 10, None)
        .await
        .unwrap();
    item_locked_first("record_spend", &spy.take());
    let edit = UpdateBudgetItem {
        cap: Some(2_000),
        ..UpdateBudgetItem::default()
    };
    budget::update_item(&deps, o, cash, edit).await.unwrap();
    item_locked_first("update_item", &spy.take());
    budget::retire_item(&deps, o, cash, true).await.unwrap();
    let calls = spy.take();
    item_locked_first("retire_item", &calls);
    // The links go in the retiring bundle.
    assert!(calls.contains(&"budget.unlink_item"), "{calls:?}");
}

#[tokio::test]
async fn connector_mutations_lock_the_capability_before_writing() {
    let mut w = world().await;
    let netgsm = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(netgsm.clone()));
    let spy = Spy {
        inner: w.uow.clone(),
        log: Arc::default(),
    };
    let deps = Deps {
        uow: Arc::new(spy.clone()),
        ..w.deps.clone()
    };
    let o = &w.owner_ctx;
    let line = w.declare("sms_line", "Hat").await.capability.id;
    spy.take();

    let reached = || ProbeResult::success(5, json!({ "account_id": "KAHVE" }));
    netgsm.push_probe(reached());
    connector::set_credentials(
        &deps,
        o,
        SetCredentials {
            capability_id: Some(line),
            kind_key: None,
            name: None,
            external_id: None,
            credential: CredentialInput::NetgsmSms {
                usercode: "8508850000".into(),
                password: "pw".into(),
                msgheader: "KAHVE".into(),
            },
        },
    )
    .await
    .unwrap();
    locked_first("connector::set_credentials", &spy.take());
    netgsm.push_probe(reached());
    connector::probe(&deps, o, line).await.unwrap();
    locked_first("connector::probe", &spy.take());
}
