//! M3 controller contracts, before downstream Studio behavior is implemented.
use serde_json::json;

#[test]
fn hypothesis_cadence_strict_schema_round_trip() {
    let input = json!([{"title":"Test", "prior_confidence":0.3, "cadence": {
        "organic":{"slots_per_week":7,"content_types":[{"key":"image","min_bps":2500,"max_bps":10000}]}
    }}]);
    let parsed = jt_strategy::parse_hypotheses_strict(&input).unwrap();
    let value = serde_json::to_value(&parsed).unwrap();
    assert_eq!(value[0]["cadence"]["organic"]["exploration_bps"], 0);
    assert_eq!(value[0]["prior_confidence"], json!(0.3_f32));
    for bad in [
        json!({"organic":{"slots_per_week":1,"exploration_bps":10001,"content_types":[]}}),
        json!({"organic":{"slots_per_week":1,"content_types":[{"key":"a","min_bps":0,"max_bps":9999}]}}),
        json!({"organic":{"slots_per_week":1,"content_types":[{"key":"a","min_bps":0,"max_bps":10000,"oops":1}]}}),
        json!({"organic":{"slots_per_week":1,"content_types":[{"key":"a","min_bps":0,"max_bps":10000},{"key":"a","min_bps":0,"max_bps":10000}]}}),
        json!({"other":{"slots_per_week":0,"content_types":[]}}),
    ] {
        assert!(jt_strategy::parse_hypotheses_strict(&json!([{"cadence":bad}])).is_err());
    }
    assert!(jt_strategy::parse_hypotheses_strict(&json!([{"derived_confidence":0.9}])).is_err());
}

#[tokio::test]
async fn budget_unit_cost_schema_and_twins() {
    let value = json!({"name":"SMS", "kind":"sms_budget", "unit":{"kind":"currency","value":"TRY"},"cap":1000,"period":"monthly","unit_cost_minor":3});
    use jt_app::usecases::budget::{self, BudgetItemInput, UpdateBudgetItem};
    let w = support::world().await;
    let parse = |value| serde_json::from_value::<BudgetItemInput>(value).unwrap();
    let out = budget::create_item(&w.deps, &w.owner_ctx, parse(value.clone()))
        .await
        .unwrap();
    assert_eq!(out.item.unit_cost_minor, Some(3));
    let zero = serde_json::from_value::<UpdateBudgetItem>(json!({"unit_cost_minor":0})).unwrap();
    let out = budget::update_item(&w.deps, &w.owner_ctx, out.item.id, zero)
        .await
        .unwrap();
    assert_eq!(out.item.unit_cost_minor, Some(0));
    let clear =
        serde_json::from_value::<UpdateBudgetItem>(json!({"unit_cost_minor":null})).unwrap();
    let out = budget::update_item(&w.deps, &w.owner_ctx, out.item.id, clear)
        .await
        .unwrap();
    assert_eq!(out.item.unit_cost_minor, None);
    let mut bad = value;
    bad["unit_cost_minor"] = json!(-1);
    let err = budget::create_item(&w.deps, &w.owner_ctx, parse(bad))
        .await
        .unwrap_err();
    assert_eq!(err.code, jt_app::error::ErrorCode::Validation);
    assert_eq!(err.details["field"], "unit_cost_minor");
}

#[test]
fn sms_segments_ascii_160_161_and_turkish_70_71() {
    for (text, expected) in [
        ("a".repeat(160), 1),
        ("a".repeat(161), 2),
        ("ş".repeat(70), 1),
        ("ğ".repeat(71), 2),
    ] {
        assert_eq!(jt_inbox::sms_segments(&text), expected);
        assert_eq!(
            3 * i64::from(jt_inbox::sms_segments(&text)),
            3 * i64::from(expected)
        );
    }
}

#[tokio::test]
async fn ad_status_meta_and_fake_contract() {
    use jt_app::ports::connectors::{AdBudgetWriter, AdStatus};
    use jt_connector::{Credential, Provider};
    let fake = jt_testkit::fakes::ScriptedConnector::new(Provider::Meta);
    let credential = Credential::OAuth {
        access_token: "test".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    };
    assert!(
        fake.set_status(&credential, "123", AdStatus::Paused)
            .await
            .is_err()
    );
    fake.push_set_status(Ok(()));
    fake.set_status(&credential, "123", AdStatus::Paused)
        .await
        .unwrap();
    fake.push_set_status(Ok(()));
    fake.set_status(&credential, "123", AdStatus::Active)
        .await
        .unwrap();
    assert!(fake.account_context(&credential, &json!({})).await.is_err());
}

#[path = "support/mod.rs"]
mod support;

#[tokio::test]
async fn studio_contracts_compile_for_every_adapter_and_fake() {
    use jt_app::ports::UnitOfWork;
    use jt_app::ports::inbox::AttributionReader;
    fn external<
        T: jt_app::ports::connectors::AdBudgetWriter + jt_app::ports::connectors::Publisher,
    >() {
    }
    external::<jt_meta::MetaConnector>();
    external::<jt_testkit::fakes::ScriptedConnector>();
    let w = support::world().await;
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        repos
            .studio()
            .claim_publication(w.owner_ctx.now)
            .await
            .is_err()
    );
    assert!(repos.studio_control().lock_control().await.is_err());
    let _budget: &mut dyn jt_app::ports::studio::StudioBudgetRepo = repos.studio_budget();
    assert!(
        w.deps
            .files
            .read(w.ws, jt_app::ports::studio::FileId::new_v7())
            .await
            .is_err()
    );
    assert!(
        w.deps
            .attribution()
            .by_ad(w.ws, "missing", w.owner_ctx.now, w.owner_ctx.now)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn derived_confidence_cannot_edit_hypothesis_content() {
    use jt_app::ports::UnitOfWork;
    use jt_app::usecases::strategy;
    let w = support::world().await;
    let version = w.approve_strategy().await;
    let h: jt_strategy::Hypothesis = serde_json::from_value(
        json!({"id":jt_strategy::HypothesisId::new_v7(),"title":"Original","prior_confidence":0.2}),
    )
    .unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    repos.hypotheses().upsert(version, h.clone()).await.unwrap();
    repos.commit().await.unwrap();
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    repos
        .hypotheses()
        .set_derived_confidence(h.id, 0.8, "post:123:24h")
        .await
        .unwrap();
    repos.commit().await.unwrap();
    strategy::set_hypotheses(
        &w.deps,
        &w.owner_ctx,
        json!([{"id":h.id,"title":"Edited","prior_confidence":0.1}]),
    )
    .await
    .unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    let rows = repos.hypotheses().list(draft.id).await.unwrap();
    assert_eq!(rows[0].title, "Edited");
    assert_eq!(rows[0].prior_confidence, 0.1);
    assert_eq!(rows[0].derived_confidence, Some(0.8));
    assert_eq!(rows[0].confidence(), 0.8);
    assert_eq!(
        repos.hypotheses().list(version).await.unwrap()[0].title,
        "Original"
    );
    repos
        .hypotheses()
        .set_derived_confidence(h.id, 0.8, "post:123:24h")
        .await
        .unwrap();
    repos.commit().await.unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    assert!(
        repos
            .hypotheses()
            .set_derived_confidence(h.id, 0.4, "post:123:24h")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn strategy_transition_and_cancel_share_transaction() {
    use async_trait::async_trait;
    use jt_app::error::AppError;
    use jt_app::ports::studio::{StrategyChange, StrategyTransitionHook};
    use jt_app::ports::{TenantRepos, UnitOfWork};
    use jt_app::usecases::strategy::{self, ArchiveInput};
    use std::sync::Arc;
    struct Cancel {
        fail: bool,
    }
    #[async_trait]
    impl StrategyTransitionHook for Cancel {
        async fn apply(
            &self,
            repos: &mut dyn TenantRepos,
            change: &StrategyChange,
        ) -> Result<(), AppError> {
            assert!(change.current.is_none());
            let previous = repos
                .strategy()
                .find(change.previous.unwrap())
                .await?
                .unwrap();
            assert_eq!(previous.status, jt_strategy::VersionStatus::Archived);
            repos
                .hypotheses()
                .set_state(
                    previous.id,
                    change.retired[0],
                    jt_strategy::HypothesisState::Retired,
                )
                .await?;
            if self.fail {
                Err(AppError::internal("injected cancellation failure"))
            } else {
                Ok(())
            }
        }
    }
    let mut w = support::world().await;
    let version = w.approve_strategy().await;
    let h: jt_strategy::Hypothesis =
        serde_json::from_value(json!({"id":jt_strategy::HypothesisId::new_v7(),"title":"Keep"}))
            .unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    repos.hypotheses().upsert(version, h).await.unwrap();
    repos.commit().await.unwrap();
    w.deps.transition_hook = Arc::new(Cancel { fail: true });
    assert!(
        strategy::archive(
            &w.deps,
            &w.owner_ctx,
            ArchiveInput {
                version_id: version,
                confirm: true
            }
        )
        .await
        .is_err()
    );
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    assert_eq!(
        repos
            .strategy()
            .current_approved()
            .await
            .unwrap()
            .unwrap()
            .id,
        version
    );
    assert_eq!(
        repos.hypotheses().list(version).await.unwrap()[0].state,
        jt_strategy::HypothesisState::Kept
    );
    drop(repos);
    w.deps.transition_hook = Arc::new(Cancel { fail: false });
    strategy::archive(
        &w.deps,
        &w.owner_ctx,
        ArchiveInput {
            version_id: version,
            confirm: true,
        },
    )
    .await
    .unwrap();
    let mut repos = w.uow.tenant(w.ws).await.unwrap();
    assert!(repos.strategy().current_approved().await.unwrap().is_none());
    assert_eq!(
        repos.hypotheses().list(version).await.unwrap()[0].state,
        jt_strategy::HypothesisState::Retired
    );
}

#[tokio::test]
async fn append_draft_hypothesis_preserves_existing_content_and_withdraws_submission() {
    use jt_app::ports::UnitOfWork;
    use jt_app::usecases::strategy;
    let w = support::world().await;
    let draft = strategy::start_consultation(&w.deps, &w.owner_ctx)
        .await
        .unwrap();
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    let input =
        |title| serde_json::from_value(json!({"title":title,"prior_confidence":0.3})).unwrap();
    let first = tx
        .hypotheses()
        .append_draft_hypothesis(draft.id, input("First"))
        .await
        .unwrap();
    tx.strategy()
        .set_submitted(draft.id, Some(w.owner_ctx.now))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = w.uow.tenant(w.ws).await.unwrap();
    let second = tx
        .hypotheses()
        .append_draft_hypothesis(draft.id, input("Second"))
        .await
        .unwrap();
    assert_ne!(first, second);
    let rows = tx.hypotheses().list(draft.id).await.unwrap();
    assert_eq!(
        rows.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(),
        vec!["First", "Second"]
    );
    assert!(
        tx.strategy()
            .find(draft.id)
            .await
            .unwrap()
            .unwrap()
            .submitted_at
            .is_none()
    );
}
