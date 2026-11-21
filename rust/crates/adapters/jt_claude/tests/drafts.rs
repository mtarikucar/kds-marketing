//! The first-message drafts against an in-process mock on 127.0.0.1: the request's shape (the
//! one forced `draft` tool, the cache breakpoint on the workspace's part, the prospect as the one
//! user turn, no sampling parameter) and how answers map. Never reaches the real endpoint.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::ports::draft_model::{DraftModel, DraftRequest, DraftShape, ModelError};
use jt_claude::{ApiKey, ClaudeBases, ClaudeModel, DEFAULT_MODEL};
use jt_outbound::{Egress, FIXED_HOSTS, Url};
use serde_json::Value;
use tokio::net::TcpListener;

const KEY: &str = "sk-ant-api03-TEST-draft-key";

#[derive(Clone, Default)]
struct Seen {
    bodies: Arc<Mutex<Vec<(HeaderMap, String)>>>,
    reply: Arc<Mutex<(u16, &'static str)>>,
}

async fn handle(State(seen): State<Seen>, headers: HeaderMap, body: Bytes) -> Response {
    seen.bodies
        .lock()
        .unwrap()
        .push((headers, String::from_utf8_lossy(&body).into_owned()));
    let (status, body) = *seen.reply.lock().unwrap();
    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

async fn mock(status: u16, body: &'static str) -> (ClaudeModel, Seen) {
    let seen = Seen::default();
    *seen.reply.lock().unwrap() = (status, body);
    let app = Router::new().fallback(handle).with_state(seen.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let egress =
        Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("anthropic", addr.to_string())]));
    let bases = ClaudeBases {
        anthropic: Url::parse(&format!("http://{addr}/")).unwrap(),
    };
    let model = ClaudeModel::new(egress, bases, ApiKey::new(KEY.into()), DEFAULT_MODEL).unwrap();
    (model, seen)
}

fn request(shape: DraftShape) -> DraftRequest {
    DraftRequest {
        system_fixed: "FIXED".into(),
        system_workspace: "# Rules: never break them\n- No discounts".into(),
        prospect: "# The prospect\nName: Örnek Kafe".into(),
        shape,
        max_tokens: 1024,
    }
}

const EMAIL: &str = r#"{"content":[{"type":"thinking","thinking":""},{"type":"tool_use","id":"t1","name":"draft","input":{"subject":"Tanışma","body":"Merhaba,\n\nKısa bir tanışma.\n\nAlfa"}}],"stop_reason":"tool_use","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}"#;

#[tokio::test]
async fn a_draft_request_has_one_forced_strict_tool_and_the_prospect_as_its_one_turn() {
    let (model, seen) = mock(200, EMAIL).await;
    let answer = DraftModel::draft(&model, &request(DraftShape::Email))
        .await
        .unwrap();
    let draft = answer.draft.unwrap();
    assert_eq!(draft.subject.as_deref(), Some("Tanışma"));
    assert!(draft.body.starts_with("Merhaba,"));
    // $0.10 per million input tokens and $0.50 per million output tokens.
    assert_eq!(answer.usage.cost_micro_usd, 150);
    let (headers, raw) = seen.bodies.lock().unwrap()[0].clone();
    assert_eq!(headers["x-api-key"], KEY);
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["model"], DEFAULT_MODEL);
    assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    assert_eq!(body["tools"][0]["name"], "draft");
    assert_eq!(body["tools"][0]["strict"], true);
    assert_eq!(body["tool_choice"]["type"], "any");
    assert_eq!(body["system"][0]["text"], "FIXED");
    assert_eq!(body["system"][1]["cache_control"]["type"], "ephemeral");
    assert!(
        body["system"][1]["text"]
            .as_str()
            .unwrap()
            .contains("No discounts"),
        "the prohibitions reach the request"
    );
    let messages = body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
    assert!(
        messages[0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Örnek Kafe")
    );
    for key in ["temperature", "top_p", "top_k", "thinking"] {
        assert!(body.get(key).is_none(), "{key}");
    }
}

#[tokio::test]
async fn a_short_message_has_no_subject_and_a_cut_or_refused_answer_no_draft() {
    let (model, _) = mock(200, EMAIL).await;
    let short = DraftModel::draft(&model, &request(DraftShape::Short))
        .await
        .unwrap();
    assert_eq!(short.draft.unwrap().subject, None);
    let (cut, _) = mock(
        200,
        r#"{"content":[{"type":"tool_use","id":"t1","name":"draft","input":{"subject":"","body":"Merh"}}],"stop_reason":"max_tokens","usage":{"input_tokens":10,"output_tokens":1024}}"#,
    )
    .await;
    assert!(
        DraftModel::draft(&cut, &request(DraftShape::Short))
            .await
            .unwrap()
            .draft
            .is_none()
    );
    let (refused, _) = mock(
        200,
        r#"{"content":[],"stop_reason":"refusal","usage":{"input_tokens":10,"output_tokens":1}}"#,
    )
    .await;
    assert!(
        DraftModel::draft(&refused, &request(DraftShape::Email))
            .await
            .unwrap()
            .draft
            .is_none()
    );
    let (limited, _) = mock(429, r#"{"type":"error"}"#).await;
    assert!(matches!(
        DraftModel::draft(&limited, &request(DraftShape::Email)).await,
        Err(ModelError::RateLimited { .. })
    ));
}
