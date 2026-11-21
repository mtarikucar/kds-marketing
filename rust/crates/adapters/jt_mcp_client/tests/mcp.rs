//! The MCP shop client against an in-process mock on 127.0.0.1: the sequence it sends, the
//! headers, both answer forms and how each failure maps. Never reaches a real shop.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::ports::connectors::Connector;
use jt_app::ports::shop::{ShopCall, ShopClient, ShopError};
use jt_connector::Credential;
use jt_mcp_client::McpClient;
use jt_outbound::{Egress, FIXED_HOSTS, Url};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "mcp-test-token-never-logged";

/// What the mock answers for one request: its status, extra headers, body, and a delay first.
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: String,
    delay: Duration,
}

fn json_reply(body: Value) -> Reply {
    Reply {
        status: 200,
        headers: vec![("content-type", "application/json".into())],
        body: body.to_string(),
        delay: Duration::ZERO,
    }
}

fn status_reply(status: u16) -> Reply {
    Reply {
        status,
        headers: vec![],
        body: String::new(),
        delay: Duration::ZERO,
    }
}

fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

type Script = dyn Fn(&str, &Value) -> Reply + Send + Sync;

#[derive(Clone)]
struct Mock {
    seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
    script: Arc<Script>,
}

async fn handle(State(mock): State<Mock>, headers: HeaderMap, body: Bytes) -> Response {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let method = body["method"].as_str().unwrap_or_default().to_owned();
    let reply = (mock.script)(&method, &body);
    mock.seen.lock().unwrap().push((method, headers, body));
    if !reply.delay.is_zero() {
        tokio::time::sleep(reply.delay).await;
    }
    let mut response = (StatusCode::from_u16(reply.status).unwrap(), reply.body).into_response();
    for (name, value) in reply.headers {
        response.headers_mut().insert(name, value.parse().unwrap());
    }
    response
}

struct Harness {
    client: McpClient,
    ws: WorkspaceId,
    endpoint: Url,
    seen: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
}

impl Harness {
    fn methods(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.0.clone())
            .collect()
    }

    fn header(&self, i: usize, name: &str) -> Option<String> {
        self.seen.lock().unwrap()[i]
            .1
            .get(name)
            .map(|v| v.to_str().unwrap().to_owned())
    }

    fn public(&self) -> Value {
        json!({"endpoint": self.endpoint.as_str(), "workspace_id": self.ws.to_string()})
    }
}

async fn start(script: impl Fn(&str, &Value) -> Reply + Send + Sync + 'static) -> Harness {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mock = Mock {
        seen: seen.clone(),
        script: Arc::new(script),
    };
    let app = Router::new()
        .route("/mcp", axum::routing::post(handle))
        .with_state(mock);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let ws = WorkspaceId::new_v7();
    let egress = Arc::new(Egress::new(FIXED_HOSTS));
    egress.allow_tenant_host(ws, &addr.to_string());
    Harness {
        client: McpClient::new(egress),
        ws,
        endpoint: Url::parse(&format!("http://{addr}/mcp")).unwrap(),
        seen,
    }
}

/// A stateless server: `initialize` and the notification succeed, the tools are `tools`.
fn plain_server(tools: &'static [&'static str]) -> impl Fn(&str, &Value) -> Reply + Send + Sync {
    move |method, body| match method {
        "initialize" => json_reply(result(
            &body["id"],
            json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                   "serverInfo": {"name": "shop", "version": "1"}}),
        )),
        "notifications/initialized" => status_reply(202),
        "tools/list" => json_reply(result(
            &body["id"],
            json!({"tools": tools.iter().map(|t| json!({"name": t, "inputSchema": {}})).collect::<Vec<_>>()}),
        )),
        "tools/call" => json_reply(result(
            &body["id"],
            json!({"content": [{"type": "text", "text": "ok"}], "isError": false}),
        )),
        _ => status_reply(400),
    }
}

fn bearer() -> Credential {
    Credential::Bearer {
        token: TOKEN.into(),
    }
}

fn order_call() -> ShopCall {
    ShopCall {
        tool: "create_order".into(),
        arguments: json!({"email": "someone@example.test"}),
    }
}

#[tokio::test]
async fn a_json_answer_lists_the_tools_with_every_header() {
    let h = start(plain_server(&["call_api_operation", "other"])).await;
    let tools = h.client.list_tools(h.ws, &h.endpoint, &bearer()).await;
    assert_eq!(
        tools,
        Ok(vec!["call_api_operation".to_owned(), "other".to_owned()])
    );
    assert_eq!(
        h.methods(),
        ["initialize", "notifications/initialized", "tools/list"]
    );
    for i in 0..3 {
        assert_eq!(
            h.header(i, "authorization").as_deref(),
            Some("Bearer mcp-test-token-never-logged")
        );
        assert_eq!(
            h.header(i, "mcp-protocol-version").as_deref(),
            Some("2025-06-18")
        );
        assert_eq!(
            h.header(i, "accept").as_deref(),
            Some("application/json, text/event-stream")
        );
        assert!(
            h.header(i, "content-type")
                .unwrap()
                .starts_with("application/json")
        );
        assert_eq!(h.header(i, "mcp-session-id"), None);
    }
    let seen = h.seen.lock().unwrap();
    assert_eq!(
        seen[0].2,
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "jeeta", "version": "1"}}})
    );
    assert_eq!(
        seen[1].2,
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
    );
    assert_eq!(
        seen[2].2,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    );
}

#[tokio::test]
async fn an_event_stream_answer_skips_an_unrelated_event_first() {
    let h = start(|method, body| match method {
        "tools/call" => Reply {
            status: 200,
            headers: vec![("content-type", "text/event-stream; charset=utf-8".into())],
            body: format!(
                "event: message\ndata: {}\n\n: keep-alive\n\nevent: message\ndata: {}\n\n",
                json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}),
                result(
                    &body["id"],
                    json!({"content": [], "structuredContent": {"order_id": "A-1"}})
                ),
            ),
            delay: Duration::ZERO,
        },
        _ => plain_server(&[])(method, body),
    })
    .await;
    let answer = h
        .client
        .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
        .await
        .unwrap();
    assert_eq!(answer["structuredContent"]["order_id"], "A-1");
    let seen = h.seen.lock().unwrap();
    assert_eq!(seen[2].0, "tools/call");
    assert_eq!(
        seen[2].2["params"],
        json!({"name": "create_order", "arguments": {"email": "someone@example.test"}})
    );
}

#[tokio::test]
async fn the_session_id_is_sent_on_the_later_steps() {
    let h = start(|method, body| {
        let mut reply = plain_server(&["call_api_operation"])(method, body);
        if method == "initialize" {
            reply.headers.push(("mcp-session-id", "session-abc".into()));
        }
        reply
    })
    .await;
    h.client
        .list_tools(h.ws, &h.endpoint, &bearer())
        .await
        .unwrap();
    assert_eq!(h.header(0, "mcp-session-id"), None);
    assert_eq!(
        h.header(1, "mcp-session-id").as_deref(),
        Some("session-abc")
    );
    assert_eq!(
        h.header(2, "mcp-session-id").as_deref(),
        Some("session-abc")
    );
}

#[tokio::test]
async fn a_server_refusing_initialize_still_gets_the_call() {
    for status in [400, 404] {
        let h = start(move |method, body| match method {
            "initialize" => status_reply(status),
            _ => plain_server(&[])(method, body),
        })
        .await;
        let answer = h
            .client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await;
        assert!(answer.is_ok(), "{status}: {answer:?}");
        assert_eq!(h.methods(), ["initialize", "tools/call"], "{status}");
    }
}

#[tokio::test]
async fn a_tool_error_is_an_ok_answer() {
    let h = start(|method, body| match method {
        "tools/call" => json_reply(result(
            &body["id"],
            json!({"content": [{"type": "text", "text": "out of stock"}], "isError": true}),
        )),
        _ => plain_server(&[])(method, body),
    })
    .await;
    let answer = h
        .client
        .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
        .await
        .unwrap();
    assert_eq!(answer["isError"], true);
}

#[tokio::test]
async fn a_refused_token_is_auth() {
    let h = start(|_, _| status_reply(401)).await;
    assert_eq!(
        h.client.list_tools(h.ws, &h.endpoint, &bearer()).await,
        Err(ShopError::Auth)
    );
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Auth)
    );
    let h = start(|method, body| match method {
        "tools/call" => status_reply(403),
        _ => plain_server(&[])(method, body),
    })
    .await;
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Auth)
    );
}

#[tokio::test]
async fn a_json_rpc_error_is_rejected_with_its_code() {
    let h = start(|method, body| match method {
        "tools/call" | "tools/list" => json_reply(json!({"jsonrpc": "2.0", "id": body["id"],
            "error": {"code": -32602, "message": "unknown tool"}})),
        _ => plain_server(&[])(method, body),
    })
    .await;
    let rejected = Err(ShopError::Rejected {
        code: Some("-32602".into()),
    });
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        rejected
    );
    assert_eq!(
        h.client
            .list_tools(h.ws, &h.endpoint, &bearer())
            .await
            .map(|_| ()),
        rejected.map(|_: Value| ())
    );
}

#[tokio::test]
async fn any_other_status_after_the_call_is_unknown() {
    for status in [408, 409, 422, 425, 429, 404, 503] {
        let h = start(move |method, body| match method {
            "tools/call" => status_reply(status),
            _ => plain_server(&[])(method, body),
        })
        .await;
        assert_eq!(
            h.client
                .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
                .await,
            Err(ShopError::Unknown),
            "{status}"
        );
    }
}

#[tokio::test]
async fn a_server_error_is_unknown_after_the_call_and_unavailable_before() {
    let h = start(|method, body| match method {
        "tools/call" => status_reply(502),
        _ => plain_server(&[])(method, body),
    })
    .await;
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Unknown)
    );
    let h = start(|method, body| match method {
        "initialize" => status_reply(503),
        _ => plain_server(&[])(method, body),
    })
    .await;
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Unavailable)
    );
    assert_eq!(h.methods(), ["initialize"]);
}

#[tokio::test]
async fn a_timeout_on_the_call_is_unknown() {
    let h = start(|method, body| {
        let mut reply = plain_server(&[])(method, body);
        if method == "tools/call" {
            reply.delay = Duration::from_secs(3);
        }
        reply
    })
    .await;
    let client = h.client.clone().with_timeout(Duration::from_millis(600));
    assert_eq!(
        client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Unknown)
    );
}

#[tokio::test]
async fn an_answer_over_the_cap_is_unknown_for_a_call_and_malformed_for_a_list() {
    let big = |id: &Value| {
        json_reply(result(
            id,
            json!({"tools": [], "content": [{"type": "text", "text": "x".repeat(300 * 1024)}]}),
        ))
    };
    let h = start(move |method, body| match method {
        "tools/call" | "tools/list" => big(&body["id"]),
        _ => plain_server(&[])(method, body),
    })
    .await;
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &bearer(), &order_call())
            .await,
        Err(ShopError::Unknown)
    );
    assert_eq!(
        h.client.list_tools(h.ws, &h.endpoint, &bearer()).await,
        Err(ShopError::Malformed)
    );
}

#[tokio::test]
async fn the_probe_binds_the_account_to_the_endpoint() {
    let h = start(plain_server(&["call_api_operation", "create_order"])).await;
    let probe = h.client.probe(&bearer(), &h.public()).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(probe.facts, json!({"account_id": h.endpoint.as_str()}));

    let mut public = h.public();
    public["order"] = json!({"tool": "create_order"});
    assert!(h.client.probe(&bearer(), &public).await.ok);
}

#[tokio::test]
async fn the_probe_fails_when_the_order_tool_is_not_listed() {
    let h = start(plain_server(&["something_else"])).await;
    let probe = h.client.probe(&bearer(), &h.public()).await;
    assert!(!probe.ok);
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("permission"));
    assert_eq!(probe.facts, json!({}));

    let mut public = h.public();
    public["order"] = json!({"tool": "create_order"});
    let probe = h.client.probe(&bearer(), &public).await;
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("permission"));
}

#[tokio::test]
async fn the_probe_maps_failures() {
    let h = start(|_, _| status_reply(401)).await;
    let probe = h.client.probe(&bearer(), &h.public()).await;
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("auth"));

    let probe = h
        .client
        .probe(&bearer(), &json!({"workspace_id": h.ws.to_string()}))
        .await;
    assert!(!probe.ok);
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("permanent"));
    let probe = h
        .client
        .probe(
            &bearer(),
            &json!({"endpoint": h.endpoint.as_str(), "workspace_id": "nope"}),
        )
        .await;
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("permanent"));
}

#[tokio::test]
async fn a_credential_that_is_not_a_bearer_token_is_refused_unsent() {
    let h = start(plain_server(&["call_api_operation"])).await;
    let other = Credential::PageToken {
        page_id: "1".into(),
        token: TOKEN.into(),
    };
    assert_eq!(
        h.client.list_tools(h.ws, &h.endpoint, &other).await,
        Err(ShopError::Auth)
    );
    assert_eq!(
        h.client
            .call_tool(h.ws, &h.endpoint, &other, &order_call())
            .await,
        Err(ShopError::Auth)
    );
    let probe = h.client.probe(&other, &h.public()).await;
    assert_eq!(probe.error.as_ref().map(|e| e.kind()), Some("auth"));
    assert!(h.methods().is_empty());
}
