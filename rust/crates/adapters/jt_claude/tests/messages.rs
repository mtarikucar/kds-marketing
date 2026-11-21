//! The model adapter against an in-process mock on 127.0.0.1: what a request sends (headers, the
//! body's shape, the cache breakpoints, no sampling parameters) and how each answer maps. Never
//! reaches the real endpoint.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use jt_app::ports::reply_model::{
    JudgeRequest, ModelError, ModelRequest, ModelStop, ModelTool, Part, ReplyModel, Speaker, Turn,
};
use jt_claude::{ApiKey, ClaudeBases, ClaudeModel, DEFAULT_MODEL};
use jt_outbound::{Egress, FIXED_HOSTS, Url};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const KEY: &str = "sk-ant-api03-TEST-key-never-logged";

type Reply = (u16, Vec<(&'static str, &'static str)>, &'static str);

#[derive(Clone, Default)]
struct Seen {
    requests: Arc<Mutex<Vec<(String, HeaderMap, String)>>>,
    reply: Arc<Mutex<Reply>>,
}

async fn handle(State(seen): State<Seen>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    seen.requests.lock().unwrap().push((
        uri.path().to_owned(),
        headers,
        String::from_utf8_lossy(&body).into_owned(),
    ));
    let (status, extra, body) = seen.reply.lock().unwrap().clone();
    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert("request-id", "req_01TESTMOCK".parse().unwrap());
    for (k, v) in extra {
        response.headers_mut().insert(k, v.parse().unwrap());
    }
    response
}

async fn mock(
    status: u16,
    extra: Vec<(&'static str, &'static str)>,
    body: &'static str,
) -> (ClaudeModel, Seen) {
    let seen = Seen::default();
    *seen.reply.lock().unwrap() = (status, extra, body);
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

fn text(t: &str) -> Part {
    Part::Text { text: t.into() }
}

fn request() -> ModelRequest {
    ModelRequest {
        system_fixed: "Fixed instructions.".into(),
        system_workspace: "# The business\nName: Test Atölye\n".into(),
        history: vec![
            Turn {
                speaker: Speaker::Customer,
                parts: vec![text("Merhaba"), text("Bir figür istiyorum")],
            },
            Turn {
                speaker: Speaker::Business,
                parts: vec![text("Hoş geldiniz! Kaç kişilik?")],
            },
            Turn {
                speaker: Speaker::Customer,
                parts: vec![text("Tek kişi")],
            },
        ],
        max_tokens: 2048,
    }
}

#[tokio::test]
async fn a_request_sends_the_documented_headers_and_body() {
    let (model, seen) = mock(
        200,
        vec![],
        include_str!("fixtures/messages_tool_use_200.json"),
    )
    .await;
    let answer = model.answer(&request()).await.unwrap();
    assert_eq!(answer.stop, ModelStop::ToolUse);
    assert_eq!(
        answer.tool,
        Some(ModelTool::Quote {
            amount: 1250,
            basis: "one small piece, unpainted".into(),
            text: "Teklifimiz 1.250 TL.".into(),
        })
    );
    assert_eq!(answer.usage.input_tokens, 120);
    assert_eq!(answer.usage.cache_write_tokens, 900);
    assert_eq!(answer.usage.output_tokens, 80);
    // 120 x 100 + 80 x 500 + 900 x 125 nano-dollars, rounded up to micro-dollars.
    assert_eq!(answer.usage.cost_micro_usd, 165);

    let requests = seen.requests.lock().unwrap();
    let (path, headers, body) = &requests[0];
    assert_eq!(path, "/v1/messages");
    assert_eq!(headers["x-api-key"], KEY);
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(headers["content-type"], "application/json");
    assert!(headers.get("authorization").is_none());
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["model"], "claude-haiku-5-5");
    assert_eq!(body["max_tokens"], 2048);
    assert_eq!(body["output_config"], json!({ "effort": "low" }));
    assert_eq!(
        body["tool_choice"],
        json!({ "type": "any", "disable_parallel_tool_use": true })
    );
    for absent in ["temperature", "top_p", "top_k", "thinking"] {
        assert!(body.get(absent).is_none(), "{absent} is never sent");
    }
    // The system: the fixed part, then the workspace's with the first cache breakpoint.
    assert_eq!(
        body["system"][0],
        json!({"type": "text", "text": "Fixed instructions."})
    );
    assert_eq!(
        body["system"][1]["cache_control"],
        json!({"type": "ephemeral"})
    );
    // The tools: strict, closed, every property required.
    let tools = body["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["reply", "quote", "hand_over"]);
    for t in tools {
        assert_eq!(t["strict"], true);
        let schema = &t["input_schema"];
        assert_eq!(schema["additionalProperties"], false);
        let props: Vec<&String> = schema["properties"].as_object().unwrap().keys().collect();
        let required: Vec<&str> = schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap())
            .collect();
        assert_eq!(props.len(), required.len());
    }
    // The turns: user, assistant, user; the last block holds the second breakpoint, and no
    // assistant turn comes last (no prefill).
    let messages = body["messages"].as_array().unwrap();
    let roles: Vec<&str> = messages
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["user", "assistant", "user"]);
    assert_eq!(messages[0]["content"].as_array().unwrap().len(), 2);
    assert!(messages[0]["content"][1].get("cache_control").is_none());
    assert_eq!(
        messages[2]["content"][0],
        json!({"type": "text", "text": "Tek kişi", "cache_control": {"type": "ephemeral"}})
    );
}

#[tokio::test]
async fn a_refusal_a_cut_answer_and_a_plain_text_answer_carry_no_tool() {
    for (fixture, stop) in [
        (
            include_str!("fixtures/messages_refusal_200.json"),
            ModelStop::Refusal,
        ),
        (
            include_str!("fixtures/messages_max_tokens_200.json"),
            ModelStop::MaxTokens,
        ),
        (
            include_str!("fixtures/messages_no_tool_200.json"),
            ModelStop::NoTool,
        ),
    ] {
        let (model, _) = mock(200, vec![], fixture).await;
        let answer = model.answer(&request()).await.unwrap();
        assert_eq!(answer.stop, stop);
        assert_eq!(answer.tool, None);
    }
    let (model, _) = mock(
        200,
        vec![],
        include_str!("fixtures/messages_refusal_200.json"),
    )
    .await;
    let answer = model.answer(&request()).await.unwrap();
    assert_eq!(answer.usage.cache_read_tokens, 900);
}

#[tokio::test]
async fn a_429_carries_its_retry_after_and_a_5xx_is_an_outage() {
    let (model, _) = mock(
        429,
        vec![("retry-after", "12")],
        include_str!("fixtures/messages_429.json"),
    )
    .await;
    assert_eq!(
        model.answer(&request()).await,
        Err(ModelError::RateLimited {
            retry_after: Some(time::Duration::seconds(12))
        })
    );
    let (model, _) = mock(500, vec![], include_str!("fixtures/messages_500.json")).await;
    assert_eq!(
        model.answer(&request()).await,
        Err(ModelError::Unavailable { status: Some(500) })
    );
    let (model, _) = mock(401, vec![], "{}").await;
    assert_eq!(
        model.answer(&request()).await,
        Err(ModelError::Rejected { status: Some(401) })
    );
}

#[test]
fn an_unknown_model_is_refused() {
    let egress = Arc::new(Egress::new(FIXED_HOSTS));
    assert!(
        ClaudeModel::new(
            egress,
            ClaudeBases::production(),
            ApiKey::new(KEY.into()),
            "claude-unknown-1"
        )
        .is_none()
    );
}

fn judge_request() -> JudgeRequest {
    JudgeRequest {
        system: "Check the text.".into(),
        cards: "Ürünler: el yapımı figür.".into(),
        facts: "This message is not a quote.".into(),
        text: "Merhaba, figürünüz hazır.".into(),
        max_tokens: 1024,
    }
}

#[tokio::test]
async fn a_check_sends_one_strict_forced_tool_and_reads_its_verdict() {
    let (model, seen) = mock(200, vec![], include_str!("fixtures/judge_allowed_200.json")).await;
    let verdict = model.judge(&judge_request()).await.unwrap();
    assert_eq!(verdict.allowed, Some(true));
    assert_eq!(verdict.usage.input_tokens, 80);
    let requests = seen.requests.lock().unwrap();
    let body: Value = serde_json::from_str(&requests[0].2).unwrap();
    assert_eq!(body["output_config"], json!({ "effort": "low" }));
    assert_eq!(body["max_tokens"], 1024);
    assert_eq!(body["tools"][0]["name"], "verdict");
    assert_eq!(body["tools"][0]["strict"], true);
    assert_eq!(
        body["tools"][0]["input_schema"]["additionalProperties"],
        false
    );
    assert_eq!(body["tool_choice"]["type"], "any");
    assert_eq!(
        body["system"][1]["cache_control"],
        json!({"type": "ephemeral"})
    );
    assert_eq!(body["system"][2]["text"], "This message is not a quote.");
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(
        body["messages"][0]["content"][0]["text"],
        "Merhaba, figürünüz hazır."
    );
    assert!(body.get("temperature").is_none());
}

#[tokio::test]
async fn a_refused_or_tool_less_check_has_no_verdict() {
    for fixture in [
        include_str!("fixtures/messages_refusal_200.json"),
        include_str!("fixtures/messages_no_tool_200.json"),
        include_str!("fixtures/messages_max_tokens_200.json"),
    ] {
        let (model, _) = mock(200, vec![], fixture).await;
        assert_eq!(model.judge(&judge_request()).await.unwrap().allowed, None);
    }
    let (model, _) = mock(500, vec![], include_str!("fixtures/messages_500.json")).await;
    assert!(model.judge(&judge_request()).await.is_err());
}
