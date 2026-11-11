//! Olay-driven publishing's routes (spec 2026-11-03 §14.3) end to end through Postgres: behind the
//! strategy gate, the request id from the path (one in the body is `422`), a package refused whole
//! or materialized, the planned posts and the week's summary, and the posting policy an owner's
//! in person (a rep's is `403`).

use std::sync::Arc;

use axum::http::{Method, StatusCode};
use jt_testkit::fakes::{FakeAppConfig, ScriptedConnector, ScriptedRegistry};
use jt_testkit::panel::{Panel, expect_error, ok_json, workspace_of};
use serde_json::json;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime, UtcOffset};

#[tokio::test]
async fn a_package_answers_a_request_and_the_week_shows_its_posts() {
    let p = Panel::with_providers(
        Arc::new(FakeAppConfig::default()),
        Arc::new(
            ScriptedRegistry::new()
                .with_connector(Arc::new(ScriptedConnector::new(jt_connector::Provider::X))),
        ),
    )
    .await;
    let (owner, me) = p.register("owner@posts.example", "Posts").await;
    expect_error(
        p.get("/api/studio/post-requests", &owner).await,
        StatusCode::CONFLICT,
        "STRATEGY_REQUIRED",
    )
    .await;

    // An approved strategy whose hypothesis posts on the verified X account, and a material of a
    // confirmed olay that settled half an hour ago: the planner asks for a package.
    let ws = workspace_of(&me);
    let user: jt_tenancy::UserId = me["user_id"].as_str().unwrap().parse().unwrap();
    let f = jt_testkit::studio_contract::ready_in(&p.uow, ws, user).await;
    let now = OffsetDateTime::now_utc();
    jt_testkit::studio_contract::make_postable(&p.uow, &f, p.deps.seal.as_ref(), now).await;
    // Without the content module the planner asks agents for posts (design 2026-11-10 B18);
    // with it, the same trigger opens a production area instead.
    let removed = p
        .send(
            axum::http::Method::DELETE,
            "/api/workspace/modules/content",
            Some(&owner),
            None,
        )
        .await;
    assert_eq!(removed.status(), StatusCode::OK);
    jt_app::usecases::studio::planner::plan(&p.deps, ws, now + Duration::minutes(31))
        .await
        .unwrap();
    let requests = ok_json(p.get("/api/studio/post-requests", &owner).await).await;
    let request = &requests[0];
    assert_eq!(request["trigger"], "olay");
    let id = request["id"].as_str().unwrap().to_owned();
    let proposal = format!("/api/studio/post-requests/{id}/proposal");

    // Noon in Istanbul three days ahead: past the feed post's lead, outside the quiet hours.
    let istanbul = UtcOffset::from_hms(3, 0, 0).unwrap();
    let day = (now + Duration::days(3)).to_offset(istanbul).date();
    let at = day
        .with_hms(12, 0, 0)
        .unwrap()
        .assume_offset(istanbul)
        .to_offset(UtcOffset::UTC);
    let post = json!({"format":"feed_post","capability_id":f.slot.capability_id,
        "publish_at":at.format(&Rfc3339).unwrap(),"material_ids":[request["material_ids"][0]],
        "subject":request["hints"]["subject"],"hypothesis_id":f.slot.chain.hypothesis_id});
    expect_error(
        p.send(
            Method::POST,
            &proposal,
            Some(&owner),
            Some(json!({"request_id":id,"request_key":"p","posts":[post]})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let mut reel = post.clone();
    reel["format"] = json!("reel");
    let body = expect_error(
        p.send(
            Method::POST,
            &proposal,
            Some(&owner),
            Some(json!({"request_key":"refused","posts":[post, reel]})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["reason"], "package_refused");
    assert_eq!(
        body["details"]["items"],
        json!([{"index":1,"reason":"format_unsupported"}])
    );
    let out = ok_json(
        p.send(
            Method::POST,
            &proposal,
            Some(&owner),
            Some(json!({"request_key":"package","posts":[post]})),
        )
        .await,
    )
    .await;
    assert_eq!(out["request"]["status"], "answered");
    let slot = out["posts"][0]["slot"]["id"].clone();
    assert_eq!(out["posts"][0]["slot"]["state"], "planned");
    let body = expect_error(
        p.send(
            Method::POST,
            &proposal,
            Some(&owner),
            Some(json!({"request_key":"again","posts":[post]})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    assert_eq!(body["details"]["reason"], "request_not_open");

    let posts = ok_json(p.get("/api/studio/posts", &owner).await).await;
    assert_eq!(posts["posts"][0]["slot"]["id"], slot);
    assert_eq!(posts["posts"][0]["post"]["format"], "feed_post");
    let monday = day - Duration::days(i64::from(day.weekday().number_days_from_monday()));
    let week = ok_json(
        p.get(&format!("/api/studio/summary?week={monday}"), &owner)
            .await,
    )
    .await;
    assert_eq!(week["planned"][0]["slot_id"], slot);
    expect_error(
        p.get(
            &format!("/api/studio/summary?week={}", monday + Duration::days(1)),
            &owner,
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    // The posting policy: the owner's in person, a rep's never.
    let settings = json!({"policy":{"floor_days":2},"tz":"Europe/Istanbul"});
    let saved = ok_json(
        p.send(
            Method::PUT,
            "/api/studio/posting-policy",
            Some(&owner),
            Some(settings.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(saved["policy"]["floor_days"], 2);
    assert_eq!(saved["policy"]["debounce_minutes"], 30);
    let again = ok_json(p.get("/api/studio/posts", &owner).await).await;
    assert_eq!(again["settings"]["policy"]["floor_days"], 2);
    expect_error(
        p.send(
            Method::PUT,
            "/api/studio/posting-policy",
            Some(&owner),
            Some(json!({"policy":{},"tz":"Mars/Olympus"})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let (rep, _) = p.join(&owner, "rep@posts.example", "rep").await;
    expect_error(
        p.send(
            Method::PUT,
            "/api/studio/posting-policy",
            Some(&rep),
            Some(settings),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
}
