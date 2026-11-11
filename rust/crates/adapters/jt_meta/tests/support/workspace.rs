//! A workspace as a person sets one up, for the flow tests: the application's own use cases (in
//! memory) on the real Meta adapter, against the Graph mock. Everything here goes through the
//! use cases a transport calls; only a connection's credential is put in place by hand, as a
//! finished connect leaves it.

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::ports::connectors::{
    AdBudgetWriter, AdCampaignWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports,
    InsightsReader, LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, OAuthProvider,
    Publisher, SmsSender, Telephony,
};
use jt_app::usecases::api_keys::{self, CreateKey};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::usecases::capabilities::{self, DeclareInput};
use jt_app::usecases::{Deps, modules, strategy};
use jt_capability::{CapabilityId, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_meta::MetaConnector;
use jt_tenancy::{AgentConnectionId, WorkspaceId};
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow, deps, files::MemoryFiles};
use jt_testkit::flows::activate_workspace;
use serde_json::{Value, json};

use super::{Mock, TestApps, bases, egress};

/// The token every connection of a flow test holds.
pub const FLOW_TOKEN: &str = "flow-test-token";

/// The real adapter for what ad campaigns and posts need; nothing else.
struct FlowRegistry(Arc<MetaConnector>);

impl ConnectorRegistry for FlowRegistry {
    fn connector(&self, provider: Provider) -> Option<Arc<dyn Connector>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn Connector>)
    }
    fn oauth(&self, _: Provider) -> Option<Arc<dyn OAuthProvider>> {
        None
    }
    fn mail_sender(&self, _: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }
    fn mailbox_poller(&self, _: Provider) -> Option<Arc<dyn MailboxPoller>> {
        None
    }
    fn sms(&self, _: Provider) -> Option<Arc<dyn SmsSender>> {
        None
    }
    fn publisher(&self, provider: Provider) -> Option<Arc<dyn Publisher>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn Publisher>)
    }
    fn insights(&self, _: Provider) -> Option<Arc<dyn InsightsReader>> {
        None
    }
    fn messaging(&self, _: Provider) -> Option<Arc<dyn MessagingSender>> {
        None
    }
    fn ads(&self, provider: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn AdBudgetWriter>)
    }
    fn ad_campaigns(&self, provider: Provider) -> Option<Arc<dyn AdCampaignWriter>> {
        (provider == Provider::Meta).then(|| self.0.clone() as Arc<dyn AdCampaignWriter>)
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

/// The workspace of a flow test.
pub struct Workspace {
    pub mock: Mock,
    pub uow: Arc<InMemoryUow>,
    pub deps: Deps,
    pub id: WorkspaceId,
    pub owner: Ctx,
    /// The one hypothesis of the approved strategy, as its JSON id.
    pub hypothesis: Value,
}

/// Registers an owner, activates the workspace, approves a strategy written the way a
/// consultation writes one (sections and one hypothesis, with `extra` sections on top; no
/// cadence is named on the hypothesis) and installs `modules`.
pub async fn workspace(extra: &[(&str, Value)], installed: &[&str]) -> Workspace {
    let mock = Mock::start().await;
    let apps = Arc::new(TestApps::default());
    let meta = Arc::new(MetaConnector::new(
        egress(&mock),
        bases(&mock),
        apps.clone(),
    ));
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = deps(uow.clone());
    deps.apps = apps;
    deps.connectors = Arc::new(FlowRegistry(meta));
    deps.files = Arc::new(MemoryFiles::default());

    let session = auth::register(
        &deps,
        RegisterInput {
            email: "owner@flow.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Flow".into(),
        },
    )
    .await
    .unwrap();
    let id = session.me.current_workspace.unwrap();
    activate_workspace(&deps, id).await;
    let principal = auth::resolve_session(&deps, &session.token).await.unwrap();
    let owner = auth::ctx_for(&principal, id, FIXED_NOW).unwrap();

    strategy::start_consultation(&deps, &owner).await.unwrap();
    let mut sections = vec![
        ("identity", json!({"product":"Handmade ceramic mugs"})),
        (
            "audience",
            json!([{"key":"all","name":"Ceramics lovers","description":"Adults in Istanbul"}]),
        ),
        (
            "channels",
            json!([{"channel":"any","rationale":"connected accounts"}]),
        ),
        ("cadence", json!({"per_week":3})),
    ];
    sections.extend(extra.iter().cloned());
    for (key, value) in sections {
        strategy::write_section(&deps, &owner, key.into(), value)
            .await
            .unwrap_or_else(|e| panic!("{key}: {e:?}"));
    }
    strategy::set_hypotheses(
        &deps,
        &owner,
        json!([{"title":"The making draws people in","segment_key":"all",
            "angle":"Show clay becoming a mug","channel":"any","metric":"engagement",
            "prior_confidence":0.6}]),
    )
    .await
    .unwrap();
    let submitted = strategy::submit(&deps, &owner).await.unwrap();
    let approved = strategy::approve(
        &deps,
        &owner,
        strategy::ApproveInput {
            version_id: submitted.id,
            submitted_at: submitted.submitted_at.unwrap(),
        },
    )
    .await
    .unwrap();
    let hypothesis = serde_json::to_value(&approved.hypotheses[0]).unwrap()["id"].clone();
    for module in installed {
        modules::install(&deps, &owner, module, Default::default())
            .await
            .unwrap_or_else(|e| panic!("{module}: {e:?}"));
    }
    Workspace {
        mock,
        uow,
        deps,
        id,
        owner,
        hypothesis,
    }
}

impl Workspace {
    /// A connection as a finished connect leaves it: verified, with `credential` sealed and the
    /// scopes it was granted.
    pub async fn connected(
        &self,
        kind: &str,
        name: &str,
        external: &str,
        credential: Credential,
        scopes: &[&str],
    ) -> CapabilityId {
        let declared = capabilities::declare(
            &self.deps,
            &self.owner,
            DeclareInput {
                kind_key: kind.into(),
                name: name.into(),
                external_id: Some(external.into()),
                ..DeclareInput::default()
            },
        )
        .await
        .unwrap();
        let id = declared.capability.id;
        let sealed = self
            .deps
            .seal
            .seal(self.id, &serde_json::to_vec(&credential).unwrap())
            .unwrap();
        let mut r = self.deps.uow.tenant(self.id).await.unwrap();
        let mut c = r.capabilities().find(id).await.unwrap().unwrap();
        c.status = StoredStatus::Verified;
        c.last_verified_at = Some(FIXED_NOW);
        c.connector_public = json!({"access":{"scopes":scopes,"expires_at":null}});
        r.capabilities().update(c).await.unwrap();
        r.capabilities()
            .set_sealed(id, Some(sealed), FIXED_NOW)
            .await
            .unwrap();
        r.commit().await.unwrap();
        id
    }

    /// A user token, as an ad account's connect leaves one.
    pub fn user_token(scopes: &[&str]) -> Credential {
        Credential::OAuth {
            access_token: FLOW_TOKEN.into(),
            refresh_token: None,
            expires_at: None,
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    /// An agent's context: a key of the owner's with `scopes`, resolved as the MCP layer does.
    pub async fn agent(&self, scopes: &[&str]) -> Ctx {
        let key = api_keys::create(
            &self.deps,
            &self.owner,
            CreateKey {
                name: "flow agent".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            },
        )
        .await
        .unwrap();
        api_keys::ctx_for_agent(
            &api_keys::authenticate(&self.deps, &key.plaintext)
                .await
                .unwrap(),
            AgentConnectionId::new_v7(),
            FIXED_NOW,
        )
    }

    /// A shareable image of a confirmed event, its bytes in the file store: its JSON id.
    pub async fn image(&self) -> Value {
        serde_json::to_value(
            jt_testkit::studio_contract::stored_material(
                self.uow.as_ref(),
                self.deps.files.as_ref(),
                self.id,
            )
            .await
            .id,
        )
        .unwrap()
    }
}
