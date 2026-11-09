//! The materials library's routes (spec 2026-11-03 §5.2) end to end through Postgres: they answer
//! a workspace with no approved strategy (D35), take their ids from the path (an id in the body is
//! `422`), keep the use cases' refusals (`404`, `409`, `422`), serve the human decisions (D4) to
//! the owner's session, and refuse a rep without `studio.work`.

use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error, ok_json, workspace_of};
use serde_json::json;

#[tokio::test]
async fn olays_calendar_and_the_shoot_list_answer_without_a_strategy() {
    let p = Panel::new().await;
    let (owner, _) = p.register("owner@materials.example", "Materials").await;
    let olay = ok_json(
        p.send(
            Method::POST,
            "/api/studio/olays",
            Some(&owner),
            Some(
                json!({"request_key":"o1","kind":"workshop","title":"Atölye",
                "starts_on":"2026-11-16","ends_on":"2026-11-16"}),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(olay["status"], "confirmed");
    let id = olay["id"].as_str().unwrap().to_owned();
    let path = format!("/api/studio/olays/{id}");
    let patched = ok_json(
        p.send(
            Method::PATCH,
            &path,
            Some(&owner),
            Some(json!({"expected_revision":1,"place":"Moda"})),
        )
        .await,
    )
    .await;
    assert_eq!(
        (patched["place"].clone(), patched["revision"].clone()),
        (json!("Moda"), json!(2))
    );
    expect_error(
        p.send(
            Method::PATCH,
            &path,
            Some(&owner),
            Some(json!({"olay_id":id,"expected_revision":2,"title":"x"})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let body = expect_error(
        p.send(
            Method::POST,
            &format!("{path}/confirm"),
            Some(&owner),
            Some(json!({"expected_revision":2})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    assert_eq!(body["details"]["reason"], "already_confirmed");
    let list = ok_json(p.get("/api/studio/olays?status=confirmed", &owner).await).await;
    assert_eq!(list[0]["olay"]["id"], id.as_str());
    let got = ok_json(p.get(&path, &owner).await).await;
    assert_eq!(got["olay"]["id"], id.as_str());
    assert_eq!(got["materials"], json!([]));
    expect_error(
        p.get(
            &format!("/api/studio/olays/{}", uuid::Uuid::from_u128(1)),
            &owner,
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;

    // The calendar: a lunar holiday waits for its dates; the owner enters them.
    let calendar = ok_json(p.get("/api/studio/calendar?year=2027", &owner).await).await;
    let ramazan = |c: &serde_json::Value| {
        c["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["key"] == "ramazan_bayrami")
            .cloned()
            .unwrap()
    };
    assert_eq!(ramazan(&calendar)["window_start"], serde_json::Value::Null);
    ok_json(
        p.send(
            Method::PUT,
            "/api/studio/calendar/ramazan_bayrami/2027",
            Some(&owner),
            Some(json!({"name":"Ramazan Bayramı","kind":"special_day",
                "window_start":"2027-02-26","window_end":"2027-03-12","enabled":true})),
        )
        .await,
    )
    .await;
    ok_json(
        p.send(
            Method::PUT,
            "/api/studio/materials/policy",
            Some(&owner),
            Some(json!({"lead_days":30,"reuse_days":7,"recap_days":60})),
        )
        .await,
    )
    .await;
    let calendar = ok_json(p.get("/api/studio/calendar?year=2027", &owner).await).await;
    assert_eq!(ramazan(&calendar)["window_start"], "2027-02-26");
    assert_eq!(calendar["policy"]["lead_days"], 30);
    expect_error(
        p.send(
            Method::PUT,
            "/api/studio/calendar/ramazan_bayrami/2027",
            Some(&owner),
            Some(json!({"year":2027,"name":"x","kind":"special_day","enabled":true})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;

    // The shoot list.
    let asked = ok_json(
        p.send(
            Method::POST,
            "/api/studio/shoot-requests",
            Some(&owner),
            Some(json!({"request_key":"s1","text":"Ürün fotoğrafı yükle"})),
        )
        .await,
    )
    .await;
    assert_eq!(asked["key"], "human:s1");
    let open = ok_json(p.get("/api/studio/shoot-requests", &owner).await).await;
    assert_eq!(open[0]["id"], asked["id"]);
    let done = ok_json(
        p.send(
            Method::POST,
            &format!(
                "/api/studio/shoot-requests/{}/resolve",
                asked["id"].as_str().unwrap()
            ),
            Some(&owner),
            Some(json!({"status":"done"})),
        )
        .await,
    )
    .await;
    assert_eq!(done["status"], "done");
    expect_error(
        p.get(
            &format!("/api/studio/slots/{}/materials", uuid::Uuid::from_u128(2)),
            &owner,
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;

    // A rep has no `studio.work`.
    let (rep, _) = p.join(&owner, "rep@materials.example", "rep").await;
    expect_error(
        p.get("/api/studio/olays", &rep).await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
}

#[tokio::test]
async fn a_materials_routes_carry_the_owners_decisions() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@library.example", "Library").await;
    let ws = workspace_of(&me);
    let m = jt_testkit::studio_contract::seed_material(&p.uow, ws).await;
    let path = format!("/api/studio/materials/{}", m.id);
    let listed = ok_json(p.get("/api/studio/materials", &owner).await).await;
    assert_eq!(listed[0]["id"], json!(m.id));
    let detail = ok_json(p.get(&path, &owner).await).await;
    assert_eq!(detail["used_in"], json!([]));
    let steps = [
        (
            Method::PATCH,
            "/tags",
            json!({"expected_revision":1,"doors":["ortaklik"]}),
        ),
        (
            Method::PUT,
            "/permission",
            json!({"expected_revision":2,"permission":"product_only"}),
        ),
        (
            Method::POST,
            "/free",
            json!({"expected_revision":3,"free":true}),
        ),
        (
            Method::POST,
            "/bind",
            json!({"expected_revision":4,"binding":{"kind":"genel"}}),
        ),
    ];
    for (method, suffix, body) in steps {
        ok_json(
            p.send(method, &format!("{path}{suffix}"), Some(&owner), Some(body))
                .await,
        )
        .await;
    }
    let now = ok_json(p.get(&path, &owner).await).await;
    let material = &now["material"];
    assert_eq!(material["tags"]["doors"], json!(["ortaklik"]));
    assert_eq!(material["share"]["permission"], "product_only");
    assert_eq!(material["binding"], json!({"kind":"genel"}));
    assert!(material["freed"].is_object());
    // A material id in the body, an unfreeing of a real genel material, a stale revision.
    expect_error(
        p.send(
            Method::POST,
            &format!("{path}/free"),
            Some(&owner),
            Some(json!({"material_id":m.id,"expected_revision":5,"free":false})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let body = expect_error(
        p.send(
            Method::POST,
            &format!("{path}/free"),
            Some(&owner),
            Some(json!({"expected_revision":5,"free":false})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    assert_eq!(body["details"]["reason"], "genel_stays_freed");
    expect_error(
        p.send(
            Method::PUT,
            &format!("{path}/permission"),
            Some(&owner),
            Some(json!({"expected_revision":1,"permission":"shareable"})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    // Deleting asks for the confirmation, then redacts.
    expect_error(
        p.send(
            Method::POST,
            &format!("{path}/delete"),
            Some(&owner),
            Some(json!({"expected_revision":5})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let gone = ok_json(
        p.send(
            Method::POST,
            &format!("{path}/delete"),
            Some(&owner),
            Some(json!({"expected_revision":5,"confirm":true})),
        )
        .await,
    )
    .await;
    assert!(gone["erased_at"].is_string());
    let erased = ok_json(p.get("/api/studio/materials?state=erased", &owner).await).await;
    assert_eq!(erased[0]["id"], json!(m.id));
    // Adding a file the workspace does not have.
    expect_error(
        p.send(
            Method::POST,
            "/api/studio/materials",
            Some(&owner),
            Some(
                json!({"request_key":"none","file_id":uuid::Uuid::from_u128(3),
                "origin":{"kind":"real"},"genel":true,"share":"shareable"}),
            ),
        )
        .await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
}

/// Releasing a slot's caption findings (spec §7, D19): behind the strategy gate as the slot's
/// other writes, the slot id from the path, the owner's in person; a rep may not.
#[tokio::test]
async fn a_slots_caption_findings_are_released_by_the_owner() {
    let p = Panel::new().await;
    let (owner, me) = p.register("owner@truth.example", "Truth").await;
    let release = |slot: String| format!("/api/studio/slots/{slot}/material-check/release");
    let zeros = "0".repeat(64);
    expect_error(
        p.send(
            Method::POST,
            &release(uuid::Uuid::from_u128(9).to_string()),
            Some(&owner),
            Some(json!({"expected_revision":1,"digest":zeros})),
        )
        .await,
        StatusCode::CONFLICT,
        "STRATEGY_REQUIRED",
    )
    .await;

    // An approved strategy, a Ready slot whose piece ("hello") shows a material, and another
    // confirmed olay its text names.
    let ws = workspace_of(&me);
    let user: jt_tenancy::UserId = me["user_id"].as_str().unwrap().parse().unwrap();
    let f = jt_testkit::studio_contract::ready_in(&p.uow, ws, user).await;
    let other = jt_app::ports::materials::Olay {
        title: "Hello".into(),
        ..jt_testkit::studio_contract::confirmed_olay(ws)
    };
    {
        use jt_app::ports::UnitOfWork;
        let mut r = p.uow.tenant(ws).await.unwrap();
        r.studio_materials()
            .insert_olay(other.clone())
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    let slot = ok_json(
        p.get(&format!("/api/studio/slots/{}", f.slot.id), &owner)
            .await,
    )
    .await;
    let check = &slot["material_check"];
    assert_eq!(check["findings"][0]["code"], "names_other_olay");
    assert_eq!(check["findings"][0]["olay_id"], json!(other.id));
    assert_eq!(
        (check["released"].clone(), check["holds"].clone()),
        (json!(false), json!(true))
    );
    let digest = check["digest"].as_str().unwrap().to_owned();
    let path = release(f.slot.id.to_string());
    expect_error(
        p.send(
            Method::POST,
            &path,
            Some(&owner),
            Some(json!({"slot_id":f.slot.id,"expected_revision":1,"digest":digest})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let body = expect_error(
        p.send(
            Method::POST,
            &path,
            Some(&owner),
            Some(json!({"expected_revision":1,"digest":zeros})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    assert_eq!(body["details"]["reason"], "findings_changed");
    let (rep, _) = p.join(&owner, "rep@truth.example", "rep").await;
    expect_error(
        p.send(
            Method::POST,
            &path,
            Some(&rep),
            Some(json!({"expected_revision":1,"digest":digest})),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let out = ok_json(
        p.send(
            Method::POST,
            &path,
            Some(&owner),
            Some(json!({"expected_revision":1,"digest":digest})),
        )
        .await,
    )
    .await;
    assert_eq!(out["material_check"]["released"], true);
    assert_eq!(out["material_check"]["holds"], false);
    let again = ok_json(
        p.get(&format!("/api/studio/slots/{}", f.slot.id), &owner)
            .await,
    )
    .await;
    assert_eq!(again["material_check"]["released"], true);
}

#[tokio::test]
async fn intelligence_preview_retry_and_production_routes_are_tenant_and_role_scoped() {
    use jt_testkit::fakes::files::MemoryFiles;
    use std::sync::Arc;
    let mut p = Panel::new().await;
    p.deps.files = Arc::new(MemoryFiles::default());
    p.app = jt_panel_http::router(jt_panel_http::AppState {
        deps: p.deps.clone(),
        gate: Arc::new(jt_pg::PgStrategyGate::new(p.db.pool.clone())),
        cookie_secure: false,
        panel_dir: None,
    });
    let (owner, me) = p
        .register("owner@intelligence.example", "Intelligence")
        .await;
    let ws = workspace_of(&me);
    let source =
        jt_testkit::studio_contract::stored_material(&p.uow, p.deps.files.as_ref(), ws).await;
    let base = format!("/api/studio/materials/{}", source.id);
    let got = ok_json(p.get(&format!("{base}/intelligence"), &owner).await).await;
    assert_eq!(got["material"]["id"], json!(source.id));
    assert_eq!(got["intelligence"]["status"], "pending");
    assert!(got.get("claim_token").is_none());
    let all = ok_json(p.get("/api/studio/material-intelligence", &owner).await).await;
    assert_eq!(all[0]["material"]["id"], json!(source.id));
    let edited=ok_json(p.send(Method::PATCH,&format!("{base}/intelligence"),Some(&owner),Some(json!({"expected_revision":1,"description":"Owner description","group_name":"Workshop"}))).await).await;
    assert_eq!(edited["material"]["revision"], 2);
    assert_eq!(edited["intelligence"]["description"], "Owner description");
    assert_eq!(edited["intelligence"]["group_name"], "Workshop");
    let retry = format!("{base}/analysis/retry");
    expect_error(
        p.send(
            Method::POST,
            &retry,
            Some(&owner),
            Some(json!({"expected_revision":1})),
        )
        .await,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    expect_error(
        p.send(
            Method::POST,
            &retry,
            Some(&owner),
            Some(json!({"material_id":source.id,"expected_revision":2})),
        )
        .await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let retried = ok_json(
        p.send(
            Method::POST,
            &retry,
            Some(&owner),
            Some(json!({"expected_revision":2})),
        )
        .await,
    )
    .await;
    assert_eq!(retried["intelligence"]["status"], "pending");
    let preview = ok_json(p.get(&format!("{base}/preview"), &owner).await).await;
    assert!(
        preview["url"]
            .as_str()
            .unwrap()
            .contains("files.example.com")
    );
    assert!(preview["expires_at"].is_string());
    let (other, _) = p.register("other@intelligence.example", "Other").await;
    for suffix in ["intelligence", "preview"] {
        expect_error(
            p.get(&format!("{base}/{suffix}"), &other).await,
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
        )
        .await;
    }
    let (rep, _) = p.join(&owner, "rep@intelligence.example", "rep").await;
    for path in [
        format!("{base}/intelligence"),
        format!("{base}/preview"),
        "/api/studio/material-intelligence".into(),
        "/api/studio/material-productions".into(),
    ] {
        expect_error(p.get(&path, &rep).await, StatusCode::FORBIDDEN, "FORBIDDEN").await;
    }
    expect_error(
        p.send(
            Method::POST,
            &retry,
            Some(&rep),
            Some(json!({"expected_revision":2})),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    // Creating requests is an owner/manager decision; there is no panel lease endpoint.
    let request = json!({"request_key":"poster","kind":"poster","instructions":"Make a square poster","sources":[{"material_id":source.id,"expected_revision":2}]});
    expect_error(
        p.send(
            Method::POST,
            "/api/studio/material-productions",
            Some(&rep),
            Some(request.clone()),
        )
        .await,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let production = ok_json(
        p.send(
            Method::POST,
            "/api/studio/material-productions",
            Some(&owner),
            Some(request.clone()),
        )
        .await,
    )
    .await;
    assert_eq!(production["status"], "pending");
    assert!(production.get("claim_token").is_none());
    let replay = ok_json(
        p.send(
            Method::POST,
            "/api/studio/material-productions",
            Some(&owner),
            Some(request),
        )
        .await,
    )
    .await;
    assert_eq!(replay["id"], production["id"]);
    let listed = ok_json(
        p.get(
            &format!(
                "/api/studio/material-productions?source_material_id={}",
                source.id
            ),
            &owner,
        )
        .await,
    )
    .await;
    assert_eq!(listed[0]["id"], production["id"]);
    let empty = ok_json(p.get("/api/studio/material-productions", &other).await).await;
    assert_eq!(empty, json!([]));
    let response = p
        .send(
            Method::POST,
            &format!("{base}/analysis/claim"),
            Some(&owner),
            Some(json!({"expected_revision":2})),
        )
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
