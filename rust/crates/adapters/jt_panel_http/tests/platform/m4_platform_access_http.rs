use axum::http::{Method, StatusCode};
use jt_app::{
    ports::{OperatorRow, PasswordHasher},
    usecases::{auth::LoginInput, platform},
};
use jt_tenancy::{Email, OperatorId};
use jt_testkit::{
    fakes::{FIXED_NOW, PlainHasher},
    panel::{Panel, request},
};
use serde_json::json;
#[tokio::test]
async fn tenant_and_operator_sessions_are_not_interchangeable() {
    let p = Panel::new().await;
    let (tenant, _) = p.register("owner@example.test", "Synthetic").await;
    platform::bootstrap(
        &p.deps,
        jt_testkit::flows::OPERATOR_EMAIL,
        jt_testkit::flows::OPERATOR_PASSWORD,
    )
    .await
    .unwrap();
    let op = platform::login(
        &p.deps,
        LoginInput {
            email: jt_testkit::flows::OPERATOR_EMAIL.into(),
            password: jt_testkit::flows::OPERATOR_PASSWORD.into(),
        },
    )
    .await
    .unwrap();
    let ctx = platform::resolve(&p.deps, &op.token).await.unwrap();
    let target = OperatorId::new_v7();
    let mut r = p.deps.uow.platform().await.unwrap();
    r.operators()
        .insert(OperatorRow {
            id: target,
            email: Email::parse("target@example.test").unwrap(),
            password_hash: PlainHasher.hash("target password").await.unwrap(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = p.deps.uow.platform().await.unwrap();
    r.platform_sessions()
        .insert(jt_app::ports::PlatformSessionRow {
            id: jt_tenancy::OperatorId::new_v7().as_uuid().to_owned(),
            operator_id: ctx.operator_id,
            token_hash: jt_app::usecases::hash_token("expired-token"),
            created_at: FIXED_NOW - time::Duration::days(1),
            expires_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    let path = format!("/api/platform/operators/{target}/reset-password");
    let cookie = format!("jt_platform={}", op.token);
    for cookie in [
        tenant.clone(),
        tenant.replace("jt_session=", "jt_platform="),
        "jt_platform=expired-token".into(),
    ] {
        assert_eq!(
            p.send(
                Method::POST,
                &path,
                Some(&cookie),
                Some(json!({"password":"replacement password"}))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let key = jt_testkit::panel::ok_json(
        p.send(
            Method::POST,
            "/api/api-keys",
            Some(&tenant),
            Some(json!({"name":"synthetic isolation key"})),
        )
        .await,
    )
    .await;
    let key = key["plaintext"].as_str().unwrap();
    assert!(
        jt_app::usecases::api_keys::authenticate(&p.deps, key)
            .await
            .is_ok()
    );
    for credential in [
        tenant.strip_prefix("jt_session=").unwrap(),
        op.token.as_str(),
        key,
    ] {
        let mut req = request(
            Method::POST,
            &path,
            None,
            true,
            Some(json!({"password":"replacement password"})),
        );
        req.headers_mut().insert(
            "authorization",
            format!("Bearer {credential}").parse().unwrap(),
        );
        assert_eq!(p.call(req).await.status(), StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        p.get("/api/auth/me", &cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        p.get(
            "/api/auth/me",
            &cookie.replace("jt_platform=", "jt_session=")
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let mut req = request(
        Method::POST,
        &path,
        Some(&cookie),
        true,
        Some(json!({"password":"replacement password"})),
    );
    req.headers_mut().remove("x-requested-with");
    assert_eq!(p.call(req).await.status(), StatusCode::FORBIDDEN);
    let own = format!("/api/platform/operators/{}/reset-password", ctx.operator_id);
    assert_eq!(
        p.send(
            Method::POST,
            &own,
            Some(&cookie),
            Some(json!({"password":"replacement password"}))
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        p.send(
            Method::POST,
            &path,
            Some(&cookie),
            Some(json!({"password":"short"}))
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        p.send(
            Method::POST,
            &path,
            Some(&cookie),
            Some(json!({"password":"replacement password"}))
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let mut r = p.deps.uow.platform().await.unwrap();
    r.platform_sessions()
        .revoke_all(ctx.operator_id)
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        p.get("/api/platform/health", &cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
}
