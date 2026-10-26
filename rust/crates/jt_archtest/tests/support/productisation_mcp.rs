//! In-process real MCP transport; shared billing test protocol, no provider sockets.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicI64, Ordering};
use tower::ServiceExt;

async fn send(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
}
pub fn mcp(key: &str, session: Option<&str>, body: &Value) -> Request<Body> {
    let mut req = Request::post("/mcp")
        .header(header::HOST, "127.0.0.1")
        .header(header::AUTHORIZATION, format!("Bearer {key}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json, text/event-stream");
    if let Some(session) = session {
        req = req.header("mcp-session-id", session);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

/// The JSON-RPC message with this id in an SSE response body.
async fn sse_message(resp: Response, id: i64) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .find(|message| message["id"] == id)
        .expect("the response message")
}

pub async fn mcp_session(app: &Router, key: &str) -> String {
    let initialize = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "parity-agent", "version": "1.0" },
        },
    });
    let resp = send(app, mcp(key, None, &initialize)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let session = resp.headers()["mcp-session-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(sse_message(resp, 1).await["result"].is_object());
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let resp = send(app, mcp(key, Some(&session), &initialized)).await;
    assert!(resp.status().is_success(), "{}", resp.status());
    session
}

/// The `result` of tool `name` called with `arguments` in `session`, failed or not. Each call
/// has a JSON-RPC id of its own.
pub async fn tool_result(
    app: &Router,
    key: &str,
    session: &str,
    name: &str,
    arguments: Value,
) -> Value {
    static NEXT_ID: AtomicI64 = AtomicI64::new(2);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let call = json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    let resp = send(app, mcp(key, Some(session), &call)).await;
    assert_eq!(resp.status(), StatusCode::OK);
    sse_message(resp, id).await["result"].clone()
}

/// The structured output of tool `name` called with `arguments` in `session`, which must succeed.
pub async fn call_tool(
    app: &Router,
    key: &str,
    session: &str,
    name: &str,
    arguments: Value,
) -> Value {
    let result = tool_result(app, key, session, name, arguments).await;
    assert_ne!(result["isError"], json!(true), "{result}");
    result["structuredContent"].clone()
}
