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
