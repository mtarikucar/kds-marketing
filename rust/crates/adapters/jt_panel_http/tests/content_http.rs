use axum::http::{Method, StatusCode};
use jt_testkit::panel::{Panel, expect_error};
#[tokio::test]
async fn content_routes_require_authentication_including_redo() {
    let p = Panel::new().await;
    for suffix in [
        "claim",
        "progress",
        "release",
        "delivery",
        "redo",
        "delivery/accept",
    ] {
        expect_error(
            p.send(
                Method::POST,
                &format!("/api/content/areas/00000000-0000-0000-0000-000000000001/{suffix}"),
                None,
                Some(serde_json::json!({})),
            )
            .await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
}

/// The content page's reads (design 2026-11-18 §5): a person's drop waits in the analysis queue,
/// the tree counts it, the production line filters by olay (or `genel`) with each area's
/// pipeline, and an olay reads in one call; another workspace's olay is not found.
#[tokio::test]
async fn the_page_reads_its_tree_queue_line_and_olay() {
    use jt_testkit::fakes::files::MemoryFiles;
    use jt_testkit::panel::ok_json;
    use serde_json::json;
    use std::sync::Arc;
    // Files kept in memory, so an upload's bytes can be read back for its capture time.
    let mut p = Panel::new().await;
    p.deps.files = Arc::new(MemoryFiles::default());
    p.app = jt_panel_http::router(jt_panel_http::AppState {
        deps: p.deps.clone(),
        gate: Arc::new(jt_testkit::fakes::ModulesReadyGate(Arc::new(
            jt_pg::PgStrategyGate::new(p.db.pool.clone()),
        ))),
        cookie_secure: false,
        panel_dir: None,
    });
    for path in [
        "/api/content/tree",
        "/api/content/analysis-queue",
        "/api/content/areas",
        "/api/content/olays/genel",
    ] {
        expect_error(
            p.send(Method::GET, path, None, None).await,
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
        )
        .await;
    }
    let (a, _) = p.register("content-page-a@example.test", "A").await;
    let (b, _) = p.register("content-page-b@example.test", "B").await;
    let file = ok_json(
        p.send(
            Method::POST,
            "/api/studio/files",
            Some(&a),
            Some(
                json!({"request_key":"drop-file","filename":"a.png","mime":"image/png",
                "content":{"kind":"bytes_base64","data":"iVBORw0KGgpkcm9w"}}),
            ),
        )
        .await,
    )
    .await;
    let dropped = ok_json(
        p.send(
            Method::POST,
            "/api/studio/materials",
            Some(&a),
            Some(json!({"request_key":"drop","file_id":file["id"],"origin":{"kind":"real"}})),
        )
        .await,
    )
    .await;
    assert_eq!(dropped["material"]["binding"], json!({"kind":"unfiled"}));
    let queue = ok_json(p.get("/api/content/analysis-queue", &a).await).await;
    assert_eq!(
        queue["items"][0]["material"]["id"],
        dropped["material"]["id"]
    );
    assert_eq!(queue["items"][0]["stage"], "waiting");
    assert_eq!(queue["items"][0]["unfiled"], true);
    let olay = ok_json(
        p.send(
            Method::POST,
            "/api/studio/olays",
            Some(&a),
            Some(
                json!({"request_key":"olay","kind":"workshop","title":"Atölye",
                "starts_on":"2026-11-16","ends_on":"2026-11-16"}),
            ),
        )
        .await,
    )
    .await;
    let olay_id = olay["id"].as_str().unwrap();
    let area = ok_json(
        p.send(
            Method::POST,
            "/api/studio/projects",
            Some(&a),
            Some(json!({"request_key":"area","brief":"Atölyeden bir gün","olay_id":olay_id})),
        )
        .await,
    )
    .await;
    assert_eq!(area["olay_id"], olay_id);
    let tree = ok_json(p.get("/api/content/tree", &a).await).await;
    assert_eq!(tree["analysis_queue"], 1);
    assert_eq!(tree["areas"], 1);
    assert_eq!(tree["genel"]["files"], 0);
    let node = tree["olays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["olay"]["id"] == olay_id)
        .unwrap()
        .clone();
    assert_eq!(node["areas"], 1);
    assert!(tree["upcoming"].is_array());
    assert_eq!(tree["waiting"]["olay_confirmations"], 0);
    let line = ok_json(
        p.get(&format!("/api/content/areas?olay_id={olay_id}"), &a)
            .await,
    )
    .await;
    let rows = line["areas"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["area"]["id"], area["id"]);
    let stages: Vec<&str> = rows[0]["pipeline"]["stages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        stages,
        [
            "hazirlik", "fikir", "metin", "gorsel", "paket", "onay", "yayin", "sonuc"
        ]
    );
    let genel = ok_json(p.get("/api/content/areas?olay_id=genel", &a).await).await;
    assert!(genel["areas"].as_array().unwrap().is_empty());
    expect_error(
        p.get("/api/content/areas?olay_id=nope", &a).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
    let view = ok_json(p.get(&format!("/api/content/olays/{olay_id}"), &a).await).await;
    assert_eq!(view["olay"]["id"], olay_id);
    assert_eq!(view["flow"]["contents"], 1);
    assert_eq!(view["contents"].as_array().unwrap().len(), 1);
    assert!(view["files"].as_array().unwrap().is_empty());
    let view = ok_json(p.get("/api/content/olays/genel", &a).await).await;
    assert!(view["olay"].is_null());
    expect_error(
        p.get(&format!("/api/content/olays/{olay_id}"), &b).await,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    expect_error(
        p.get("/api/content/olays/nope", &a).await,
        StatusCode::UNPROCESSABLE_ENTITY,
        "VALIDATION",
    )
    .await;
}
