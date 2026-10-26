#[tokio::test]
async fn operator_reset_revokes_all_sessions() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_access_contract::operator_reset_revokes_all_sessions(std::sync::Arc::new(
        uow,
    ))
    .await;
}
#[tokio::test]
async fn sole_operator_bootstrap_reset_changes_password() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_access_contract::sole_operator_bootstrap_reset_changes_password(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn bootstrap_reset_rejects_zero_multiple_or_wrong_operator() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_access_contract::bootstrap_reset_rejects_zero_multiple_or_wrong_operator(
        std::sync::Arc::new(uow),
    )
    .await;
}
#[tokio::test]
async fn reset_and_inflight_login_serialize() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_access_contract::reset_and_inflight_login_serialize(std::sync::Arc::new(
        uow,
    ))
    .await;
}
#[tokio::test]
async fn bootstrap_requires_both_fields_and_twelve_characters() {
    let d = jt_testkit::fakes::deps(std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()));
    for (email, password) in [
        ("", "synthetic password"),
        ("op@example.test", ""),
        ("op@example.test", "12345678901"),
    ] {
        assert!(
            jt_app::usecases::platform::bootstrap(&d, email, password)
                .await
                .is_err()
        );
    }
    assert!(
        jt_app::usecases::platform::bootstrap(&d, "op@example.test", "ş".repeat(12).as_str())
            .await
            .unwrap()
    );
}
#[tokio::test]
async fn bootstrap_restart_never_creates_second_operator() {
    let d = jt_testkit::fakes::deps(std::sync::Arc::new(jt_testkit::fakes::InMemoryUow::new()));
    assert!(
        jt_app::usecases::platform::bootstrap(&d, "op@example.test", "synthetic password")
            .await
            .unwrap()
    );
    assert!(
        !jt_app::usecases::platform::bootstrap(&d, "other@example.test", "different password")
            .await
            .unwrap()
    );
    assert_eq!(
        d.uow
            .platform()
            .await
            .unwrap()
            .operators()
            .count()
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn recovery_lock_serializes_operator_insert() {
    let uow = jt_testkit::fakes::InMemoryUow::new();
    jt_testkit::platform_access_contract::recovery_lock_serializes_operator_insert(
        std::sync::Arc::new(uow),
    )
    .await;
}
