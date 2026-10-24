//! Intake-generated attribution contracts shared by PostgreSQL and the transactional fake.
use crate::fakes::{FIXED_NOW, ScriptedConnector, ScriptedRegistry, deps};
use jt_app::{
    ctx::Ctx,
    ports::{
        UnitOfWork,
        connectors::{AdAccountContext, AdSet, LeadGenRecord},
        inbox::AttributionReader,
    },
    usecases::{
        Deps,
        inbox::{consumer, erasure},
        studio::attribution::{AttributionQuery, attribution_for_ad},
    },
};
use jt_capability::{
    Capability, CapabilityGroup, CapabilityGroupId, CapabilityId, NewCapability, StoredStatus,
};
use jt_connector::{Credential, EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::{JourneyId, PersonId};
use jt_ledger::Actor;
use jt_strategy::{
    ChannelChoice, Hypothesis, HypothesisId, HypothesisState, LaneKind, Sections, StrategyVersion,
    StrategyVersionId, VersionStatus,
};
use jt_studio::{AdSetBinding, AdSetBindingId, Arm, ArmId, ArmKey, Chain};
use jt_tenancy::{SystemRole, WorkspaceId};
use serde_json::json;
use std::sync::Arc;
use time::Duration;

struct World {
    d: Deps,
    ctx: Ctx,
    other: WorkspaceId,
    ads: Arc<ScriptedConnector>,
    binding: AdSetBinding,
    page: CapabilityId,
    group: CapabilityGroupId,
    journey: JourneyId,
    person: PersonId,
}
impl World {
    fn query(&self) -> AttributionQuery {
        AttributionQuery {
            binding_id: self.binding.id,
            ad_id: "ad".into(),
            from: FIXED_NOW - Duration::days(1),
            to: FIXED_NOW,
        }
    }
    fn proof(&self, resolved: Option<&str>) {
        self.ads.push_account_context(Ok(AdAccountContext {
            account_id: "act_1".into(),
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
        }));
        self.ads.push_list_adsets(Ok(vec![AdSet {
            id: "set_1".into(),
            name: "external".into(),
            status: "PAUSED".into(),
            campaign_id: Some("campaign".into()),
            daily_budget_minor: Some(10),
            lifetime_budget_minor: None,
        }]));
        self.ads.push_resolve_adset(Ok(resolved.map(str::to_owned)));
    }
}
async fn setup(uow: Arc<dyn UnitOfWork>) -> World {
    let f = crate::inbox_contract::Fixture::new(uow.clone()).await;
    let mut d = deps(uow.clone());
    let ads = Arc::new(ScriptedConnector::new(Provider::Meta));
    d.connectors = Arc::new(ScriptedRegistry::new().with_connector(ads.clone()));
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: f.user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let group = CapabilityGroupId::new_v7();
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capability_groups()
        .insert(
            CapabilityGroup::new(group, f.ws, "brand".into(), None).unwrap(),
            FIXED_NOW,
        )
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (kind, external, credential) in [
        (
            "facebook_page",
            "page",
            Credential::PageToken {
                page_id: "page".into(),
                token: "page-secret".into(),
            },
        ),
        (
            "meta_ads",
            "act_1",
            Credential::OAuth {
                access_token: "ads-secret".into(),
                refresh_token: None,
                expires_at: None,
                scopes: vec!["ads_read".into()],
            },
        ),
    ] {
        let mut c = Capability::new(
            CapabilityId::new_v7(),
            f.ws,
            NewCapability {
                kind_key: kind.into(),
                name: kind.into(),
                external_id: Some(external.into()),
                connector_public: json!({"access":{"scopes":["ads_read"]}}),
                ..Default::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        c.status = StoredStatus::Verified;
        c.last_verified_at = Some(FIXED_NOW);
        let sealed = d
            .seal
            .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
            .unwrap();
        r.capabilities()
            .insert(c.clone(), Some(sealed))
            .await
            .unwrap();
        r.capability_groups().add_member(group, c.id).await.unwrap();
        ids.push(c.id);
    }
    let version = StrategyVersion {
        id: StrategyVersionId::new_v7(),
        workspace_id: f.ws,
        number: 1,
        status: VersionStatus::Approved,
        sections: Sections {
            paid_enabled: true,
            channels: vec![ChannelChoice {
                channel: "meta_ads".into(),
                rationale: "test".into(),
                group_id: Some(group.0),
            }],
            ..Default::default()
        },
        created_at: FIXED_NOW,
        created_by: ctx.actor.clone(),
        submitted_at: None,
        approved_at: Some(FIXED_NOW),
        approved_by: Some(f.user),
        archived_at: None,
    };
    r.strategy().insert(version.clone()).await.unwrap();
    let h = Hypothesis {
        id: HypothesisId::new_v7(),
        title: "test".into(),
        segment_key: "all".into(),
        angle: "test".into(),
        channel: "meta_ads".into(),
        metric: "click".into(),
        prior_confidence: 0.5,
        derived_confidence: None,
        cadence: Default::default(),
        state: HypothesisState::Kept,
    };
    r.hypotheses().upsert(version.id, h.clone()).await.unwrap();
    let arm = Arm::new(
        ArmId::new_v7(),
        f.ws,
        ArmKey {
            hypothesis_id: h.id,
            content_type: "text".into(),
            channel: "meta_ads".into(),
            lane: LaneKind::Paid,
        },
    )
    .unwrap();
    r.studio().insert_arm(arm.clone()).await.unwrap();
    let binding = AdSetBinding {
        id: AdSetBindingId::new_v7(),
        chain: Chain {
            workspace_id: f.ws,
            born_version_id: version.id,
            hypothesis_id: h.id,
            arm_id: arm.id,
        },
        capability_id: ids[1],
        account_id: "act_1".into(),
        adset_id: "set_1".into(),
        campaign_id: Some("campaign".into()),
        verified_at: Some(FIXED_NOW),
        verification_evidence: None,
    };
    r.studio()
        .bind_adset(binding.clone(), "binding")
        .await
        .unwrap();
    r.inbound_events().insert_if_new(InboundEvent { id: InboundEventId::new_v7(), workspace_id: f.ws, capability_id: Some(ids[0]), provider: Provider::Meta, external_id: "leadgen:lead".into(), kind: EventKind::LeadGen, payload: json!({"leadgen":{"page_id":"page","leadgen_id":"lead","created_time":1790000040}}), received_at: FIXED_NOW, processed_at: None }, Some(b"private raw form".to_vec())).await.unwrap();
    r.commit().await.unwrap();
    ads.push_leadgen(Ok(LeadGenRecord {
        leadgen_id: "lead".into(),
        form_id: Some("form".into()),
        ad_id: Some("ad".into()),
        campaign_id: Some("campaign".into()),
        campaign_name: Some("private campaign".into()),
        created_time: Some(FIXED_NOW - Duration::days(1)),
        fields: [
            ("email".into(), vec!["private@example.test".into()]),
            ("full_name".into(), vec!["Private Lead".into()]),
        ]
        .into(),
    }));
    assert_eq!(
        consumer::consume_workspace(&d, f.ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let row = d
        .attribution()
        .by_ad(f.ws, "ad", FIXED_NOW - Duration::days(1), FIXED_NOW)
        .await
        .unwrap()
        .remove(0);
    let mut r = uow.tenant(f.ws).await.unwrap();
    let j = r.journeys().get(row.journey_id).await.unwrap().unwrap();
    World {
        d,
        ctx,
        other: f.other,
        ads,
        binding,
        page: ids[0],
        group,
        journey: j.id,
        person: j.person_id,
    }
}

pub async fn attribution_reader_consumes_m2b_rows_after_raw_retention(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.inbound_events()
            .purge_raw_before(FIXED_NOW + Duration::days(31))
            .await
            .unwrap(),
        1
    );
    r.commit().await.unwrap();
    w.proof(Some("set_1"));
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].journey_id, w.journey);
    assert_eq!(rows[0].acquired_at, FIXED_NOW - Duration::days(1));
    assert_eq!(rows[0].chain, Some(w.binding.chain));
}
pub async fn attribution_by_ad_window_and_by_journey_are_tenant_scoped(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let reader = w.d.attribution();
    let q = w.query();
    assert_eq!(
        reader
            .by_ad(w.ctx.workspace_id, "ad", q.from, q.to)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        reader
            .by_ad(w.ctx.workspace_id, "ad", q.from - Duration::days(1), q.from)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        reader
            .by_ad(
                w.ctx.workspace_id,
                "ad",
                q.from + Duration::seconds(1),
                q.to
            )
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        reader
            .by_ad(w.other, "ad", q.from, q.to)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        reader
            .by_journey(w.other, w.journey)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        reader
            .by_journey(w.ctx.workspace_id, w.journey)
            .await
            .unwrap()
            .unwrap()
            .acquired_at,
        q.from
    );
    let mut ctx = w.ctx.clone();
    ctx.workspace_id = w.other;
    assert!(attribution_for_ad(&w.d, &ctx, q).await.is_err());
}
pub async fn page_ads_mapping_requires_selected_group(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.capability_groups()
        .remove_member(w.group, w.page)
        .await
        .unwrap();
    let other = CapabilityGroupId::new_v7();
    r.capability_groups()
        .insert(
            CapabilityGroup::new(other, w.ctx.workspace_id, "unselected".into(), None).unwrap(),
            FIXED_NOW,
        )
        .await
        .unwrap();
    for id in [w.page, w.binding.capability_id] {
        r.capability_groups().add_member(other, id).await.unwrap();
    }
    r.commit().await.unwrap();
    w.proof(Some("set_1"));
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].chain.is_none());
}
pub async fn ad_to_set_to_arm_join_is_proven(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    w.proof(Some("set_1"));
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert_eq!(rows[0].binding_id, Some(w.binding.id));
    assert_eq!(rows[0].chain, Some(w.binding.chain.clone()));
    w.proof(Some("foreign_set"));
    assert!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0]
            .chain
            .is_none()
    );
    w.ads.push_account_context(Ok(AdAccountContext {
        account_id: "act_foreign".into(),
        currency: "TRY".into(),
        minor_unit_exponent: 2,
        timezone: "UTC".into(),
    }));
    assert!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0]
            .chain
            .is_none()
    );
}
pub async fn shared_campaign_does_not_attribute_two_arms(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let mut second = w.binding.clone();
    second.id = AdSetBindingId::new_v7();
    second.adset_id = "set_2".into();
    let arm = Arm::new(
        ArmId::new_v7(),
        w.ctx.workspace_id,
        ArmKey {
            hypothesis_id: second.chain.hypothesis_id,
            content_type: "video".into(),
            channel: "meta_ads".into(),
            lane: LaneKind::Paid,
        },
    )
    .unwrap();
    second.chain.arm_id = arm.id;
    r.studio().insert_arm(arm).await.unwrap();
    r.studio()
        .bind_adset(second.clone(), "second")
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.proof(Some("set_1"));
    assert_eq!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0].chain,
        Some(w.binding.chain.clone())
    );
    w.proof(Some("set_1"));
    let mut q = w.query();
    q.binding_id = second.id;
    assert!(
        attribution_for_ad(&w.d, &w.ctx, q).await.unwrap()[0]
            .chain
            .is_none()
    );
}
pub async fn missing_mapping_leaves_journey_unattributed(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    w.proof(None);
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].journey_id, w.journey);
    assert!(rows[0].chain.is_none() && rows[0].binding_id.is_none());
    assert!(
        w.d.attribution()
            .by_journey(w.ctx.workspace_id, w.journey)
            .await
            .unwrap()
            .is_some()
    );
}
pub async fn studio_attribution_never_fetches_or_ingests_leads(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let before = w.ads.calls().len();
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let events = r.journeys().events(w.journey, 100).await.unwrap();
    let tasks = r.tasks().list(w.journey).await.unwrap();
    let arms = r.studio().list_arms().await.unwrap();
    let measurements = r.studio().list_measurements().await.unwrap();
    drop(r);
    for _ in 0..2 {
        w.proof(Some("set_1"));
        assert_eq!(
            attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0].chain,
            Some(w.binding.chain.clone())
        );
    }
    for call in &w.ads.calls()[before..] {
        use crate::fakes::ConnectorCall;
        assert!(matches!(
            call,
            ConnectorCall::AdAccountContext { .. }
                | ConnectorCall::ListAdsets { .. }
                | ConnectorCall::ResolveAdset { .. }
        ));
        if let ConnectorCall::ResolveAdset {
            credential, ad_id, ..
        } = call
        {
            assert_eq!(ad_id, "ad");
            assert!(
                matches!(credential, Credential::OAuth { access_token, .. } if access_token == "ads-secret")
            );
        }
    }
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(r.journeys().events(w.journey, 100).await.unwrap(), events);
    assert_eq!(r.tasks().list(w.journey).await.unwrap(), tasks);
    assert_eq!(r.studio().list_arms().await.unwrap(), arms);
    assert_eq!(r.studio().list_measurements().await.unwrap(), measurements);
}
pub async fn read_projection_preserves_first_touch_and_tombstones(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let person = r.people().get(w.person).await.unwrap().unwrap();
    let journey = r.journeys().get(w.journey).await.unwrap().unwrap();
    drop(r);
    w.proof(Some("set_1"));
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert!(!rows[0].erased);
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(r.people().get(w.person).await.unwrap().unwrap(), person);
    assert_eq!(r.journeys().get(w.journey).await.unwrap().unwrap(), journey);
    drop(r);
    erasure::erase(
        &w.d,
        &w.ctx,
        w.person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    w.proof(Some("set_1"));
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert!(rows[0].erased);
    assert_eq!(rows[0].journey_id, w.journey);
    assert_eq!(rows[0].acquired_at, FIXED_NOW - Duration::days(1));
    let shown = serde_json::to_string(&rows).unwrap();
    for private in [
        "Private Lead",
        "private@example.test",
        "page-secret",
        "ads-secret",
        "private campaign",
        "leadgen_id",
        "form_id",
    ] {
        assert!(!shown.contains(private));
    }
}

pub async fn stored_set_proof_survives_missing_resolution_without_guessing_campaign(
    uow: Arc<dyn UnitOfWork>,
) {
    let w = setup(uow).await;
    let mut ids = Vec::new();
    for (index, set, campaign) in [
        (0, "set_1", "campaign"),
        (1, "foreign_set", "campaign"),
        (2, "set_1", "foreign_campaign"),
    ] {
        let person = jt_app::usecases::inbox::people::create(&w.d, &w.ctx, serde_json::from_value(json!({"display_name":"Stored evidence", "source":"form", "identities":[{"channel":"email","value":format!("stored-{index}@example.test")}]})).unwrap()).await.unwrap().person;
        let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
        let journey = r.journeys().open_for(person.id).await.unwrap().unwrap();
        ids.push(journey.id);
        let lead = format!("stored-{index}");
        // Exercise the existing immutable storage contract for pre-populated ad-set evidence;
        // today's M2b intake correctly leaves this optional field absent.
        r.attribution()
            .insert_once(jt_app::ports::inbox::JourneyAttribution {
                workspace_id: w.ctx.workspace_id,
                journey_id: journey.id,
                provider: "meta".into(),
                ad_id: Some("ad".into()),
                adset_id: Some(set.into()),
                campaign_id: Some(campaign.into()),
                form_id: None,
                leadgen_id: lead.clone(),
                acquired_at: FIXED_NOW - Duration::days(1),
            })
            .await
            .unwrap();
        r.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id: InboundEventId::new_v7(),
                    workspace_id: w.ctx.workspace_id,
                    capability_id: Some(w.page),
                    provider: Provider::Meta,
                    external_id: format!("leadgen:{lead}"),
                    kind: EventKind::LeadGen,
                    payload: json!({"leadgen":{"page_id":"page","leadgen_id":lead}}),
                    received_at: FIXED_NOW,
                    processed_at: Some(FIXED_NOW),
                },
                None,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    w.proof(None);
    let rows = attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap();
    assert_eq!(rows.len(), 4);
    for row in rows {
        assert_eq!(
            row.chain,
            (row.journey_id == ids[0]).then(|| w.binding.chain.clone())
        );
    }
}

pub async fn attribution_checks_permissions_windows_and_capability_access(
    uow: Arc<dyn UnitOfWork>,
) {
    use jt_app::error::ErrorCode;
    let w = setup(uow).await;
    let before = w.ads.calls().len();
    let mut denied = w.ctx.clone();
    denied.permissions.clear();
    assert_eq!(
        attribution_for_ad(&w.d, &denied, w.query())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Forbidden
    );
    for (ad, from, to) in [
        ("", w.query().from, FIXED_NOW),
        ("ad", FIXED_NOW, FIXED_NOW),
        ("ad", FIXED_NOW, w.query().from),
    ] {
        let mut q = w.query();
        q.ad_id = ad.into();
        q.from = from;
        q.to = to;
        assert_eq!(
            attribution_for_ad(&w.d, &w.ctx, q).await.unwrap_err().code,
            ErrorCode::Validation
        );
    }
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.capabilities()
        .set_sealed(w.binding.capability_id, None, FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0]
            .chain
            .is_none()
    );
    assert_eq!(w.ads.calls().len(), before);
    let mut platform = w.d.uow.platform().await.unwrap();
    platform
        .workspace_set_status(w.ctx.workspace_id, jt_tenancy::WorkspaceStatus::Suspended)
        .await
        .unwrap();
    platform.commit().await.unwrap();
    assert_eq!(
        attribution_for_ad(&w.d, &w.ctx, w.query())
            .await
            .unwrap_err()
            .code,
        ErrorCode::WorkspaceInactive
    );
    assert_eq!(w.ads.calls().len(), before);
}

pub async fn historical_attribution_paginates_retained_page_evidence(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow).await;
    let mut r = w.d.uow.tenant(w.ctx.workspace_id).await.unwrap();
    for n in 0..101 {
        r.inbound_events()
            .insert_if_new(
                InboundEvent {
                    id: InboundEventId::new_v7(),
                    workspace_id: w.ctx.workspace_id,
                    capability_id: Some(w.page),
                    provider: Provider::Meta,
                    external_id: format!("leadgen:older-{n}"),
                    kind: EventKind::LeadGen,
                    payload: json!({}),
                    received_at: FIXED_NOW - Duration::days(2),
                    processed_at: Some(FIXED_NOW),
                },
                None,
            )
            .await
            .unwrap();
    }
    r.strategy()
        .set_status(
            w.binding.chain.born_version_id,
            VersionStatus::Archived,
            FIXED_NOW,
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.proof(Some("set_1"));
    assert_eq!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0].chain,
        Some(w.binding.chain)
    );
}

pub async fn group_change_during_account_read_discards_proof(uow: Arc<dyn UnitOfWork>) {
    let w = setup(uow.clone()).await;
    let (ws, group, page) = (w.ctx.workspace_id, w.group, w.page);
    w.ads.push_ad_read_hook(move || async move {
        let mut r = uow.tenant(ws).await.unwrap();
        r.capability_groups()
            .remove_member(group, page)
            .await
            .unwrap();
        r.commit().await.unwrap();
    });
    w.proof(Some("set_1"));
    assert!(
        attribution_for_ad(&w.d, &w.ctx, w.query()).await.unwrap()[0]
            .chain
            .is_none()
    );
}

/// Offline cross-module acceptance: externally seeded set, binding and reserved budget,
/// M2b-owned intake, read-only attribution and the shared Studio projection.
pub async fn paid_smoke(uow: Arc<dyn UnitOfWork>) {
    use jt_app::usecases::{
        budget,
        studio::{ads, views},
    };
    let w = setup(uow.clone()).await;
    let mut r = uow.tenant(w.ctx.workspace_id).await.unwrap();
    let mut version = r
        .strategy()
        .find(w.binding.chain.born_version_id)
        .await
        .unwrap()
        .unwrap();
    version.sections.budget_frame.lanes = vec![jt_strategy::Lane {
        lane: LaneKind::Paid,
        period: jt_strategy::Period::Monthly,
        cap_minor: 100_000,
        currency: "TRY".into(),
    }];
    let hypotheses = r.hypotheses().list(version.id).await.unwrap();
    r.strategy()
        .set_status(version.id, VersionStatus::Archived, FIXED_NOW, None)
        .await
        .unwrap();
    version.id = StrategyVersionId::new_v7();
    version.number += 1;
    r.strategy().insert(version.clone()).await.unwrap();
    for mut h in hypotheses {
        h.cadence.insert(
            LaneKind::Paid,
            jt_strategy::HypothesisCadence {
                slots_per_week: 7,
                exploration_bps: 0,
                content_types: vec![jt_strategy::ContentTypeShare {
                    key: "text".into(),
                    min_bps: 0,
                    max_bps: 10000,
                }],
            },
        );
        r.hypotheses().upsert(version.id, h).await.unwrap();
    }
    let mut cap = r
        .capabilities()
        .find(w.binding.capability_id)
        .await
        .unwrap()
        .unwrap();
    cap.connector_public = json!({"access":{"scopes":["ads_read","ads_management"]}});
    r.capabilities().update(cap).await.unwrap();
    r.commit().await.unwrap();
    let item = budget::create_item(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({
            "name":"paid smoke", "kind":"ad_budget", "unit":{"kind":"currency","value":"TRY"},
            "cap":100_000, "period":"monthly", "unit_cost_minor":1
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let mut r = uow.tenant(w.ctx.workspace_id).await.unwrap();
    r.budget()
        .link(w.binding.capability_id, item.item.id)
        .await
        .unwrap();
    r.commit().await.unwrap();
    w.proof(Some("set_1"));
    let binding = ads::adset_bind(
        &w.d,
        &w.ctx,
        ads::BindAdSetInput {
            hypothesis_id: w.binding.chain.hypothesis_id,
            arm_id: w.binding.chain.arm_id,
            capability_id: w.binding.capability_id,
            adset_id: "set_1".into(),
            request_key: "public-bind".into(),
        },
    )
    .await
    .unwrap();
    w.proof(Some("set_1"));
    w.ads.push_set_daily_budget(Ok(()));
    let input = ads::BudgetMoveInput {
        binding_id: binding.id,
        daily_budget_minor: 20,
        currency: "TRY".into(),
        request_key: "smoke-move".into(),
    };
    let movement = ads::budget_move(&w.d, &w.ctx, input.clone()).await.unwrap();
    assert_eq!(movement.outcome, jt_studio::BudgetMoveState::Succeeded);
    assert!(movement.move_.reservation_id.is_some());
    assert_eq!(
        ads::budget_move(&w.d, &w.ctx, input).await.unwrap().move_,
        movement.move_
    );
    // A new provider event arrives after the budget move. Only the M2b consumer may
    // turn it into a journey; replaying the event must not fetch or ingest it twice.
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: w.ctx.workspace_id,
        capability_id: Some(w.page),
        provider: Provider::Meta,
        external_id: "leadgen:smoke-lead".into(),
        kind: EventKind::LeadGen,
        payload: json!({"leadgen":{"page_id":"page","leadgen_id":"smoke-lead","created_time":1790000040}}),
        received_at: FIXED_NOW,
        processed_at: None,
    };
    let mut r = uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert!(
        r.inbound_events()
            .insert_if_new(event.clone(), None)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        r.inbound_events()
            .insert_if_new(event, None)
            .await
            .unwrap()
            .is_none()
    );
    r.commit().await.unwrap();
    w.ads.push_leadgen(Ok(LeadGenRecord {
        leadgen_id: "smoke-lead".into(),
        form_id: Some("form".into()),
        ad_id: Some("smoke-ad".into()),
        campaign_id: Some("campaign".into()),
        campaign_name: None,
        created_time: Some(FIXED_NOW - Duration::hours(1)),
        fields: [(
            "email".into(),
            vec!["smoke-after-budget@example.test".into()],
        )]
        .into(),
    }));
    assert_eq!(
        consumer::consume_workspace(&w.d, w.ctx.workspace_id, FIXED_NOW)
            .await
            .changed,
        1
    );
    assert_eq!(
        consumer::consume_workspace(&w.d, w.ctx.workspace_id, FIXED_NOW)
            .await
            .changed,
        0
    );
    let before = w.ads.calls().len();
    w.proof(Some("set_1"));
    let mut query = w.query();
    query.ad_id = "smoke-ad".into();
    let attribution = attribution_for_ad(&w.d, &w.ctx, query).await.unwrap();
    assert_eq!(attribution.len(), 1);
    assert_ne!(attribution[0].journey_id, w.journey);
    let mut r = uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert!(
        r.journeys()
            .get(attribution[0].journey_id)
            .await
            .unwrap()
            .is_some()
    );
    r.commit().await.unwrap();
    assert_eq!(attribution[0].chain, Some(binding.chain.clone()));
    assert!(
        w.ads.calls()[before..]
            .iter()
            .all(|c| !matches!(c, crate::fakes::ConnectorCall::FetchLeadGen { .. }))
    );
    let overview = views::overview(
        &w.d,
        &w.ctx,
        views::StudioQuery {
            hypothesis_id: Some(binding.chain.hypothesis_id),
            lane: Some(LaneKind::Paid),
            from: FIXED_NOW - Duration::days(1),
            until: FIXED_NOW + Duration::days(1),
        },
    )
    .await
    .unwrap();
    assert!(overview.lane_support.organic.visible && overview.lane_support.paid.visible);
    assert_eq!(overview.bindings, vec![binding]);
    assert_eq!(
        w.ads
            .calls()
            .iter()
            .filter(|c| matches!(c, crate::fakes::ConnectorCall::SetDailyBudget { .. }))
            .count(),
        1
    );
    let mut r = uow.tenant(w.ctx.workspace_id).await.unwrap();
    assert_eq!(
        r.budget()
            .spent_between(
                item.item.id,
                FIXED_NOW - Duration::days(1),
                FIXED_NOW + Duration::days(1)
            )
            .await
            .unwrap(),
        0
    );
}
