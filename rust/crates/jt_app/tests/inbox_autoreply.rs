//! The inbox's automatic replies end to end over the fakes: a customer's WhatsApp message is
//! consumed, scheduled, answered by the scripted model, held to the server's rules and sent (or
//! handed to a person). Every business, price and message here is invented.

mod support;

use std::sync::Arc;

use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{InboundEventDraft, SendReceipt};
use jt_app::ports::reply_model::{
    AUTOREPLY_SETTLE, ModelAnswer, ModelError, ModelStop, ModelTool, PER_CONVERSATION_DAILY, Part,
    RunOutcome, RunRow, Speaker, Usage, WORKSPACE_DAILY_SPEND_MICRO_USD,
};
use jt_app::usecases::inbox::{context, conversations, public, replies};
use jt_app::usecases::jobs::{self, JobReport};
use jt_app::usecases::knowledge::{cards, read, rules};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_knowledge::AutoReplyInput;
use jt_testkit::fakes::{ModelResult, ScriptedConnector, ScriptedModel, ScriptedRegistry};
use serde_json::json;
use support::*;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

/// The invented range: 1.000 to 5.000 TL.
const MIN: i64 = 100_000;
const MAX: i64 = 500_000;

struct T {
    w: World,
    cap: CapabilityId,
    meta: Arc<ScriptedConnector>,
    model: Arc<ScriptedModel>,
}

fn meta_drafts(file: &str) -> Vec<InboundEventDraft> {
    let raw = std::fs::read(format!(
        "{}/tests/fixtures/meta/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    jt_meta::webhook::parse(&raw)
        .unwrap()
        .into_iter()
        .map(|p| p.event)
        .collect()
}

/// The consumer's time for a message received `tick` seconds after the fixed time.
fn consumed_at(tick: i64) -> OffsetDateTime {
    FIXED_NOW_T + Duration::seconds(tick) + Duration::seconds(1)
}

const FIXED_NOW_T: OffsetDateTime = jt_testkit::fakes::FIXED_NOW;

/// An active workspace with a verified WhatsApp number, the scripted Meta connector and (when
/// `with_model`) the scripted model.
async fn setup_with(with_model: bool, active: bool) -> T {
    let mut w = world().await;
    if active {
        jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    }
    let meta = Arc::new(ScriptedConnector::new(Provider::Meta));
    let model = ScriptedModel::new();
    let mut registry = ScriptedRegistry::new().with_connector(meta.clone());
    if with_model {
        registry = registry.with_model(model.clone());
    }
    w.deps.connectors = Arc::new(registry);
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: "whatsapp_cloud".into(),
            name: "Atölye WhatsApp".into(),
            ..Default::default()
        },
        FIXED_NOW_T - Duration::days(2),
    )
    .unwrap();
    cap.external_id = Some(cap.id.to_string());
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW_T - Duration::days(1));
    let cred = Credential::WhatsAppCloud {
        phone_number_id: "line".into(),
        token: "private-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = cap.id;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.commit().await.unwrap();
    T {
        w,
        cap: id,
        meta,
        model,
    }
}

async fn setup() -> T {
    let t = setup_with(true, true).await;
    turn_on(&t).await;
    t
}

/// Turns the automatic replies on for the number, with the range, and writes the standard card.
async fn turn_on(t: &T) {
    let w = &t.w;
    let k = read::knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    rules::rules_save(
        &w.deps,
        &w.owner_ctx,
        rules::RulesInput {
            expected_revision: k.rules.revision,
            prohibitions: vec![],
            ad_budget: None,
            message_budget: None,
            post_approval: false,
            post_approval_accounts: None,
            auto_reply: Some(AutoReplyInput {
                capability_ids: vec![t.cap.as_uuid()],
                min_minor: Some(MIN),
                max_minor: Some(MAX),
            }),
        },
    )
    .await
    .unwrap();
    let k = read::knowledge_get(&w.deps, &w.owner_ctx).await.unwrap();
    let card = k
        .cards
        .iter()
        .find(|c| c.key.as_deref() == Some("reply_standard"))
        .expect("the standard card is created when the replies are turned on");
    cards::card_update(
        &w.deps,
        &w.owner_ctx,
        card.id,
        serde_json::from_value(json!({
            "expected_revision": card.revision,
            "body": "Küçük tek parça: alt sınıra yakın. Büyük ya da çok parçalı: üst sınıra doğru. \
                     Toptan siparişler standart dışıdır."
        }))
        .unwrap(),
    )
    .await
    .unwrap();
}

/// Stores WhatsApp message `n` of the fixture (0, 2 and 3 are one customer's) as received `tick`
/// seconds after the fixed time, and consumes it then.
async fn inbound(t: &T, n: usize, tick: i64) {
    let w = &t.w;
    let mut draft = meta_drafts("whatsapp_messages").remove(n);
    let received = FIXED_NOW_T + Duration::seconds(tick);
    draft.payload["occurred_at"] = json!(received.format(&Rfc3339).unwrap());
    put(t, draft, received).await;
    let report = jobs::run_inbox_consume(&w.deps, consumed_at(tick)).await;
    assert_eq!(report.failed, 0, "{report:?}");
}

async fn put(t: &T, draft: InboundEventDraft, received: OffsetDateTime) {
    let w = &t.w;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: w.ws,
                capability_id: Some(t.cap),
                provider: Provider::Meta,
                external_id: draft.external_id,
                kind: draft.kind,
                payload: draft.payload,
                received_at: received,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
}

async fn job(t: &T, at: OffsetDateTime) -> JobReport {
    jobs::run_inbox_auto_reply(&t.w.deps, at).await
}

/// When the reply of a burst whose last message was consumed at tick `tick` is due.
fn due(tick: i64) -> OffsetDateTime {
    consumed_at(tick) + AUTOREPLY_SETTLE
}

fn usage() -> Usage {
    Usage {
        input_tokens: 1_200,
        output_tokens: 90,
        cache_write_tokens: 800,
        cache_read_tokens: 0,
        cost_micro_usd: 265,
    }
}

fn tool(tool: ModelTool) -> ModelResult {
    Ok(ModelAnswer {
        tool: Some(tool),
        stop: ModelStop::ToolUse,
        usage: usage(),
    })
}

fn reply(text: &str) -> ModelResult {
    tool(ModelTool::Reply { text: text.into() })
}

fn quote(amount: i64, text: &str) -> ModelResult {
    tool(ModelTool::Quote {
        amount,
        basis: "küçük tek parça".into(),
        text: text.into(),
    })
}

fn accepted() -> Result<SendReceipt, jt_connector::ConnectorError> {
    Ok(SendReceipt {
        provider_id: "wamid.TEST-AUTO-1".into(),
        cost_minor: None,
    })
}

fn conversation(t: &T) -> Conversation {
    t.w.uow.snapshot().inbox.conversations[0].clone()
}

fn texts_sent(t: &T) -> Vec<String> {
    t.meta
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            jt_testkit::fakes::ConnectorCall::SendText { text, .. } => Some(text),
            _ => None,
        })
        .collect()
}

fn runs(t: &T) -> Vec<RunRow> {
    t.w.uow
        .snapshot()
        .auto_reply
        .runs
        .into_iter()
        .map(|(_, r)| r)
        .collect()
}

fn reasons(t: &T, action: &str) -> Vec<String> {
    t.w.ledger(action)
        .into_iter()
        .map(|e| e.payload["reason"].as_str().unwrap_or_default().to_owned())
        .collect()
}

fn handed_to_a_person(t: &T) {
    assert!(
        matches!(conversation(t).executor, Executor::Human { .. }),
        "the conversation went to a person"
    );
}

// ---------------------------------------------------------------------------------------------
// When it runs
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn three_messages_within_the_settle_time_make_one_call_and_one_send() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    inbound(&t, 2, 5).await;
    inbound(&t, 3, 10).await;
    // Not due until the settle time after the last message.
    assert_eq!(job(&t, due(0)).await.touched, 0);
    t.model
        .answer(reply("Merhaba! Kaç kişilik bir figür düşünüyorsunuz?"));
    t.meta.push_send_text(accepted());
    let report = job(&t, due(10)).await;
    assert_eq!(report.changed, 1, "{report:?}");
    assert_eq!(t.model.requests().len(), 1);
    assert_eq!(
        texts_sent(&t),
        ["Merhaba! Kaç kişilik bir figür düşünüyorsunuz?"]
    );
    let s = t.w.uow.snapshot();
    let sent = s
        .inbox
        .messages
        .iter()
        .find(|m| m.direction == Direction::Outbound)
        .unwrap();
    assert_eq!(sent.author, Author::Agent);
    assert_eq!(sent.status, MsgStatus::Sent);
    let row = &s.inbox.outbox[0];
    assert_eq!(row.intent["use_case"], "inbox.reply");
    assert!(row.intent["auto_reply"]["run_id"].is_string());
    assert!(s.auto_reply.queue.is_empty(), "the queue row is done");
    // The run holds the scripted usage and its cost; the ledger numbers and codes only.
    let run = &runs(&t)[0];
    assert_eq!(run.outcome, RunOutcome::Replied);
    assert_eq!(run.usage, usage());
    assert_eq!(run.model, "scripted-model");
    let entry = &t.w.ledger("inbox.autoreply.replied")[0];
    assert_eq!(entry.payload["cost_micro_usd"], 265);
    assert!(!entry.payload.to_string().contains("Merhaba"));
    // Nothing left to do.
    assert_eq!(job(&t, due(10) + Duration::minutes(5)).await.touched, 0);
}

#[tokio::test]
async fn the_model_reads_the_conversation_as_alternating_turns_ending_with_the_customer() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(reply("Merhaba, buyurun."));
    t.meta.push_send_text(accepted());
    job(&t, due(0)).await;
    inbound(&t, 2, 60).await;
    inbound(&t, 3, 61).await;
    t.model.answer(reply("Tabii, yardımcı olayım."));
    t.meta.push_send_text(accepted());
    job(&t, due(61)).await;
    let requests = t.model.requests();
    assert_eq!(requests.len(), 2);
    let second = &requests[1];
    let speakers: Vec<Speaker> = second.history.iter().map(|t| t.speaker).collect();
    assert_eq!(
        speakers,
        [Speaker::Customer, Speaker::Business, Speaker::Customer]
    );
    assert_eq!(second.history[2].parts.len(), 2, "two messages, one turn");
    let Part::Text { text } = &second.history[1].parts[0];
    assert_eq!(text, "Merhaba, buyurun.");
    // The workspace's part names the range and holds the standard card.
    assert!(second.system_workspace.contains("1000–5000 TRY"));
    assert!(second.system_workspace.contains("Standart iş ve fiyat"));
    assert!(second.system_fixed.contains("exactly one tool"));
}

#[tokio::test]
async fn without_a_model_nothing_is_scheduled_and_the_read_says_why() {
    let t = setup_with(false, true).await;
    let k = read::knowledge_get(&t.w.deps, &t.w.owner_ctx)
        .await
        .unwrap();
    assert!(!k.rules.auto_reply.available);
    assert_eq!(k.rules.auto_reply.off_reason, Some("no_key"));
    assert_eq!(k.rules.auto_reply.accounts.len(), 1);
    turn_on(&t).await;
    inbound(&t, 0, 0).await;
    assert!(t.w.uow.snapshot().auto_reply.queue.is_empty());
    assert_eq!(job(&t, due(0)).await, JobReport::default());
    assert!(t.model.requests().is_empty());
}

#[tokio::test]
async fn with_the_setting_off_or_the_standard_card_empty_nothing_runs() {
    let t = setup_with(true, true).await;
    inbound(&t, 0, 0).await;
    assert!(t.w.uow.snapshot().auto_reply.queue.is_empty(), "off");
    // On, but the standard card still empty: the read says so and nothing is scheduled.
    let k = read::knowledge_get(&t.w.deps, &t.w.owner_ctx)
        .await
        .unwrap();
    rules::rules_save(
        &t.w.deps,
        &t.w.owner_ctx,
        rules::RulesInput {
            expected_revision: k.rules.revision,
            prohibitions: vec![],
            ad_budget: None,
            message_budget: None,
            post_approval: false,
            post_approval_accounts: None,
            auto_reply: Some(AutoReplyInput {
                capability_ids: vec![t.cap.as_uuid()],
                min_minor: Some(MIN),
                max_minor: Some(MAX),
            }),
        },
    )
    .await
    .unwrap();
    let k = read::knowledge_get(&t.w.deps, &t.w.owner_ctx)
        .await
        .unwrap();
    assert!(k.rules.auto_reply.available);
    assert_eq!(k.rules.auto_reply.off_reason, Some("standard_missing"));
    assert_eq!(k.rules.auto_reply.capability_ids, vec![t.cap]);
    inbound(&t, 2, 5).await;
    assert!(t.w.uow.snapshot().auto_reply.queue.is_empty());
    assert!(t.model.requests().is_empty());
}

#[tokio::test]
async fn a_workspace_waiting_for_payment_or_without_its_inbox_gets_no_call() {
    let t = setup_with(true, false).await;
    turn_on(&t).await;
    inbound(&t, 0, 0).await;
    assert!(
        t.w.uow.snapshot().auto_reply.queue.is_empty(),
        "pending payment"
    );
    job(&t, due(0)).await;
    assert!(t.model.requests().is_empty());

    let t = setup().await;
    inbound(&t, 0, 0).await;
    jt_app::usecases::modules::remove(&t.w.deps, &t.w.owner_ctx, "inbox")
        .await
        .unwrap();
    let report = job(&t, due(0)).await;
    assert_eq!(report.skipped, 1);
    assert!(t.model.requests().is_empty());
    assert_eq!(reasons(&t, "inbox.autoreply.skipped"), ["inbox_removed"]);
}

// ---------------------------------------------------------------------------------------------
// How a person stops it
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_take_over_before_the_due_time_means_no_call() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    conversations::take_over(&t.w.deps, &t.w.owner_ctx, conversation(&t).id)
        .await
        .unwrap();
    let report = job(&t, due(0)).await;
    assert_eq!(report.skipped, 1);
    assert!(t.model.requests().is_empty());
    assert_eq!(reasons(&t, "inbox.autoreply.skipped"), ["executor_changed"]);
}

#[tokio::test]
async fn a_take_over_while_the_model_answers_drops_the_answer() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    let (deps, owner) = (t.w.deps.clone(), t.w.owner_ctx.clone());
    let id = conversation(&t).id;
    t.model.during_next(move || async move {
        conversations::take_over(&deps, &owner, id).await.unwrap();
    });
    t.model.answer(reply("Merhaba!"));
    let report = job(&t, due(0)).await;
    assert_eq!(report.skipped, 1);
    assert!(texts_sent(&t).is_empty());
    assert!(t.w.uow.snapshot().inbox.outbox.is_empty());
    let run = &runs(&t)[0];
    assert_eq!(run.outcome, RunOutcome::Skipped);
    assert_eq!(run.reason.as_deref(), Some("executor_changed"));
    assert_eq!(run.usage, usage(), "the call's cost is kept");
}

#[tokio::test]
async fn a_queued_automatic_reply_is_refused_at_claim_after_a_take_over() {
    let t = setup().await;
    // Held for approval so it waits; then queued as if before the take-over.
    t.w.uow.edit(|st| {
        for c in &mut st.capabilities {
            c.capability.policy.requires_human_approval = true;
        }
    });
    inbound(&t, 0, 0).await;
    t.model.answer(reply("Merhaba!"));
    job(&t, due(0)).await;
    let row = t.w.uow.snapshot().inbox.outbox[0].clone();
    conversations::take_over(&t.w.deps, &t.w.owner_ctx, row.conversation_id)
        .await
        .unwrap();
    t.w.uow
        .edit(|st| st.inbox.outbox[0].state = "queued".into());
    let out = replies::send_step(&t.w.deps, &t.w.owner_ctx, row.id)
        .await
        .unwrap();
    assert_eq!(out.state, "refused");
    assert!(texts_sent(&t).is_empty());
    let last_error = t.w.uow.snapshot().inbox.outbox[0].last_error.clone();
    assert_eq!(last_error.as_deref(), Some("executor_changed"));
}

#[tokio::test]
async fn an_answer_from_the_phone_app_cancels_the_run() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    let mut echo = meta_drafts("whatsapp_business_app").remove(0);
    let at = FIXED_NOW_T + Duration::seconds(3);
    echo.payload["occurred_at"] = json!(at.format(&Rfc3339).unwrap());
    put(&t, echo, at).await;
    assert_eq!(
        jobs::run_inbox_consume(&t.w.deps, consumed_at(3))
            .await
            .failed,
        0
    );
    assert_eq!(conversation(&t).state, ConvState::Theirs);
    let report = job(&t, due(3)).await;
    assert_eq!(report.skipped, 1);
    assert!(t.model.requests().is_empty());
    assert_eq!(reasons(&t, "inbox.autoreply.skipped"), ["not_ours"]);
}

#[tokio::test]
async fn an_agent_is_not_offered_the_conversations_the_replies_answer() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    let agent = t.w.agent(&["inbox.work"]).await;
    let pending = context::pending(&t.w.deps, &agent).await.unwrap();
    assert!(pending.ours.is_empty());
    // A person still sees it, and without the model the agent does too.
    let mut deps = t.w.deps.clone();
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(t.meta.clone()));
    let pending = context::pending(&deps, &agent).await.unwrap();
    assert_eq!(pending.ours.len(), 1);
}

// ---------------------------------------------------------------------------------------------
// The server's rules
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_quote_within_the_range_goes_out_with_its_quote_row() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model
        .answer(quote(1_250, "Teklifimiz 1.250 TL, 7 gün geçerli."));
    t.meta.push_send_text(accepted());
    let report = job(&t, due(0)).await;
    assert_eq!(report.changed, 1);
    assert_eq!(texts_sent(&t), ["Teklifimiz 1.250 TL, 7 gün geçerli."]);
    let s = t.w.uow.snapshot();
    let q = &s.inbox.quotes[0];
    assert_eq!(q.quote.amount_minor, 125_000);
    assert_eq!(q.quote.currency, "TRY");
    assert!(q.quote.valid_until > due(0) + Duration::days(6));
    assert_eq!(s.inbox.outbox[0].intent["use_case"], "inbox.quotes.send");
    let run = &runs(&t)[0];
    assert_eq!(run.outcome, RunOutcome::Quoted);
    assert_eq!(run.quote_id, Some(q.id));
    let entry = &t.w.ledger("inbox.autoreply.quoted")[0];
    assert_eq!(entry.payload["amount_minor"], 125_000);
    assert!(!entry.payload.to_string().contains("küçük"), "no basis");
}

#[tokio::test]
async fn a_quote_above_the_range_is_not_sent_and_goes_to_a_person() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(quote(6_000, "Teklifimiz 6.000 TL."));
    let report = job(&t, due(0)).await;
    assert_eq!(report.changed, 1);
    assert!(texts_sent(&t).is_empty());
    let s = t.w.uow.snapshot();
    assert!(s.inbox.quotes.is_empty());
    assert!(s.inbox.outbox.is_empty());
    handed_to_a_person(&t);
    assert_eq!(
        reasons(&t, "inbox.autoreply.refused"),
        ["quote_out_of_range"]
    );
    assert_eq!(
        reasons(&t, "inbox.autoreply.handed_over"),
        ["quote_out_of_range"]
    );
    assert_eq!(runs(&t)[0].outcome, RunOutcome::HandedOver);
}

#[tokio::test]
async fn a_second_quote_on_the_journey_goes_to_a_person() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(quote(1_250, "Teklifimiz 1.250 TL."));
    t.meta.push_send_text(accepted());
    job(&t, due(0)).await;
    inbound(&t, 2, 60).await;
    t.model.answer(quote(1_100, "Size özel 1.100 TL."));
    job(&t, due(60)).await;
    assert_eq!(texts_sent(&t).len(), 1);
    assert_eq!(t.w.uow.snapshot().inbox.quotes.len(), 1);
    assert_eq!(reasons(&t, "inbox.autoreply.refused"), ["requote"]);
    handed_to_a_person(&t);
}

#[tokio::test]
async fn a_price_in_a_reply_goes_to_a_person() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(reply("Bunun fiyatı 1.250 TL olur."));
    job(&t, due(0)).await;
    assert!(texts_sent(&t).is_empty());
    handed_to_a_person(&t);
    assert_eq!(
        reasons(&t, "inbox.autoreply.refused"),
        ["price_without_quote"]
    );
}

#[tokio::test]
async fn a_hand_over_sends_the_line_keeps_the_summary_as_a_note_and_owes_the_person() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(tool(ModelTool::HandOver {
        reason: "bulk_or_corporate".into(),
        summary: "Elli adet toptan sipariş soruyor.".into(),
        text: Some("Sizi ekip arkadaşıma aktarıyorum, birazdan yazacak.".into()),
    }));
    t.meta.push_send_text(accepted());
    job(&t, due(0)).await;
    handed_to_a_person(&t);
    assert_eq!(
        texts_sent(&t),
        ["Sizi ekip arkadaşıma aktarıyorum, birazdan yazacak."]
    );
    let s = t.w.uow.snapshot();
    let line = s
        .inbox
        .messages
        .iter()
        .find(|m| m.direction == Direction::Outbound)
        .unwrap();
    assert_eq!(line.author, Author::System);
    assert!(s.inbox.notes[0].text.contains("Elli adet toptan"));
    let entry = &t.w.ledger("inbox.autoreply.handed_over")[0];
    assert_eq!(entry.payload["reason"], "bulk_or_corporate");
    assert_eq!(entry.payload["by"], "model");
    assert!(!entry.payload.to_string().contains("toptan"), "no summary");
    // The owner is owed the conversation.
    let pending = context::pending(&t.w.deps, &t.w.owner_ctx).await.unwrap();
    assert_eq!(pending.ours.len(), 1);
}

#[tokio::test]
async fn a_refusal_or_an_answer_without_a_tool_goes_to_a_person() {
    for (answer, reason) in [
        (
            Ok(ModelAnswer {
                tool: None,
                stop: ModelStop::Refusal,
                usage: usage(),
            }),
            "model_refused",
        ),
        (
            Ok(ModelAnswer {
                tool: None,
                stop: ModelStop::NoTool,
                usage: usage(),
            }),
            "no_tool",
        ),
        (
            Ok(ModelAnswer {
                tool: None,
                stop: ModelStop::MaxTokens,
                usage: usage(),
            }),
            "max_tokens",
        ),
    ] {
        let t = setup().await;
        inbound(&t, 0, 0).await;
        t.model.answer(answer);
        job(&t, due(0)).await;
        assert!(texts_sent(&t).is_empty());
        handed_to_a_person(&t);
        assert_eq!(reasons(&t, "inbox.autoreply.handed_over"), [reason]);
    }
}

#[tokio::test]
async fn a_rate_limit_is_asked_again_once_then_handed_over() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    t.model.answer(Err(ModelError::RateLimited {
        retry_after: Some(Duration::seconds(5)),
    }));
    let report = job(&t, due(0)).await;
    assert_eq!(report.failed, 1);
    assert_eq!(conversation(&t).executor, Executor::Agent);
    t.model
        .answer(Err(ModelError::Unavailable { status: Some(529) }));
    job(&t, due(0) + Duration::seconds(5)).await;
    assert_eq!(t.model.requests().len(), 2);
    handed_to_a_person(&t);
    assert_eq!(
        reasons(&t, "inbox.autoreply.handed_over"),
        ["model_unavailable"]
    );
    assert!(t.w.uow.snapshot().auto_reply.queue.is_empty());
}

// ---------------------------------------------------------------------------------------------
// The capability's policy and the day's limits
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_capability_that_requires_approval_holds_the_reply_until_a_person_approves() {
    let t = setup().await;
    t.w.uow.edit(|st| {
        for c in &mut st.capabilities {
            c.capability.policy.requires_human_approval = true;
        }
    });
    inbound(&t, 0, 0).await;
    t.model.answer(reply("Merhaba!"));
    job(&t, due(0)).await;
    assert!(texts_sent(&t).is_empty());
    let row = t.w.uow.snapshot().inbox.outbox[0].clone();
    assert_eq!(row.state, "held");
    assert_eq!(t.w.ledger("inbox.reply.held").len(), 1);
    let pending = context::pending(&t.w.deps, &t.w.owner_ctx).await.unwrap();
    assert_eq!(pending.approvals[0].outbox_id, row.id);
    t.meta.push_send_text(accepted());
    let out = public::approve(
        &t.w.deps,
        &at(&t.w.owner_ctx, due(0)),
        row.id,
        public::ApproveInput { text: None },
    )
    .await
    .unwrap();
    assert_eq!(out.state, "sent");
    assert_eq!(texts_sent(&t), ["Merhaba!"]);
}

#[tokio::test]
async fn outside_the_working_hours_the_conversation_goes_to_a_person() {
    let t = setup().await;
    t.w.uow.edit(|st| {
        for c in &mut st.capabilities {
            // A window that excludes the fixed time (09:00 UTC, 12:00 in Istanbul).
            c.capability.policy.active_hours = Some(
                serde_json::from_value(json!({
                    "tz": "Europe/Istanbul",
                    "days": [1, 2, 3, 4, 5, 6, 7],
                    "from": 20,
                    "to": 22
                }))
                .unwrap(),
            );
        }
    });
    inbound(&t, 0, 0).await;
    job(&t, due(0)).await;
    assert!(t.model.requests().is_empty());
    handed_to_a_person(&t);
    assert_eq!(
        reasons(&t, "inbox.autoreply.handed_over"),
        ["outside_active_hours"]
    );
}

/// `n` earlier runs today of `outcome` costing `cost` each, on `conversation`.
fn earlier_runs(t: &T, conversation: ConversationId, n: u32, cost: i64) {
    let ws = t.w.ws;
    let cap = t.cap;
    t.w.uow.edit(|st| {
        for _ in 0..n {
            st.auto_reply.runs.push((
                ws,
                RunRow {
                    id: Uuid::now_v7(),
                    conversation_id: conversation,
                    capability_id: cap,
                    at: FIXED_NOW_T,
                    model: "scripted-model".into(),
                    outcome: RunOutcome::Replied,
                    reason: None,
                    usage: Usage {
                        cost_micro_usd: cost,
                        ..Usage::default()
                    },
                    outbox_id: None,
                    quote_id: None,
                },
            ));
        }
    });
}

#[tokio::test]
async fn each_daily_limit_hands_the_conversation_over() {
    for limit in ["limit_conversation", "limit_workspace", "limit_spend"] {
        let t = setup().await;
        inbound(&t, 0, 0).await;
        let id = conversation(&t).id;
        match limit {
            "limit_conversation" => earlier_runs(&t, id, PER_CONVERSATION_DAILY, 0),
            "limit_workspace" => earlier_runs(
                &t,
                ConversationId::new_v7(),
                jt_app::ports::reply_model::PER_WORKSPACE_DAILY,
                0,
            ),
            _ => earlier_runs(
                &t,
                ConversationId::new_v7(),
                1,
                WORKSPACE_DAILY_SPEND_MICRO_USD,
            ),
        }
        job(&t, due(0)).await;
        assert!(t.model.requests().is_empty(), "{limit}");
        handed_to_a_person(&t);
        assert_eq!(reasons(&t, "inbox.autoreply.handed_over"), [limit]);
    }
}

#[tokio::test]
async fn the_capabilitys_daily_cap_counts_the_automatic_replies() {
    let t = setup().await;
    t.w.uow.edit(|st| {
        for c in &mut st.capabilities {
            c.capability.policy.daily_ops_cap = Some(2);
        }
    });
    inbound(&t, 0, 0).await;
    earlier_runs(&t, ConversationId::new_v7(), 2, 0);
    t.model.answer(reply("Merhaba!"));
    job(&t, due(0)).await;
    assert!(texts_sent(&t).is_empty());
    handed_to_a_person(&t);
    assert_eq!(
        reasons(&t, "inbox.autoreply.handed_over"),
        ["daily_ops_cap"]
    );
}

#[tokio::test]
async fn erasing_the_person_drops_what_waits_to_answer_them() {
    let t = setup().await;
    inbound(&t, 0, 0).await;
    assert_eq!(t.w.uow.snapshot().auto_reply.queue.len(), 1);
    let person = conversation(&t).person_id;
    jt_app::usecases::inbox::erasure::erase(
        &t.w.deps,
        &t.w.owner_ctx,
        person,
        serde_json::from_value(json!({"confirm": true})).unwrap(),
    )
    .await
    .unwrap();
    assert!(t.w.uow.snapshot().auto_reply.queue.is_empty());
    assert_eq!(job(&t, due(0)).await.touched, 0);
}
