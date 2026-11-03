//! Lead distribution's repository contracts (`jt_testkit::distribution_contract`) against the
//! in-memory fake.

#[tokio::test]
async fn one_live_assignment_per_journey() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::one_live_assignment_per_journey(uow).await;
}

#[tokio::test]
async fn supersede_then_insert_in_one_bundle() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::supersede_then_insert_in_one_bundle(uow).await;
}

#[tokio::test]
async fn touch_marks_only_the_owner_once() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::touch_marks_only_the_owner_once(uow).await;
}

#[tokio::test]
async fn due_sla_lists_unacted_past_due() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::due_sla_lists_unacted_past_due(uow).await;
}

#[tokio::test]
async fn ownerless_open_excludes_closed_and_owned() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::ownerless_open_excludes_closed_and_owned(uow).await;
}

#[tokio::test]
async fn rules_replace_all_keeps_positions_unique() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::rules_replace_all_keeps_positions_unique(uow).await;
}

#[tokio::test]
async fn rep_profile_default_when_absent() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::rep_profile_default_when_absent(uow).await;
}

#[tokio::test]
async fn recipient_kind_round_trips() {
    let uow = std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new());
    jt_testkit::distribution_contract::recipient_kind_round_trips(uow).await;
}
