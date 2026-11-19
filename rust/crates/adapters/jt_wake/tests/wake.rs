//! The wake adapter against an in-process mock on 127.0.0.1: what a routine's fire sends and how
//! each answer maps, and the webhook's egress rules. Never reaches the real endpoint.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use jt_app::ports::wake::{AgentWaker, WakeAnswer, WakeReason, WebhookWake};
use jt_outbound::{Egress, FIXED_HOSTS, Url};
use jt_tenancy::{ApiKeyId, WorkspaceId};
use jt_wake::{EgressWaker, WakeBases};
use tokio::net::TcpListener;

const TOKEN: &str = "sk-ant-oat01-TEST-token-never-logged";

#[derive(Clone, Default)]
struct Seen {
    requests: Arc<Mutex<Vec<(String, HeaderMap, String)>>>,
    reply: Arc<Mutex<(u16, Vec<(&'static str, &'static str)>, &'static str)>>,
}

async fn handle(State(seen): State<Seen>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    seen.requests.lock().unwrap().push((
        uri.path().to_owned(),
        headers,
        String::from_utf8_lossy(&body).into_owned(),
    ));
    let (status, extra, body) = seen.reply.lock().unwrap().clone();
    let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
    for (k, v) in extra {
        response.headers_mut().insert(k, v.parse().unwrap());
    }
    response
}

async fn mock(
    status: u16,
    extra: Vec<(&'static str, &'static str)>,
    body: &'static str,
) -> (EgressWaker, Seen) {
    let seen = Seen::default();
    *seen.reply.lock().unwrap() = (status, extra, body);
    let app = Router::new().fallback(handle).with_state(seen.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let egress =
        Arc::new(Egress::new(FIXED_HOSTS).with_test_hosts([("anthropic", addr.to_string())]));
    let bases = WakeBases {
        anthropic: Url::parse(&format!("http://{addr}/")).unwrap(),
    };
    (EgressWaker::new(egress, bases), seen)
}

#[tokio::test]
async fn a_fire_sends_the_documented_request_and_reads_the_session() {
    let (waker, seen) = mock(200, vec![], include_str!("fixtures/routine_fire_200.json")).await;
    let answer = waker
        .fire_routine(
            "trig_01ABC",
            TOKEN,
            "A person asked for a revision of a content.",
        )
        .await;
    assert_eq!(
        answer,
        WakeAnswer::Fired {
            status: 200,
            session_id: Some("session_01HJKLMNOPQRSTUVWXYZ".into()),
            session_url: Some("https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ".into()),
        }
    );
    let requests = seen.requests.lock().unwrap();
    let (path, headers, body) = &requests[0];
    assert_eq!(path, "/v1/claude_code/routines/trig_01ABC/fire");
    assert_eq!(headers["authorization"], format!("Bearer {TOKEN}").as_str());
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(headers["content-type"], "application/json");
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "text": "A person asked for a revision of a content." })
    );
}

#[tokio::test]
async fn a_429_carries_its_retry_after_and_a_401_is_a_refusal() {
    let (waker, _) = mock(
        429,
        vec![("retry-after", "120")],
        include_str!("fixtures/routine_fire_429.json"),
    )
    .await;
    assert_eq!(
        waker.fire_routine("trig_1", TOKEN, "x").await,
        WakeAnswer::RateLimited {
            retry_after: Some(time::Duration::seconds(120))
        }
    );
    let (waker, _) = mock(401, vec![], include_str!("fixtures/routine_fire_401.json")).await;
    assert_eq!(
        waker.fire_routine("trig_1", TOKEN, "x").await,
        WakeAnswer::Refused { status: Some(401) }
    );
    let (waker, _) = mock(503, vec![], "{}").await;
    assert_eq!(
        waker.fire_routine("trig_1", TOKEN, "x").await,
        WakeAnswer::Unavailable { status: Some(503) }
    );
}

#[tokio::test]
async fn a_webhook_to_a_private_or_plain_http_host_is_never_sent() {
    let (waker, _) = mock(200, vec![], "{}").await;
    let body = WebhookWake {
        workspace_id: WorkspaceId::new_v7(),
        agent_id: ApiKeyId::new_v7(),
        reasons: vec![WakeReason::MaterialUploaded],
        at: time::OffsetDateTime::UNIX_EPOCH,
    };
    for url in [
        "http://agents.example.com/wake",
        "https://10.1.2.3/wake",
        "https://169.254.169.254/latest",
        "https://printer.local/wake",
        "https://intranet/wake",
    ] {
        assert_eq!(
            waker.post_webhook(url, Some("secret"), &body).await,
            WakeAnswer::Refused { status: None },
            "{url}"
        );
    }
}
