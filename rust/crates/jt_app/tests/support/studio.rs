#![allow(dead_code)]
use jt_app::{
    ctx::Ctx,
    ports::{UnitOfWork, studio::*},
    usecases::{
        Deps,
        studio::{chain::*, control::*},
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_ledger::Actor;
use jt_strategy::{
    ChannelChoice, ContentTypeShare, HypothesisCadence, LaneKind, StrategyVersionId, VersionStatus,
};
use jt_studio::BudgetMoveState;
use jt_tenancy::SystemRole;
use jt_testkit::{
    fakes::{FIXED_NOW, InMemoryUow, ScriptedConnector, ScriptedRegistry, deps},
    studio_contract::{Fixture, ready},
};
use serde_json::json;
use std::sync::Arc;

pub struct World {
    pub uow: InMemoryUow,
    pub d: Deps,
    pub f: Fixture,
    pub ctx: Ctx,
    pub current: StrategyVersionId,
    pub ads: Arc<ScriptedConnector>,
}
pub async fn world() -> World {
    let uow = InMemoryUow::new();
    let f = ready(&uow).await;
    let mut d = deps(Arc::new(uow.clone()));
    let ads = Arc::new(ScriptedConnector::new(Provider::Meta));
    d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(ads.clone())
            .with_connector(Arc::new(ScriptedConnector::new(Provider::X))),
    );
    let mut r = uow.tenant(f.ws).await.unwrap();
    let mut v = r
        .strategy()
        .find(f.slot.chain.born_version_id)
        .await
        .unwrap()
        .unwrap();
    let user = v.approved_by.unwrap();
    let mut h = r.hypotheses().list(v.id).await.unwrap().remove(0);
    r.strategy()
        .set_status(v.id, VersionStatus::Archived, FIXED_NOW, Some(user))
        .await
        .unwrap();
    v.id = StrategyVersionId::new_v7();
    v.number = 2;
    v.sections.channels = vec![
        ChannelChoice {
            channel: "x".into(),
            rationale: "test".into(),
            group_id: None,
        },
        ChannelChoice {
            channel: "meta_ads".into(),
            rationale: "test".into(),
            group_id: None,
        },
        ChannelChoice {
            channel: "tiktok".into(),
            rationale: "test".into(),
            group_id: None,
        },
    ];
    v.sections.paid_enabled = true;
    v.sections.budget_frame.lanes.push(jt_strategy::Lane {
        lane: LaneKind::Paid,
        period: jt_strategy::Period::Monthly,
        cap_minor: 100000,
        currency: "TRY".into(),
    });
    h.channel = "any".into();
    for lane in [LaneKind::Organic, LaneKind::Paid] {
        h.cadence.insert(
            lane,
            HypothesisCadence {
                slots_per_week: 7,
                exploration_bps: 0,
                content_types: vec![ContentTypeShare {
                    key: "text".into(),
                    min_bps: 0,
                    max_bps: 10000,
                }],
            },
        );
    }
    r.strategy().insert(v.clone()).await.unwrap();
    r.hypotheses().upsert(v.id, h).await.unwrap();
    let mut c = r
        .capabilities()
        .find(f.slot.capability_id)
        .await
        .unwrap()
        .unwrap();
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    c.connector_public =
        json!({"access":{"scopes":["tweet.read","tweet.write"],"expires_at":null}});
    r.capabilities().update(c.clone()).await.unwrap();
    let cred = Credential::OAuth {
        access_token: "test".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec!["tweet.read".into(), "tweet.write".into()],
    };
    let seal = d
        .seal
        .seal(f.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    r.capabilities()
        .set_sealed(c.id, Some(seal), FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    World {
        uow,
        d,
        f,
        ctx,
        current: v.id,
        ads,
    }
}
impl World {
    pub fn execution(&self) -> ExecutionInput {
        ExecutionInput {
            chain: self.f.slot.chain.clone(),
            capability_id: self.f.slot.capability_id,
            target: ApprovalTarget::Slot(self.f.slot.id),
            expected_revision: 1,
        }
    }
    pub async fn permit(&self) -> Result<ExecutionPermit, jt_app::error::AppError> {
        let mut r = self.uow.tenant(self.f.ws).await?;
        authorize_execution_at(r.as_mut(), self.execution(), FIXED_NOW).await
    }
    pub async fn brake(
        &self,
        engaged: bool,
        lane: Option<LaneKind>,
        revision: u64,
    ) -> StudioControl {
        brake(
            &self.d,
            &self.ctx,
            BrakeInput {
                engaged,
                lane,
                expected_revision: revision,
            },
        )
        .await
        .unwrap()
    }
    pub async fn policy(&self, required: bool, revision: u64) -> StudioControl {
        policy_set(
            &self.d,
            &self.ctx,
            StudioPolicyInput {
                lane: LaneKind::Organic,
                requires_human_approval: required,
                expected_revision: revision,
            },
        )
        .await
        .unwrap()
    }
    pub async fn approve(&self) {
        approve(
            &self.d,
            &self.ctx,
            ApprovalInput {
                target: ApprovalTarget::Slot(self.f.slot.id),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    }
    pub async fn paid(&self) -> (AdSetBinding, BudgetMove) {
        let mut r = self.uow.tenant(self.f.ws).await.unwrap();
        let mut c = Capability::new(
            CapabilityId::new_v7(),
            self.f.ws,
            NewCapability {
                kind_key: "meta_ads".into(),
                name: "ads".into(),
                external_id: Some("act_1".into()),
                connector_public: json!({"access":{"scopes":["ads_read","ads_management"]}}),
                ..Default::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        c.status = StoredStatus::Verified;
        c.last_verified_at = Some(FIXED_NOW);
        let cred = Credential::OAuth {
            access_token: "test".into(),
            refresh_token: None,
            expires_at: None,
            scopes: vec!["ads_read".into(), "ads_management".into()],
        };
        let sealed = self
            .d
            .seal
            .seal(self.f.ws, &serde_json::to_vec(&cred).unwrap())
            .unwrap();
        r.capabilities()
            .insert(c.clone(), Some(sealed))
            .await
            .unwrap();
        let arm = Arm::new(
            ArmId::new_v7(),
            self.f.ws,
            ArmKey {
                hypothesis_id: self.f.slot.chain.hypothesis_id,
                content_type: "text".into(),
                channel: "meta_ads".into(),
                lane: LaneKind::Paid,
            },
        )
        .unwrap();
        r.studio().insert_arm(arm.clone()).await.unwrap();
        let chain = Chain {
            arm_id: arm.id,
            ..self.f.slot.chain.clone()
        };
        let b = AdSetBinding {
            verified_at: Some(FIXED_NOW),
            verification_evidence: None,
            id: AdSetBindingId::new_v7(),
            chain: chain.clone(),
            capability_id: c.id,
            account_id: "act_1".into(),
            adset_id: "set_1".into(),
            campaign_id: Some("campaign".into()),
        };
        r.studio().bind_adset(b.clone(), "binding").await.unwrap();
        let m = BudgetMove {
            binding_verified_at: None,
            binding_verification_evidence: None,
            id: BudgetMoveId::new_v7(),
            chain,
            binding_id: b.id,
            revision: 1,
            daily_budget_minor: 10,
            currency: "TRY".into(),
            state: BudgetMoveState::Queued,
            approval: None,
            reservation_id: None,
            executed_version_id: None,
        };
        r.studio()
            .save_budget_move(m.clone(), "move")
            .await
            .unwrap();
        r.commit().await.unwrap();
        let input=serde_json::from_value(json!({"name":"ad cap","kind":"ad_budget","unit":{"kind":"currency","value":"TRY"},"cap":100000,"period":"monthly","unit_cost_minor":1})).unwrap();
        let item = jt_app::usecases::budget::create_item(&self.d, &self.ctx, input)
            .await
            .unwrap();
        let mut r = self.uow.tenant(self.f.ws).await.unwrap();
        r.budget().link(c.id, item.item.id).await.unwrap();
        r.commit().await.unwrap();
        (b, m)
    }
    pub fn provider_status(&self, status: &str, daily: i64) {
        self.ads
            .push_account_context(Ok(jt_app::ports::connectors::AdAccountContext {
                account_id: "act_1".into(),
                currency: "TRY".into(),
                minor_unit_exponent: 2,
                timezone: "Europe/Istanbul".into(),
            }));
        self.ads
            .push_list_adsets(Ok(vec![jt_app::ports::connectors::AdSet {
                id: "set_1".into(),
                name: "external".into(),
                status: status.into(),
                campaign_id: Some("campaign".into()),
                daily_budget_minor: Some(daily),
                lifetime_budget_minor: None,
            }]));
    }
    pub async fn archive(&self) {
        jt_app::usecases::strategy::archive(
            &self.d,
            &self.ctx,
            jt_app::usecases::strategy::ArchiveInput {
                version_id: self.current,
                confirm: true,
            },
        )
        .await
        .unwrap();
    }
    pub async fn publish_evidence(&self) -> PublicationId {
        let mut r = self.uow.tenant(self.f.ws).await.unwrap();
        let a = r
            .studio()
            .claim_publication(FIXED_NOW)
            .await
            .unwrap()
            .unwrap();
        r.studio()
            .finish_publication(
                a.id(),
                PublishOutcome::Succeeded(jt_app::ports::connectors::PublishReceipt {
                    external_id: "post_1".into(),
                    url: None,
                }),
                FIXED_NOW,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
        self.uow.snapshot().studio.publications[0].id
    }
}
