//! The inbox outside the strategy gate (owner decision of 2026-11-03), behavioural half, on
//! both surfaces as `jeeta serve` merges them: in an active workspace with no approved strategy
//! a person reads and answers a customer's conversation in the panel and an agent does over MCP,
//! while the Growth Studio and the one inbox row that starts commercial contact (`inbox.send`)
//! still answer `STRATEGY_REQUIRED`. In-memory ports and a scripted provider; no database.

#[path = "support/productisation_mcp.rs"]
mod mcp;

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::gate::NoStrategyYet;
use jt_app::ports::connectors::SendReceipt;
use jt_app::usecases::Deps;
use jt_app::usecases::auth::{self, RegisterInput};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::{ConvState, Conversation, ConversationId, Executor, PersonId};
use jt_mcp::McpState;
use jt_panel_http::AppState;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::{InMemoryUow, ScriptedConnector, ScriptedRegistry};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn send(app: &Router, req: Request<Body>) -> Response {
    app.clone().oneshot(req).await.unwrap()
}

/// The status and the JSON body of `resp`.
async fn answer(resp: Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// A panel request with the session `cookie`, and a JSON `body` when given.
fn panel(method: Method, path: &str, cookie: &str, body: Option<Value>) -> Request<Body> {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("x-requested-with", "jeeta-panel")
        .header(header::COOKIE, cookie);
    match body {
        Some(body) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => req.body(Body::empty()).unwrap(),
    }
}

/// A verified WhatsApp line with its sealed credential, and a conversation of `person` on it
/// that the customer has just written into.
async fn conversation(
    deps: &Deps,
    ws: WorkspaceId,
    cap: CapabilityId,
    person: PersonId,
) -> ConversationId {
    let now = deps.clock.now();
    let id = ConversationId::new_v7();
    let mut r = deps.uow.tenant(ws).await.unwrap();
    if r.capabilities().find(cap).await.unwrap().is_none() {
        let mut line = Capability::new(
            cap,
            ws,
            NewCapability {
                kind_key: "whatsapp_cloud".into(),
                name: "Support".into(),
                ..Default::default()
            },
            now,
        )
        .unwrap();
        line.status = StoredStatus::Verified;
        line.last_verified_at = Some(now);
        let credential = Credential::WhatsAppCloud {
            phone_number_id: "line".into(),
            token: "private-token".into(),
            waba_id: None,
            expires_at: None,
        };
        let sealed = deps
            .seal
            .seal(ws, &serde_json::to_vec(&credential).unwrap())
            .unwrap();
        r.capabilities().insert(line, Some(sealed)).await.unwrap();
    }
    r.conversations()
        .upsert_on_inbound(Conversation {
            id,
            workspace_id: ws,
            person_id: person,
            capability_id: cap,
            kind_key: "whatsapp_cloud".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(now),
            last_outbound_at: None,
            created_at: now,
            updated_at: now,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}

fn person_of(created: &Value) -> PersonId {
    serde_json::from_value(created["person"]["id"].clone()).unwrap()
}

fn accepted() -> Result<SendReceipt, jt_connector::ConnectorError> {
    Ok(SendReceipt {
        provider_id: "provider-1".into(),
        cost_minor: None,
    })
}

/// An active workspace with no strategy, served by the panel and MCP merged as `jeeta serve`
/// merges them, with the owner's session and an MCP session of an owner's key.
struct Served {
    uow: InMemoryUow,
    deps: Deps,
    ws: WorkspaceId,
    cookie: String,
    app: Router,
    key: String,
    session: String,
}

async fn served(connectors: ScriptedRegistry) -> Served {
    let uow = InMemoryUow::new();
    let mut deps = jt_testkit::fakes::deps(Arc::new(uow.clone()));
    deps.connectors = Arc::new(connectors);
    let registered = auth::register(
        &deps,
        RegisterInput {
            email: "owner@inbox.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Inbox".into(),
        },
    )
    .await
    .unwrap();
    let ws = registered.me.current_workspace.unwrap();
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let cookie = format!("jt_session={}", registered.token);
    let gate = Arc::new(NoStrategyYet);
    let app = jt_panel_http::router(AppState {
        deps: deps.clone(),
        gate: gate.clone(),
        cookie_secure: false,
        panel_dir: None,
    })
    .merge(jt_mcp::http_service(McpState::new(deps.clone(), gate)));
    let (status, key) = answer(
        send(
            &app,
            panel(
                Method::POST,
                "/api/api-keys",
                &cookie,
                Some(json!({"name":"agent"})),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{key}");
    let key = key["plaintext"].as_str().unwrap().to_owned();
    let session = mcp::mcp_session(&app, &key).await;
    Served {
        uow,
        deps,
        ws,
        cookie,
        app,
        key,
        session,
    }
}

#[tokio::test]
async fn a_workspace_without_a_strategy_reads_and_answers_its_customers_on_both_surfaces() {
    let connector = Arc::new(ScriptedConnector::new(Provider::Meta));
    let s = served(ScriptedRegistry::new().with_connector(connector.clone())).await;
    let (deps, ws, app) = (&s.deps, s.ws, &s.app);
    let (cookie, key, session) = (s.cookie.as_str(), s.key.as_str(), s.session.as_str());
    let line = CapabilityId::new_v7();

    // The person writes: create a customer, read the conversation and its messages, answer it.
    let (status, created) = answer(
        send(
            app,
            panel(
                Method::POST,
                "/api/inbox/people",
                cookie,
                Some(json!({"display_name":"Ada","identities":[{"channel":"phone","value":"05321234567"}],"source":"form"})),
            ),
        )
        .await,
    )
    .await;
    assert!(status.is_success(), "{status}: {created}");
    let ada = person_of(&created);
    let theirs = conversation(deps, ws, line, ada).await;
    let (status, listed) = answer(
        send(
            app,
            panel(
                Method::GET,
                "/api/inbox/conversations?queue=all",
                cookie,
                None,
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(listed.to_string().contains(&theirs.to_string()), "{listed}");
    let path = format!("/api/inbox/conversations/{theirs}/messages");
    let (status, messages) =
        answer(send(app, panel(Method::GET, &path, cookie, None)).await).await;
    assert_eq!(status, StatusCode::OK, "{messages}");
    connector.push_send_text(accepted());
    let path = format!("/api/inbox/conversations/{theirs}/reply");
    let (status, replied) = answer(
        send(
            app,
            panel(
                Method::POST,
                &path,
                cookie,
                Some(json!({"text":"Hello Ada","intent":"reply"})),
            ),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replied}");
    assert_eq!(replied["state"], "sent");

    // The agent does the same over MCP.
    let created = mcp::call_tool(
        app,
        key,
        session,
        "jeeta.inbox.people_create",
        json!({"display_name":"Bo","identities":[{"channel":"phone","value":"05327654321"}],"source":"form"}),
    )
    .await;
    let bo = person_of(&created);
    let ours = conversation(deps, ws, line, bo).await;
    let listed = mcp::call_tool(
        app,
        key,
        session,
        "jeeta.inbox.conversations_list",
        json!({"queue":"all"}),
    )
    .await;
    assert!(listed.to_string().contains(&ours.to_string()), "{listed}");
    mcp::call_tool(
        app,
        key,
        session,
        "jeeta.inbox.messages_list",
        json!({"conversation_id":ours}),
    )
    .await;
    connector.push_send_text(accepted());
    let replied = mcp::call_tool(
        app,
        key,
        session,
        "jeeta.inbox.reply",
        json!({"conversation_id":ours,"text":"Hello Bo","intent":"reply"}),
    )
    .await;
    assert_eq!(replied["state"], "sent");
    assert_eq!(connector.calls().len(), 2);

    // Growth work still waits for the strategy, and so does starting commercial contact.
    let (status, refused) = answer(
        send(
            app,
            panel(
                Method::GET,
                "/api/studio/overview?from=2020-01-01T00:00:00Z&until=2099-01-01T00:00:00Z",
                cookie,
                None,
            ),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, &refused["code"]),
        (StatusCode::CONFLICT, &json!("STRATEGY_REQUIRED"))
    );
    let refused = mcp::tool_result(
        app,
        key,
        session,
        "jeeta.studio.overview",
        json!({"from":"2020-01-01T00:00:00Z","until":"2099-01-01T00:00:00Z"}),
    )
    .await;
    assert_eq!(refused["structuredContent"]["code"], "STRATEGY_REQUIRED");
    let outreach = json!({"channel":"whats_app","text":"An offer","intent":"commercial"});
    let path = format!("/api/inbox/people/{ada}/send");
    let (status, refused) = answer(
        send(
            app,
            panel(Method::POST, &path, cookie, Some(outreach.clone())),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, &refused["code"]),
        (StatusCode::CONFLICT, &json!("STRATEGY_REQUIRED"))
    );
    let mut arguments = outreach;
    arguments["person_id"] = json!(bo);
    let refused = mcp::tool_result(app, key, session, "jeeta.inbox.send", arguments).await;
    assert_eq!(refused["structuredContent"]["code"], "STRATEGY_REQUIRED");
    assert_eq!(connector.calls().len(), 2, "nothing more was sent");
}

/// A verified mailbox with its sealed credential, and no conversation on it.
async fn mailbox(deps: &Deps, ws: WorkspaceId) {
    let now = deps.clock.now();
    let mut line = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: "mailbox".into(),
            name: "Mail".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    line.status = StoredStatus::Verified;
    line.last_verified_at = Some(now);
    let credential = Credential::Mailbox {
        smtp_host: "smtp.example.com".into(),
        smtp_port: 465,
        imap_host: "imap.example.com".into(),
        imap_port: 993,
        username: "sales@example.com".into(),
        password: "private-mail".into(),
        from_address: "sales@example.com".into(),
        tls: jt_connector::MailTls::Implicit,
    };
    let sealed = deps
        .seal
        .seal(ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let mut r = deps.uow.tenant(ws).await.unwrap();
    r.capabilities().insert(line, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
}

/// Every link of the chain is exempt (a person, their consent, their journey), but a quote or an
/// appointment mailed to a customer who never wrote opens a conversation nobody asked for:
/// outreach, which still waits for a strategy on both surfaces, and nothing is sent or opened.
#[tokio::test]
async fn a_quote_or_appointment_that_opens_a_conversation_still_needs_a_strategy() {
    let connector = Arc::new(ScriptedConnector::new(Provider::Mail));
    let s = served(ScriptedRegistry::new().with_connector(connector.clone())).await;
    let (app, cookie) = (&s.app, s.cookie.as_str());
    mailbox(&s.deps, s.ws).await;
    let mut journeys = Vec::new();
    for (name, address) in [("Cem", "cem@example.com"), ("Defne", "defne@example.com")] {
        let (status, created) = answer(
            send(
                app,
                panel(
                    Method::POST,
                    "/api/inbox/people",
                    cookie,
                    Some(json!({"display_name":name,"identities":[{"channel":"email","value":address}],"source":"form"})),
                ),
            )
            .await,
        )
        .await;
        assert!(status.is_success(), "{status}: {created}");
        let person = person_of(&created);
        let path = format!("/api/inbox/people/{person}/consents");
        let consent = json!({"channel":"email","kind":"explicit","source":"customer","at":"2026-01-01T00:00:00Z"});
        let (status, body) =
            answer(send(app, panel(Method::POST, &path, cookie, Some(consent))).await).await;
        assert!(status.is_success(), "{status}: {body}");
        let path = format!("/api/inbox/people/{person}");
        let (status, read) = answer(send(app, panel(Method::GET, &path, cookie, None)).await).await;
        assert_eq!(status, StatusCode::OK, "{read}");
        journeys.push(read["open_journey"]["id"].as_str().unwrap().to_owned());
    }
    let quote = json!({"amount_minor":12300,"currency":"TRY","valid_until":"2099-01-01T00:00:00Z","channel":"email","text":"Your quote","intent":"commercial"});
    let path = format!("/api/inbox/journeys/{}/quotes", journeys[0]);
    let (status, refused) =
        answer(send(app, panel(Method::POST, &path, cookie, Some(quote.clone()))).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
    assert_eq!(refused["details"]["reason"], "strategy_required");
    let mut arguments = quote;
    arguments["journey_id"] = json!(journeys[1]);
    let refused = mcp::tool_result(
        app,
        &s.key,
        &s.session,
        "jeeta.inbox.quotes_send",
        arguments,
    )
    .await;
    assert_eq!(
        refused["structuredContent"]["details"]["reason"], "strategy_required",
        "{refused}"
    );
    // The booking itself is internal and is kept; its confirmation mail is refused.
    let booking = json!({"starts_at":"2099-01-01T10:00:00Z","ends_at":"2099-01-01T11:00:00Z","location":"Office","intent":"commercial"});
    let path = format!("/api/inbox/journeys/{}/appointments", journeys[0]);
    let (status, booked) =
        answer(send(app, panel(Method::POST, &path, cookie, Some(booking))).await).await;
    assert!(status.is_success(), "{status}: {booked}");
    assert_eq!(booked["notification"]["state"], "refused");
    assert!(connector.calls().is_empty());
    let state = s.uow.snapshot();
    assert!(
        state.inbox.conversations.is_empty(),
        "no conversation was opened"
    );
    assert!(state.inbox.outbox.is_empty());
    assert!(state.inbox.quotes.is_empty());
}
