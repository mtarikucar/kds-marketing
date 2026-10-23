mod support;
use jt_app::{
    ports::{UnitOfWork, connectors::LeadGenRecord, inbox::ConsumptionOutcome},
    usecases::inbox::{consumer, people},
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime};

fn lead() -> LeadGenRecord {
    LeadGenRecord {
        leadgen_id: "6666666666".into(),
        form_id: Some("7777777777".into()),
        ad_id: Some("8888888888".into()),
        campaign_id: Some("9999999999".into()),
        campaign_name: Some("Private campaign title".into()),
        created_time: Some(OffsetDateTime::from_unix_timestamp(1790000040).unwrap()),
        fields: [
            ("full_name".into(), vec!["Ada Lead".into()]),
            ("email".into(), vec![" Ada@Example.com ".into()]),
            ("phone_number".into(), vec!["05321234567".into()]),
        ]
        .into(),
    }
}
async fn setup() -> (World, CapabilityId, Arc<ScriptedConnector>) {
    setup_kind("facebook_page").await
}
async fn setup_kind(kind: &str) -> (World, CapabilityId, Arc<ScriptedConnector>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: "Page".into(),
            ..Default::default()
        },
        w.owner_ctx.now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.external_id = Some("1234567890".into());
    let cred = Credential::PageToken {
        page_id: "1234567890".into(),
        token: "secret-page-token".into(),
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    (w, id, connector)
}
async fn put(w: &World, cap: CapabilityId, id: &str) -> InboundEvent {
    let raw = include_bytes!("fixtures/meta/page_leadgen.json");
    let mut draft = jt_meta::webhook::parse(raw).unwrap().remove(0).event;
    draft.payload["leadgen"]["leadgen_id"] = json!(id);
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: w.ws,
        capability_id: Some(cap),
        provider: Provider::Meta,
        external_id: format!("leadgen:{id}"),
        kind: draft.kind,
        payload: draft.payload,
        received_at: w.owner_ctx.now,
        processed_at: None,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(event.clone(), Some(raw.to_vec()))
        .await
        .unwrap();
    r.commit().await.unwrap();
    event
}
async fn run(w: &World) -> jt_app::usecases::jobs::JobReport {
    consumer::consume_workspace(&w.deps, w.ws, w.owner_ctx.now).await
}
async fn existing(w: &World, channel: &str, value: &str) -> Person {
    people::create(&w.deps, &w.owner_ctx, serde_json::from_value(json!({"display_name":"Existing","source":"import","identities":[{"channel":channel,"value":value}]})).unwrap()).await.unwrap().person
}

#[tokio::test]
async fn leadgen_adapter_fields_create_meta_ads_person_and_task() {
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.people[0].display_name, "Ada Lead");
    assert_eq!(s.inbox.people[0].first_touch.source, Source::MetaAds);
    assert_eq!(s.inbox.identities.len(), 2);
    assert!(
        s.inbox
            .identities
            .iter()
            .any(|i| i.value_normalized == "ada@example.com")
    );
    assert!(
        s.inbox
            .identities
            .iter()
            .any(|i| i.value_normalized == "+905321234567")
    );
    assert_eq!(s.inbox.journeys[0].status, JourneyStatus::New);
    assert_eq!(s.inbox.tasks.len(), 1);
    assert_eq!(
        s.inbox.tasks[0].due_at,
        w.owner_ctx.now + Duration::hours(1)
    );
    assert_eq!(s.inbox.tasks[0].assignee, None);
    assert!(s.inbox.conversations.is_empty());
    assert!(s.inbox.messages.is_empty());
    let shown = serde_json::to_string(&s.ledger).unwrap();
    for private in [
        "secret-page-token",
        "Ada Lead",
        "ada@example.com",
        "Private campaign title",
    ] {
        assert!(!shown.contains(private));
    }
}

#[tokio::test]
async fn leadgen_existing_person_preserves_first_touch() {
    let (w, cap, connector) = setup().await;
    let p = existing(&w, "email", "ada@example.com").await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.people[0].first_touch, p.first_touch);
    assert_eq!(s.inbox.journeys.len(), 1);
    assert_eq!(s.inbox.journeys[0].source, Source::Import);
    assert!(
        s.inbox.attribution.is_empty(),
        "a later touch cannot become initial attribution"
    );
    assert_eq!(s.inbox.events.len(), 1);
    assert_eq!(s.inbox.tasks.len(), 1);
}

#[tokio::test]
async fn deferred_leadgen_reclaimed_once() {
    for prior in ["inbox@1", "inbox@2"] {
        let (w, cap, connector) = setup().await;
        let event = put(&w, cap, "6666666666").await;
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        assert!(r.consumption().try_claim(prior, event.id).await.unwrap());
        r.consumption()
            .record(
                prior,
                event.id,
                ConsumptionOutcome {
                    consumed_at: w.owner_ctx.now,
                    outcome: "deferred".into(),
                },
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
        connector.push_leadgen(Ok(lead()));
        assert_eq!(run(&w).await.changed, 1);
        assert_eq!(run(&w).await.touched, 0);
        let s = w.uow.snapshot();
        assert_eq!(s.inbox.tasks.len(), 1);
        assert_eq!(
            s.inbox.consumption.len(),
            if prior == "inbox@2" { 1 } else { 2 }
        );
        assert_eq!(connector.calls().len(), 1);
    }
}

#[tokio::test]
async fn leadgen_attribution_written_atomically_once() {
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    let before = w.uow.snapshot();
    w.uow.fail_inbox_consumption(1);
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.failed, 1);
    let failed = w.uow.snapshot();
    assert!(failed.inbox.people.is_empty());
    assert!(failed.inbox.journeys.is_empty());
    assert!(failed.inbox.attribution.is_empty());
    assert!(failed.inbox.tasks.is_empty());
    assert!(failed.inbox.events.is_empty());
    assert!(failed.inbox.consumption.is_empty());
    assert_eq!(failed.ledger.len(), before.ledger.len());
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let s = w.uow.snapshot();
    let a = &s.inbox.attribution[0];
    assert_eq!(a.journey_id, s.inbox.journeys[0].id);
    assert_eq!(a.provider, "meta");
    assert_eq!(a.leadgen_id, "6666666666");
    assert_eq!(a.acquired_at.unix_timestamp(), 1790000040);
    assert_eq!(a.ad_id.as_deref(), Some("8888888888"));
    assert_eq!(a.adset_id, None);
    assert_eq!(a.campaign_id.as_deref(), Some("9999999999"));
    assert_eq!(a.form_id.as_deref(), Some("7777777777"));
    assert_eq!(run(&w).await.touched, 0);
    assert_eq!(w.uow.snapshot().inbox.attribution.len(), 1);
}

#[tokio::test]
async fn leadgen_failure_rolls_back_claim() {
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Err(jt_connector::ConnectorError::permanent(
        "secret-provider-error",
    )));
    assert_eq!(run(&w).await.failed, 1);
    assert!(w.uow.snapshot().inbox.consumption.is_empty());
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
}

#[tokio::test]
async fn leadgen_replay_and_later_touch_preserve_attribution() {
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let before = w.uow.snapshot();
    assert_eq!(run(&w).await.touched, 0);
    put(&w, cap, "second").await;
    let mut later = lead();
    later.leadgen_id = "second".into();
    later.ad_id = Some("later-ad".into());
    later.created_time = Some(w.owner_ctx.now);
    connector.push_leadgen(Ok(later));
    assert_eq!(run(&w).await.changed, 1);
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.attribution, before.inbox.attribution);
    assert_eq!(
        after.inbox.people[0].first_touch,
        before.inbox.people[0].first_touch
    );
    assert_eq!(after.inbox.journeys.len(), 1);
    assert_eq!(after.inbox.events.len(), 2);
    assert_eq!(after.inbox.tasks.len(), 2);
}

#[tokio::test]
async fn leadgen_split_returns_conflict_ids_and_merge_suggestion() {
    let (w, cap, connector) = setup().await;
    let a = existing(&w, "email", "ada@example.com").await;
    let b = existing(&w, "phone", "05321234567").await;
    let event = put(&w, cap, "6666666666").await;
    let before = w.uow.snapshot();
    connector.push_leadgen(Ok(lead()));
    let e = consumer::consume_event(&w.deps, &event, w.owner_ctx.now)
        .await
        .unwrap_err();
    assert_eq!(e.code, jt_app::error::ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "identity_split");
    let ids = e.details["person_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&json!(a.id)) && ids.contains(&json!(b.id)));
    assert!(
        e.details["merge_suggestion"]["decision"]
            .get("suggest")
            .is_some()
    );
    let failed = w.uow.snapshot();
    assert!(failed.inbox.consumption.is_empty());
    assert!(failed.inbox.tasks.is_empty());
    assert_eq!(failed.inbox.identities, before.inbox.identities);
    assert_eq!(failed.inbox.merges.len(), 1);
    assert_eq!(
        e.details["merge_suggestion"]["id"],
        json!(failed.inbox.merges[0].id)
    );
    assert_eq!(failed.ledger.len(), before.ledger.len() + 1);
    let pending = jt_app::usecases::work::pending(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    assert!(
        serde_json::to_value(pending)
            .unwrap()
            .to_string()
            .contains(&failed.inbox.merges[0].id.to_string())
    );
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.failed, 1);
    assert_eq!(w.uow.snapshot().inbox.merges.len(), 1);
    assert_eq!(w.uow.snapshot().ledger.len(), failed.ledger.len());
    // A caller retries the unclaimed event with a single resolved identity.
    let mut one = lead();
    one.fields.remove("phone_number");
    connector.push_leadgen(Ok(one));
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(w.uow.snapshot().inbox.people.len(), 2);
}

#[tokio::test]
async fn attribution_survives_raw_retention_and_erasure() {
    use jt_app::usecases::inbox::erasure;
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let before = w.uow.snapshot();
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(
        r.inbound_events()
            .purge_raw_before(w.owner_ctx.now + Duration::days(1))
            .await
            .unwrap(),
        1
    );
    r.commit().await.unwrap();
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        before.inbox.people[0].id,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    assert_eq!(w.uow.snapshot().inbox.attribution, before.inbox.attribution);
    put(&w, cap, "erased-replay").await;
    let mut replay = lead();
    replay.leadgen_id = "erased-replay".into();
    connector.push_leadgen(Ok(replay));
    assert_eq!(run(&w).await.failed, 0);
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.people.len(), 1);
    assert!(after.inbox.people[0].erased_at.is_some());
    assert!(after.inbox.identities.is_empty());
    assert_eq!(after.inbox.attribution, before.inbox.attribution);
    assert!(after.inbox.consumption.iter().any(|c| {
        c.outcome
            .as_ref()
            .is_some_and(|o| o.outcome == "erased_identity_drop")
    }));
}

#[tokio::test]
async fn leadgen_terminal_rules_and_task_due() {
    use jt_app::usecases::{inbox::journeys, work};
    for terminal in ["won", "lost"] {
        let (w, cap, connector) = setup().await;
        let p = existing(&w, "email", "ada@example.com").await;
        let j = w.uow.snapshot().inbox.journeys[0].id;
        let payload = if terminal == "won" {
            json!({"product":"Test", "amount_minor":100,"currency":"TRY"})
        } else {
            json!({"reason_key":"fiyat"})
        };
        journeys::report(
            &w.deps,
            &w.owner_ctx,
            j,
            serde_json::from_value(
                json!({"kind":terminal,"idempotency_key":terminal,"payload":payload}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        put(&w, cap, "6666666666").await;
        connector.push_leadgen(Ok(lead()));
        assert_eq!(run(&w).await.changed, 1);
        let s = w.uow.snapshot();
        assert_eq!(s.inbox.people[0].first_touch, p.first_touch);
        let task = s
            .inbox
            .tasks
            .iter()
            .find(|t| t.due_at == w.owner_ctx.now + Duration::hours(1))
            .unwrap();
        if terminal == "won" {
            assert_eq!(s.inbox.journeys.len(), 2);
            let next = s
                .inbox
                .journeys
                .iter()
                .find(|j| j.id == task.journey_id)
                .unwrap();
            assert_eq!(next.source, Source::Repeat);
            assert_eq!(next.status, JourneyStatus::New);
            assert_eq!(s.inbox.attribution[0].journey_id, next.id);
        } else {
            assert_eq!(s.inbox.journeys.len(), 1);
            assert_eq!(s.inbox.journeys[0].status, JourneyStatus::Lost);
            assert!(s.inbox.attribution.is_empty());
        }
        let due = work::pending(
            &w.deps,
            &at(&w.owner_ctx, w.owner_ctx.now + Duration::hours(1)),
        )
        .await
        .unwrap();
        assert!(
            serde_json::to_value(due)
                .unwrap()
                .to_string()
                .contains(&task.id.to_string())
        );
    }
}

#[tokio::test]
async fn leadgen_missing_attribution_is_not_guessed_and_provider_time_is_required() {
    let (w, cap, connector) = setup().await;
    let mut event = put(&w, cap, "6666666666").await;
    let mut minimal = lead();
    minimal.ad_id = None;
    minimal.campaign_id = None;
    minimal.form_id = None;
    minimal.created_time = None;
    event.payload["leadgen"]
        .as_object_mut()
        .unwrap()
        .remove("created_time");
    connector.push_leadgen(Ok(minimal.clone()));
    assert_eq!(
        consumer::consume_event(&w.deps, &event, w.owner_ctx.now)
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::Validation
    );
    assert!(w.uow.snapshot().inbox.consumption.is_empty());
    connector.push_leadgen(Ok(minimal));
    assert_eq!(run(&w).await.changed, 1);
    let s = w.uow.snapshot();
    let a = &s.inbox.attribution[0];
    assert!(
        a.ad_id.is_none() && a.adset_id.is_none() && a.form_id.is_none() && a.campaign_id.is_none()
    );
    assert_eq!(a.acquired_at.unix_timestamp(), 1790000040);
}

#[tokio::test]
async fn leadgen_rejects_mismatched_page_and_submission_without_effects() {
    let (w, cap, connector) = setup().await;
    let mut event = put(&w, cap, "6666666666").await;
    event.payload["leadgen"]["page_id"] = json!("other-page");
    assert!(
        consumer::consume_event(&w.deps, &event, w.owner_ctx.now)
            .await
            .is_err()
    );
    assert!(connector.calls().is_empty());
    let mut wrong = lead();
    wrong.leadgen_id = "wrong-lead".into();
    connector.push_leadgen(Ok(wrong));
    assert_eq!(run(&w).await.failed, 1);
    assert!(w.uow.snapshot().inbox.people.is_empty());
    assert!(w.uow.snapshot().inbox.consumption.is_empty());
}

#[tokio::test]
async fn leadgen_journey_get_exposes_original_attribution() {
    let (w, cap, connector) = setup().await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let out = jt_app::usecases::inbox::journeys::get(&w.deps, &w.owner_ctx, j)
        .await
        .unwrap();
    let value = serde_json::to_value(out).unwrap();
    assert_eq!(value["attribution"]["leadgen_id"], "6666666666");
    assert_eq!(
        value["events"][0]["kind"]["lead_received"]["leadgen_id"],
        "6666666666"
    );
    assert_eq!(value["tasks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn leadgen_routed_to_messenger_uses_its_bound_page_token() {
    use jt_testkit::fakes::ConnectorCall;
    let (w, cap, connector) = setup_kind("messenger").await;
    put(&w, cap, "6666666666").await;
    connector.push_leadgen(Ok(lead()));
    assert_eq!(run(&w).await.changed, 1);
    assert_eq!(w.uow.snapshot().inbox.attribution.len(), 1);
    assert!(
        matches!(&connector.calls()[0], ConnectorCall::FetchLeadGen { credential: Credential::PageToken { page_id, token }, leadgen_id } if page_id == "1234567890" && token == "secret-page-token" && leadgen_id == "6666666666")
    );
}

#[tokio::test]
async fn deferred_leadgen_claim_is_narrow_and_transactional() {
    jt_testkit::compliance_contract::deferred_leadgen_claim_is_narrow_and_transactional(Arc::new(
        jt_testkit::fakes::InMemoryUow::new(),
    ))
    .await;
}
