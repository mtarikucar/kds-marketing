mod support;
use jt_app::{
    ports::connectors::SendReceipt,
    usecases::inbox::{quotes, replies},
};
use jt_connector::ConnectorError;
use jt_inbox::*;
use serde_json::json;
use support::{outbound::setup_channel, *};
fn input(w: &World, key: Option<&str>) -> quotes::SendInput {
    serde_json::from_value(json!({"amount_minor":12300,"currency":"TRY","valid_until":(w.owner_ctx.now + time::Duration::days(1)).format(&time::format_description::well_known::Rfc3339).unwrap(),"file_ref":"opaque:agent-owned","channel":"whats_app","text":"Your quote","intent":"reply","request_key":key})).unwrap()
}
fn accepted() -> Result<SendReceipt, ConnectorError> {
    Ok(SendReceipt {
        provider_id: "quote-provider".into(),
        cost_minor: None,
    })
}
#[tokio::test]
async fn quote_unknown_defers_quote_sent_until_evidence() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(Err(ConnectorError::unknown("lost acknowledgement")));
    let out = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("quote")))
        .await
        .unwrap();
    assert_eq!(out.delivery.state, "unknown");
    assert!(w.uow.snapshot().inbox.events.is_empty());
    assert!(
        quotes::accept(&w.deps, &w.owner_ctx, out.quote.id)
            .await
            .is_err()
    );
    let id = w.uow.snapshot().inbox.outbox[0].id;
    replies::record_result(&w.deps, &w.owner_ctx, id, accepted())
        .await
        .unwrap();
    replies::record_result(&w.deps, &w.owner_ctx, id, accepted())
        .await
        .unwrap();
    assert_eq!(
        w.uow
            .snapshot()
            .inbox
            .events
            .iter()
            .filter(|e| e.kind == JourneyEventKind::QuoteSent)
            .count(),
        1
    );
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Quoted
    );
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn quote_request_key_returns_same_quote_and_response() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(accepted());
    let first = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("quote")))
        .await
        .unwrap();
    let second = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("quote")))
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(
        quotes::list(&w.deps, &w.owner_ctx, j).await.unwrap().len(),
        1
    );
    assert_eq!(c.calls().len(), 1);
}
#[tokio::test]
async fn quote_accept_moves_pending() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(accepted());
    let out = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, None))
        .await
        .unwrap();
    let accepted = quotes::accept(&w.deps, &w.owner_ctx, out.quote.id)
        .await
        .unwrap();
    assert_eq!(accepted.quote.state, QuoteState::Accepted);
    quotes::accept(&w.deps, &w.owner_ctx, out.quote.id)
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Pending
    );
    assert_eq!(
        w.uow
            .snapshot()
            .inbox
            .events
            .iter()
            .filter(|e| e.kind == JourneyEventKind::QuoteAccepted)
            .count(),
        1
    );
}
#[tokio::test]
async fn expired_quote_refused() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(accepted());
    let out = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, None))
        .await
        .unwrap();
    let ctx = jt_app::ctx::Ctx {
        now: w.owner_ctx.now + time::Duration::days(2),
        ..w.owner_ctx.clone()
    };
    assert!(quotes::accept(&w.deps, &ctx, out.quote.id).await.is_err());
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Quoted
    );
    assert_eq!(
        quotes::list(&w.deps, &ctx, j).await.unwrap()[0].quote.state,
        QuoteState::Expired
    );
}

#[tokio::test]
async fn quote_receipt_after_terminal_preserves_closure_and_is_idempotent() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    c.push_send_text(Err(ConnectorError::unknown("lost acknowledgement")));
    quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("terminal")))
        .await
        .unwrap();
    jt_app::usecases::inbox::journeys::report(
        &w.deps,
        &w.owner_ctx,
        j,
        serde_json::from_value(
            json!({"kind":"lost","idempotency_key":"lost","payload":{"reason_key":"fiyat"}}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let before = w.uow.snapshot().inbox.journeys[0].clone();
    let id = w.uow.snapshot().inbox.outbox[0].id;
    replies::record_result(&w.deps, &w.owner_ctx, id, accepted())
        .await
        .unwrap();
    replies::record_result(&w.deps, &w.owner_ctx, id, accepted())
        .await
        .unwrap();
    let after = w.uow.snapshot();
    assert_eq!(after.inbox.journeys[0], before);
    assert_eq!(after.inbox.outbox[0].state, "sent");
    assert_eq!(
        after
            .inbox
            .events
            .iter()
            .filter(|e| e.kind == JourneyEventKind::QuoteSent)
            .count(),
        1
    );
    assert_eq!(
        quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("terminal")))
            .await
            .unwrap()
            .delivery
            .state,
        "sent"
    );
    assert_eq!(c.calls().len(), 1);
}

#[tokio::test]
async fn quote_queued_cache_and_refusal_are_atomic() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let (first, id) = quotes::enqueue(&w.deps, &w.owner_ctx, j, input(&w, Some("queued")))
        .await
        .unwrap();
    assert!(id.is_some());
    let second = quotes::send(&w.deps, &w.owner_ctx, j, input(&w, Some("queued")))
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.delivery.state, "queued");
    assert!(c.calls().is_empty());
    let mut bad = input(&w, Some("refused"));
    bad.intent = SendIntent::Commercial;
    assert_eq!(
        quotes::send(&w.deps, &w.owner_ctx, j, bad)
            .await
            .unwrap_err()
            .message,
        "IZIN_YOK"
    );
    assert_eq!(w.uow.snapshot().inbox.quotes.len(), 1);
    assert_eq!(w.uow.snapshot().inbox.outbox.len(), 1);
    let mut denied = w.owner_ctx.clone();
    denied.permissions.clear();
    assert!(
        quotes::send(&w.deps, &denied, j, input(&w, Some("queued")))
            .await
            .is_err()
    );
    assert!(quotes::list(&w.deps, &denied, j).await.is_err());
    assert!(
        quotes::accept(&w.deps, &denied, first.quote.id)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn client_event_key_cannot_forge_quote_delivery() {
    let (w, _, c) = setup_channel("whatsapp_cloud").await;
    let j = w.uow.snapshot().inbox.journeys[0].id;
    let (out, queued) = quotes::enqueue(&w.deps, &w.owner_ctx, j, input(&w, None))
        .await
        .unwrap();
    // Client-selected event keys are untrusted; a CallMade with a receipt-shaped key is
    // never evidence that the provider accepted this quote.
    let report = jt_app::usecases::inbox::journeys::report(&w.deps,&w.owner_ctx,j,
        serde_json::from_value(json!({"kind":"call_made","idempotency_key":format!("quote:{}:sent",out.quote.id),"payload":{"connected":true}})).unwrap()).await;
    assert!(report.is_err());
    assert!(
        quotes::accept(&w.deps, &w.owner_ctx, out.quote.id)
            .await
            .is_err()
    );
    assert_ne!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Pending
    );
    c.push_send_text(accepted());
    replies::send_step(&w.deps, &w.owner_ctx, queued.unwrap())
        .await
        .unwrap();
    quotes::accept(&w.deps, &w.owner_ctx, out.quote.id)
        .await
        .unwrap();
    assert_eq!(
        w.uow.snapshot().inbox.journeys[0].status,
        JourneyStatus::Pending
    );
}
