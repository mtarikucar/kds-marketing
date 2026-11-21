//! The order and its payment link (migration `0050_auto_reply_orders`): when the customer accepts
//! the automatic quote and gives what the order needs, the server creates an order draft in the
//! workspace's own shop (`ports::shop`, a verified `shop_mcp` capability with its order template,
//! `jt_inbox::order`) and sends the customer the payment link.
//!
//! - **Offered** only when an order could pass: a shop to order from (exactly one live, verified
//!   `shop_mcp` capability with an enabled template, and a shop client) and the journey's one
//!   quote, automatic, delivered, unexpired and in the template's currency (or an order already
//!   created, whose link may be asked for again). The model then has a fourth tool,
//!   `create_order`, and [`ORDER_FIXED`] follows the fixed instructions. Otherwise the request is
//!   exactly what it was before orders existed.
//! - **Checked** under the run's lock ([`decide`]), before the shop is asked anything: the shop
//!   (`order_unavailable`, `order_needs_approval`); an order the journey holds (created: its link
//!   is sent again, no call; calling, failed or unknown: `order_exists`); the quote (`no_auto_quote`,
//!   `quote_ambiguous`, `quote_expired`, `order_currency`), whose amount is always the one ordered;
//!   the details, every one the customer's own words (missing, malformed or unclear ones are asked
//!   for once with a fixed message, `order_incomplete`, then `order_details`); the shop's day
//!   ([`ORDERS_DAILY`] unless its daily cap says otherwise, `order_limit`).
//! - **Confirmed** by the customer, judged by the server: the first call sends a fixed summary of
//!   the details, the item and the amount and asks for an explicit yes
//!   (`jt_inbox::order::summary`); the row (`confirming`) keeps only a keyed hash of exactly what
//!   the shop would receive. The order goes ahead only when the summary's send succeeded, every
//!   customer message after that send is an explicit yes (`jt_inbox::order::explicit_yes`, a closed
//!   list of whole messages), no person on the team wrote after the summary
//!   (`order_person_wrote`), and the model calls again with the same details (the same hash).
//!   Anything else shows the summary again, at most [`MAX_SUMMARIES`] in all, then
//!   `order_details`.
//! - **Called** in three steps: the order row (`calling`) commits with the run; the shop is asked
//!   with no transaction open; the outcome is stored in a new locked transaction ([`call`]). The
//!   shop's amount must equal the quote's and its link be a bare `https` URL on the endpoint's own
//!   host. A created order accepts the quote (the journey becomes `Pending`), queues the owner's
//!   notice and sends the model's line and the fixed link message ([`ORDER_LINK`], server text,
//!   outside the reply rules). A take-over, a new customer message or a person's message meanwhile,
//!   or a send fence's refusal, sends nothing: the person gets a note with the reference and the
//!   link (`order_link_unsent`). A refusal, an outage
//!   or an unknown outcome hands the conversation over with the fixed line [`ORDER_LATER`]; an order
//!   left `calling` (a crash) is handed over by the sweep ([`interrupted`], `order_interrupted`).
//! - **Kept**: the order row holds codes, the amount, a keyed hash of the confirmed details, the
//!   shop's reference (letters, digits, `-`, `_` only) and the link; the customer's details exist in
//!   memory only, between the model's answer and the shop's call, and in the conversation's own
//!   messages (the summary).

use hmac::{Hmac, KeyInit, Mac};
use jt_capability::StoredStatus;
use jt_inbox::order::{self, OrderTemplate, ResultError, Values};
use serde_json::Value;
use sha2::Sha256;
use url::Url;

use super::*;
use crate::ports::CapabilityFilter;
use crate::ports::reply_model::{ORDER_CALL_STALE, OrderOffer, OrderRow, OrderState};
use crate::ports::shop::{ShopCall, ShopError};
use crate::usecases::connector::refresh_tenant_hosts;

/// The capability kind of a shop.
pub const SHOP_KIND: &str = "shop_mcp";
/// The most orders a shop is asked for in its local day, unless its daily cap says otherwise.
pub const ORDERS_DAILY: u32 = 10;
/// How many of the customer's latest messages the details and the acceptance are looked for in.
const ORDER_HISTORY: u32 = 100;
/// How long the shop's call may take in all, past the adapter's own bound; then its outcome is
/// unknown.
const CALL_BOUND: std::time::Duration = std::time::Duration::from_secs(20);
/// The most interrupted orders one sweep of a workspace hands over.
const INTERRUPTED_BATCH: u32 = 10;
/// The most summaries an order is shown (new or the same again) before a person takes it
/// (`order_details`).
pub const MAX_SUMMARIES: u32 = 3;
/// The purpose of the per-workspace key the confirmed details are hashed with.
const CONFIRM_KEY: &str = "auto-reply-order-confirm";

/// What follows the fixed instructions when the order is offered.
pub const ORDER_FIXED: &str = "

Ordering:
- When the business has a shop to order from, a fourth tool, `create_order`, creates the order \
for the quoted price; the server then sends the customer the payment link itself.
- After you sent a quote and the customer clearly accepts that price, collect what the order \
needs: full name, email, phone (only if different from this WhatsApp number), street address, \
neighbourhood if they know it, district, province, postcode if they know it, and card or bank \
transfer.
- Ask only for what is still missing, at most three short questions at a time.
- Copy every detail exactly as the customer wrote it: never correct, expand, translate or \
complete a name, an address, an email or a number.
- Call `create_order` when you have them all. The server then shows the customer a summary to \
confirm. When the customer confirms it, call `create_order` again with exactly the same details. \
If the customer corrects something, call it again with the corrected details: a new summary \
follows.
- Never write the summary, their details, an amount or a link yourself, in `text` or anywhere.
- Never promise payment terms, deadlines or refunds the cards do not state. A payment question \
the cards don't answer, a change of the order, or a cancellation: `hand_over` with \
`payment_problem`.
- If the order exists and the customer asks for the link again, call `create_order` again with \
the same details.";

/// The fixed message the payment link goes in; the link follows it.
pub const ORDER_LINK: &str =
    "Siparişiniz oluşturuldu. Ödemeyi kartla ya da havaleyle bu bağlantıdan yapabilirsiniz:";
/// The fixed line to the customer when the order could not be created.
pub const ORDER_LATER: &str =
    "Siparişinizi ekibimiz tamamlayacak, kısa süre içinde dönüş yapacağız.";
/// The second check's facts for the model's line that goes with the link.
pub const ORDER_FACTS: &str = "The server's facts: this message accompanies an order the server \
creates for the quoted amount; it may state no price.";

/// The workspace's shop to order from.
pub(crate) struct Shop {
    pub capability: Capability,
    pub template: OrderTemplate,
    pub endpoint: Url,
}

/// The workspace's shop to order from, or why there is none (see [`shop_in`]).
pub(crate) async fn shop(
    deps: &Deps,
    r: &mut dyn TenantRepos,
) -> Result<Result<Shop, &'static str>, AppError> {
    if deps.connectors.shop().is_none() {
        return Ok(Err("no_shop"));
    }
    let shops = r
        .capabilities()
        .list(CapabilityFilter {
            kind: Some(SHOP_KIND),
            ..Default::default()
        })
        .await?;
    Ok(shop_in(true, &shops))
}

/// The shop to order from among `capabilities`, with a shop client here (`client`), or why there
/// is none: `no_shop` (no client, no live `shop_mcp` capability, or several verified ones),
/// `not_verified` (none verified, or one without an https endpoint), `no_template` (no valid,
/// enabled order template).
pub(crate) fn shop_in(client: bool, capabilities: &[Capability]) -> Result<Shop, &'static str> {
    if !client {
        return Err("no_shop");
    }
    let live: Vec<&Capability> = capabilities
        .iter()
        .filter(|c| c.kind_key == SHOP_KIND && c.status != StoredStatus::Retired)
        .collect();
    if live.is_empty() {
        return Err("no_shop");
    }
    let verified: Vec<&Capability> = live
        .into_iter()
        .filter(|c| c.status == StoredStatus::Verified)
        .collect();
    let capability = match verified.as_slice() {
        [] => return Err("not_verified"),
        [one] => (*one).clone(),
        _ => return Err("no_shop"),
    };
    let Some(endpoint) = capability.connector_public["endpoint"]
        .as_str()
        .and_then(|e| Url::parse(e).ok())
        .filter(|u| u.scheme() == "https" && u.host_str().is_some())
    else {
        return Err("not_verified");
    };
    let Some(template) =
        OrderTemplate::of_public(&capability.connector_public).filter(|t| t.enabled)
    else {
        return Err("no_template");
    };
    Ok(Shop {
        capability,
        template,
        endpoint,
    })
}

/// The order tool's offer for conversation `c` (see the module docs): only when an order could
/// pass, read without a write.
pub(super) async fn offer(
    deps: &Deps,
    r: &mut dyn TenantRepos,
    c: &Conversation,
    now: OffsetDateTime,
) -> Result<Option<OrderOffer>, AppError> {
    if deps.connectors.shop().is_none() {
        return Ok(None);
    }
    let Ok(shop) = shop(deps, r).await? else {
        return Ok(None);
    };
    let Some(journey) = crate::usecases::inbox::active_or_latest_journey(r, c.person_id).await?
    else {
        return Ok(None);
    };
    let existing = r.auto_reply().order_by_journey(journey.id).await?;
    if let Some(o) = existing.as_ref().filter(|o| o.state == OrderState::Created) {
        return Ok(Some(OrderOffer {
            amount_minor: o.amount_minor,
            currency: o.currency.clone(),
            valid_until: now,
            done: Some(o.reference.clone().unwrap_or_default()),
        }));
    }
    let Ok(quote) = order_quote(r, journey.id, &shop.template.currency, now).await? else {
        return Ok(None);
    };
    Ok(Some(OrderOffer {
        amount_minor: quote.quote.amount_minor,
        currency: quote.quote.currency,
        valid_until: quote.quote.valid_until,
        done: None,
    }))
}

/// What the workspace's part says of an order already created (`reference`: the shop's, as
/// cleaned; empty for none shown).
pub(super) fn done_part(reference: &str) -> String {
    let named = if reference.is_empty() {
        String::new()
    } else {
        format!(" The shop's reference is {reference}.")
    };
    format!(
        "\n# The order\nThis customer's order was created and its payment link sent.{named} \
         Answer questions about it only from the cards. A change, a cancellation or a payment \
         question the cards do not answer: `hand_over` with `payment_problem`.\n"
    )
}

/// The message the payment link goes out in: the model's line, when it wrote one, then the
/// fixed text and the link.
fn link_message(line: Option<&str>, url: &str) -> String {
    match line {
        Some(line) => format!("{line}\n\n{ORDER_LINK} {url}"),
        None => format!("{ORDER_LINK} {url}"),
    }
}

/// An order the shop is to be asked for once the run's transaction commits.
pub(super) struct Pending {
    row: OrderRow,
    order: order::CheckedOrder,
    line: Option<String>,
    sealed: Vec<u8>,
    template: OrderTemplate,
    endpoint: Url,
}

/// The model's line, when it wrote one: the reply rules and the second check, as any reply's.
/// `Err` with the reason it is refused.
fn checked_line(
    text: &str,
    s: &Snapshot,
    verdict: Verdict,
    year: i32,
) -> Result<Option<String>, &'static str> {
    let line = text.trim();
    if line.is_empty() {
        return Ok(None);
    }
    rules::check_reply(line, &s.cards, year).map_err(|r| r.key())?;
    if let Some(reason) = verdict.refusal() {
        return Err(reason);
    }
    Ok(Some(line.to_owned()))
}

/// The journey's one automatic, delivered, valid quote in `currency`, or why there is none.
async fn order_quote(
    r: &mut dyn TenantRepos,
    journey: JourneyId,
    currency: &str,
    now: OffsetDateTime,
) -> Result<Result<QuoteRow, &'static str>, AppError> {
    let mut quotes = r.quotes().list(journey).await?;
    let q = match quotes.len() {
        0 => return Ok(Err("no_auto_quote")),
        1 => quotes.remove(0),
        _ => return Ok(Err("quote_ambiguous")),
    };
    if r.auto_reply().run_by_quote(q.id).await?.is_none() {
        return Ok(Err("no_auto_quote"));
    }
    if r.journeys()
        .event_by_key(&format!("quote:{}:sent", q.id))
        .await?
        .filter(|e| e.kind == JourneyEventKind::QuoteSent && e.journey_id == journey)
        .is_none()
    {
        return Ok(Err("no_auto_quote"));
    }
    if q.quote.state != QuoteState::Sent || q.quote.valid_until <= now {
        return Ok(Err("quote_expired"));
    }
    if q.quote.currency != currency {
        return Ok(Err("order_currency"));
    }
    Ok(Ok(q))
}

/// The phone number conversation `c` is with: its last inbound phone identity, else the person's
/// one active phone.
async fn own_phone(r: &mut dyn TenantRepos, c: &Conversation) -> Result<Option<String>, AppError> {
    let last = r
        .conversations()
        .send_state(c.id)
        .await?
        .last_inbound_identity_id;
    let phones: Vec<Identity> = r
        .identities()
        .list(c.person_id)
        .await?
        .into_iter()
        .filter(|i| i.active && i.channel == IdentityChannel::Phone)
        .collect();
    Ok(phones
        .iter()
        .find(|i| Some(i.id) == last)
        .or_else(|| (phones.len() == 1).then(|| &phones[0]))
        .map(|i| i.value_normalized.clone()))
}

/// The arguments the shop receives for `checked`, the order's reference left empty (it is the
/// row's id, fixed per order).
fn shop_arguments(
    template: &OrderTemplate,
    checked: &order::CheckedOrder,
    quote: &QuoteRow,
) -> Value {
    order::render(
        &template.arguments,
        &Values {
            reference: "",
            amount_minor: quote.quote.amount_minor,
            currency: &quote.quote.currency,
            order: checked,
        },
    )
}

/// The keyed hash of exactly what the shop receives (`arguments`: every detail as written, the
/// line items, the amount) and the quote it orders: HMAC-SHA256 under the workspace's own key for
/// it, in hex.
fn confirm_hash(
    deps: &Deps,
    ws: WorkspaceId,
    arguments: &Value,
    quote: &QuoteRow,
) -> Result<String, AppError> {
    let key = deps.seal.hmac_key(ws, CONFIRM_KEY)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_ref())
        .map_err(|_| AppError::internal("an HMAC key of the wrong length"))?;
    mac.update(arguments.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(quote.id.to_string().as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// What became of the summary queued as outbox row `summary`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    /// Sent, and every customer message since says yes (at least one).
    Confirmed,
    /// Not sent (held, refused, still queued), no customer message since, or one that is not a
    /// yes.
    NotConfirmed,
    /// A person on the team wrote in the conversation after it (queued or sent).
    PersonWrote,
}

/// When outbox row `row` was handed to the provider: the send time its claim recorded, else its
/// last update.
fn sent_at(row: &crate::ports::inbox::OutboxRow) -> OffsetDateTime {
    row.fence_snapshot
        .as_ref()
        .and_then(|s| s.get("send_at"))
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<i128>().ok())
        .and_then(|n| OffsetDateTime::from_unix_timestamp_nanos(n).ok())
        .unwrap_or(row.updated_at)
}

/// Whether a message written by a person on the team (in the panel or the phone's Business app,
/// queued or sent) is in `messages` after `since`.
fn person_wrote(messages: &[Message], since: OffsetDateTime) -> bool {
    messages.iter().any(|m| {
        m.direction == Direction::Outbound
            && matches!(m.author, Author::Human(_) | Author::BusinessApp)
            && m.at > since
    })
}

/// Whether a person on the team wrote in order `o`'s conversation (queued or sent) after its
/// summary was queued.
async fn person_after_summary(r: &mut dyn TenantRepos, o: &OrderRow) -> Result<bool, AppError> {
    let Some(summary) = o.summary_outbox_id else {
        return Ok(false);
    };
    let Some(row) = r.outbox().get(summary).await? else {
        return Ok(false);
    };
    let Some(shown) = r.messages().get(row.message_id).await? else {
        return Ok(false);
    };
    let messages = r
        .messages()
        .recent(o.conversation_id, ORDER_HISTORY)
        .await?;
    Ok(person_wrote(&messages, shown.at))
}

/// What the customer made of the summary queued as outbox row `summary` (see [`Answer`]): it
/// counts only once its send succeeded; then every customer message after that send must be an
/// explicit yes, and no person on the team may have written after it was queued.
async fn answer_to(
    r: &mut dyn TenantRepos,
    messages: &[Message],
    summary: Option<Uuid>,
) -> Result<Answer, AppError> {
    let Some(summary) = summary else {
        return Ok(Answer::NotConfirmed);
    };
    let Some(row) = r.outbox().get(summary).await? else {
        return Ok(Answer::NotConfirmed);
    };
    let Some(shown) = r.messages().get(row.message_id).await? else {
        return Ok(Answer::NotConfirmed);
    };
    if person_wrote(messages, shown.at) {
        return Ok(Answer::PersonWrote);
    }
    if row.state != "sent" {
        return Ok(Answer::NotConfirmed);
    }
    let since = sent_at(&row);
    let after: Vec<&Message> = messages
        .iter()
        .filter(|m| m.direction == Direction::Inbound && m.at > since)
        .collect();
    Ok(
        if !after.is_empty() && after.iter().all(|m| order::explicit_yes(&m.body)) {
            Answer::Confirmed
        } else {
            Answer::NotConfirmed
        },
    )
}

/// `create_order` (see the module docs), in step 3's transaction.
#[allow(clippy::too_many_arguments)]
pub(super) async fn decide(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    s: &Snapshot,
    c: &Conversation,
    run_id: Uuid,
    fields: Box<order::OrderFields>,
    text: String,
    verdict: Verdict,
) -> Result<Decided, AppError> {
    let year = ctx.now.year();
    let shop = match shop(deps, r).await? {
        Ok(shop) => shop,
        Err(_) => return server_refused(deps, ctx, r, c, run_id, "order_unavailable").await,
    };
    let Some(journey) = crate::usecases::inbox::active_or_latest_journey(r, c.person_id).await?
    else {
        return server_refused(deps, ctx, r, c, run_id, "no_auto_quote").await;
    };
    // One order per journey: a created one's link is sent again; one being confirmed goes on
    // below; anything else is a person's.
    let existing = r.auto_reply().order_by_journey(journey.id).await?;
    if let Some(existing) = existing
        .as_ref()
        .filter(|o| o.state != OrderState::Confirming)
    {
        let url = existing
            .pay_url
            .clone()
            .filter(|_| existing.state == OrderState::Created);
        let Some(url) = url else {
            return server_refused(deps, ctx, r, c, run_id, "order_exists").await;
        };
        let line = match checked_line(&text, s, verdict, year) {
            Ok(line) => line,
            Err(reason) => return server_refused(deps, ctx, r, c, run_id, reason).await,
        };
        let mut decided = queue(
            deps,
            ctx,
            r,
            s,
            c,
            run_id,
            &link_message(line.as_deref(), &url),
            None,
        )
        .await?;
        if decided.outcome == RunOutcome::Replied {
            decided.outcome = RunOutcome::Ordered;
            decided.reason = Some("replay".into());
            record(
                r,
                ctx,
                "inbox.autoreply.ordered",
                "conversation",
                c.id,
                json!({
                    "run_id": run_id,
                    "order_id": existing.id,
                    "quote_id": existing.quote_id,
                    "amount_minor": existing.amount_minor,
                    "currency": existing.currency,
                    "replayed": true,
                }),
            )
            .await?;
        }
        return Ok(decided);
    }
    if shop.capability.policy.requires_human_approval {
        return server_refused(deps, ctx, r, c, run_id, "order_needs_approval").await;
    }
    let quote = match order_quote(r, journey.id, &shop.template.currency, ctx.now).await? {
        Ok(found) => found,
        Err(reason) => return server_refused(deps, ctx, r, c, run_id, reason).await,
    };
    // What the customer wrote in this journey.
    let messages = r.messages().recent(c.id, ORDER_HISTORY).await?;
    let customer: Vec<&str> = messages
        .iter()
        .filter(|m| m.direction == Direction::Inbound && m.at >= journey.opened_at)
        .map(|m| m.body.as_str())
        .collect();
    let phone = own_phone(r, c).await?;
    let checked = match order::check(&fields, &customer, phone.as_deref(), year) {
        Ok(checked) => checked,
        Err(missing) => {
            // Asked for once; a second time a person takes it.
            if r.auto_reply()
                .runs_with_reason(c.id, "order_incomplete", journey.opened_at)
                .await?
                > 0
            {
                return server_refused(deps, ctx, r, c, run_id, "order_details").await;
            }
            let mut decided =
                queue(deps, ctx, r, s, c, run_id, &order::ask(&missing), None).await?;
            if decided.outcome == RunOutcome::Replied {
                decided.reason = Some("order_incomplete".into());
            }
            return Ok(decided);
        }
    };
    drop(fields);
    let arguments = shop_arguments(&shop.template, &checked, &quote);
    let hash = confirm_hash(deps, ctx.workspace_id, &arguments, &quote)?;
    let same = existing
        .as_ref()
        .is_some_and(|o| o.confirm_hash.as_deref() == Some(hash.as_str()));
    let answer = match &existing {
        Some(o) => answer_to(r, &messages, o.summary_outbox_id).await?,
        None => Answer::NotConfirmed,
    };
    if answer == Answer::PersonWrote {
        // A person on the team is in the conversation: nothing is ordered, it is theirs.
        return server_refused(deps, ctx, r, c, run_id, "order_person_wrote").await;
    }
    if !(same && answer == Answer::Confirmed) {
        // The summary (again, or anew): nothing is ordered until the customer confirms it.
        if existing
            .as_ref()
            .is_some_and(|o| o.summaries >= MAX_SUMMARIES)
        {
            return server_refused(deps, ctx, r, c, run_id, "order_details").await;
        }
        let text = order::summary(
            &checked,
            order::quantity_of(&arguments),
            quote.quote.amount_minor,
            &quote.quote.currency,
        );
        drop(checked);
        drop(arguments);
        let mut decided = queue(deps, ctx, r, s, c, run_id, &text, None).await?;
        let Some(outbox) = decided
            .outbox_id
            .filter(|_| decided.outcome == RunOutcome::Replied)
        else {
            return Ok(decided);
        };
        decided.reason = Some("order_summary".into());
        match existing {
            Some(mut o) => {
                o.confirm_hash = Some(hash);
                o.summary_outbox_id = Some(outbox);
                o.run_id = run_id;
                o.summaries += 1;
                r.auto_reply().order_save(&o).await?;
            }
            None => {
                let row = OrderRow {
                    id: deps.ids.uuid(),
                    journey_id: journey.id,
                    conversation_id: c.id,
                    quote_id: quote.id,
                    shop_capability_id: shop.capability.id,
                    run_id,
                    state: OrderState::Confirming,
                    reason: None,
                    amount_minor: quote.quote.amount_minor,
                    currency: quote.quote.currency.clone(),
                    reference: None,
                    pay_url: None,
                    created_at: ctx.now,
                    finished_at: None,
                    confirm_hash: Some(hash),
                    summary_outbox_id: Some(outbox),
                    summaries: 1,
                    called_at: None,
                    generation: None,
                };
                if !r.auto_reply().order_insert(&row).await? {
                    return Err(AppError::conflict("an order of this journey exists"));
                }
            }
        }
        return Ok(decided);
    }
    drop(arguments);
    // Confirmed: the shop's day first (only orders the shop was asked for count), then the shop
    // is asked once the run commits.
    let Some(mut row) = existing else {
        return Err(AppError::internal("a confirmation without its order"));
    };
    let (day_start, _) = crate::usecases::calls::local_day(&shop.capability, ctx.now);
    let cap = shop.capability.policy.daily_ops_cap.unwrap_or(ORDERS_DAILY);
    if r.auto_reply()
        .orders_since(shop.capability.id, day_start)
        .await?
        >= cap
    {
        return server_refused(deps, ctx, r, c, run_id, "order_limit").await;
    }
    let line = match checked_line(&text, s, verdict, year) {
        Ok(line) => line,
        Err(reason) => return server_refused(deps, ctx, r, c, run_id, reason).await,
    };
    let Some(sealed) = r.capabilities().read_sealed(shop.capability.id).await? else {
        return server_refused(deps, ctx, r, c, run_id, "order_unavailable").await;
    };
    row.state = OrderState::Calling;
    row.run_id = run_id;
    row.called_at = Some(ctx.now);
    row.generation = Some(s.generation);
    row.shop_capability_id = shop.capability.id;
    r.auto_reply().order_save(&row).await?;
    Ok(Decided {
        outcome: RunOutcome::Ordered,
        reason: Some("pending".into()),
        outbox_id: None,
        quote_id: Some(quote.id),
        amount_minor: Some(row.amount_minor),
        order: Some(Box::new(Pending {
            row,
            order: checked,
            line,
            sealed,
            template: shop.template,
            endpoint: shop.endpoint,
        })),
    })
}

/// Why the shop's call came to no created order: the order's state, the reason, and the shop's
/// reference when it gave one.
struct Failure {
    state: OrderState,
    reason: &'static str,
    reference: Option<String>,
}

fn failure(state: OrderState, reason: &'static str) -> Failure {
    Failure {
        state,
        reason,
        reference: None,
    }
}

/// Step 2: asks the shop, no transaction open. The details go to the shop alone and are dropped
/// with `p`.
async fn ask_shop(deps: &Deps, ws: WorkspaceId, p: Pending) -> Result<order::OrderResult, Failure> {
    let Some(client) = deps.connectors.shop() else {
        return Err(failure(OrderState::Failed, "order_unavailable"));
    };
    if let Err(e) = refresh_tenant_hosts(deps, ws).await {
        warn(Some(ws), e.code.as_str());
        return Err(failure(OrderState::Failed, "order_unavailable"));
    }
    let Ok(credential) = open_credential(deps, ws, &p.sealed) else {
        return Err(failure(OrderState::Failed, "order_unavailable"));
    };
    let reference = p.row.id.to_string();
    let call = ShopCall {
        tool: p.template.tool.clone(),
        arguments: order::render(
            &p.template.arguments,
            &Values {
                reference: &reference,
                amount_minor: p.row.amount_minor,
                currency: &p.row.currency,
                order: &p.order,
            },
        ),
    };
    drop(p.order);
    let answered = tokio::time::timeout(
        CALL_BOUND,
        client.call_tool(ws, &p.endpoint, &credential, &call),
    )
    .await;
    drop(call);
    drop(credential);
    let result = match answered {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => {
            warn(Some(ws), e.key());
            return Err(match e {
                ShopError::Auth => failure(OrderState::Failed, "order_auth"),
                ShopError::Rejected { .. } => failure(OrderState::Failed, "order_rejected"),
                ShopError::Unavailable => failure(OrderState::Failed, "order_unavailable"),
                ShopError::Unknown | ShopError::Malformed => {
                    failure(OrderState::Unknown, "order_unknown")
                }
            });
        }
        Err(_) => return Err(failure(OrderState::Unknown, "order_unknown")),
    };
    let created = order::read_result(&result, &p.template.result).map_err(|e| match e {
        ResultError::Refused => failure(OrderState::Failed, "order_rejected"),
        ResultError::Malformed => failure(OrderState::Unknown, "order_unknown"),
    })?;
    let reference = order::clean_reference(created.reference.as_deref());
    // The amount is always the quote's, before anything else is looked at.
    if created.amount_minor != Some(p.row.amount_minor) {
        return Err(Failure {
            state: OrderState::Failed,
            reason: "order_amount_mismatch",
            reference,
        });
    }
    // A bare https link on the endpoint's own host, sent as the parser reads it.
    let host = |u: &Url| u.host_str().map(str::to_ascii_lowercase);
    let link = Url::parse(&created.url).ok().filter(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && host(u).is_some()
            && host(u) == host(&p.endpoint)
            && u.port() == p.endpoint.port()
    });
    let Some(link) = link else {
        return Err(Failure {
            state: OrderState::Failed,
            reason: "order_link_host",
            reference,
        });
    };
    Ok(order::OrderResult {
        url: link.as_str().to_owned(),
        reference,
        amount_minor: created.amount_minor,
    })
}

/// Steps 2 and 3 of an order decided in `run` (see the module docs).
pub(super) async fn call(
    deps: &Deps,
    ctx: &Ctx,
    s: &Snapshot,
    run: RunRow,
    p: Pending,
) -> Result<Worked, AppError> {
    let ws = ctx.workspace_id;
    let row = p.row.clone();
    let line = p.line.clone();
    let outcome = ask_shop(deps, ws, p).await;
    let ctx = system_ctx(ws, deps.clock.now().max(ctx.now));
    finish_order(deps, &ctx, s, run, row, outcome, line).await
}

/// A note for the person on the journey of order `o`.
async fn note(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    o: &OrderRow,
    text: String,
) -> Result<(), AppError> {
    r.notes()
        .insert(Note {
            id: NoteId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            journey_id: o.journey_id,
            author: EventSource::System,
            text,
            at: ctx.now,
        })
        .await
}

/// What the person is told of a failed order: its code, the shop's reference when known, and
/// what to look for at the shop (an order may exist there whatever the outcome).
fn failure_note(o: &OrderRow) -> String {
    let mut text = format!(
        "Sipariş oluşturulamadı ({}).",
        o.reason.as_deref().unwrap_or("order_failed")
    );
    if let Some(reference) = &o.reference {
        text.push_str(&format!(" Mağaza referansı: {reference}."));
    }
    text.push_str(&format!(
        " Mağazada jeeta_ref {} ile oluşmuş bir sipariş olup olmadığına bakın.",
        o.id
    ));
    text
}

/// Hands conversation `c` (when it is still the agent's) to a person over a failed order, with
/// the fixed line and the note; else only the note. The line's outbox id, when one was queued.
async fn hand_over_failed(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    c: Option<&Conversation>,
    o: &OrderRow,
) -> Result<Option<Uuid>, AppError> {
    let reason = o.reason.clone().unwrap_or_else(|| "order_failed".into());
    record(
        r,
        ctx,
        "inbox.autoreply.refused",
        "conversation",
        o.conversation_id,
        json!({ "run_id": o.run_id, "reason": reason }),
    )
    .await?;
    let text = failure_note(o);
    match c {
        Some(c) => {
            hand_over(
                deps,
                ctx,
                r,
                c,
                HandOver {
                    run_id: Some(o.run_id),
                    reason: &reason,
                    by: By::Server,
                    summary: Some(&text),
                    line: Some(ORDER_LATER),
                    cards: "",
                    line_allowed: true,
                },
            )
            .await
        }
        None => {
            note(deps, ctx, r, o, text).await?;
            Ok(None)
        }
    }
}

/// Step 3: the shop's `outcome` for order `row` of `run`, stored in a new locked transaction.
async fn finish_order(
    deps: &Deps,
    ctx: &Ctx,
    s: &Snapshot,
    mut run: RunRow,
    row: OrderRow,
    outcome: Result<order::OrderResult, Failure>,
    line: Option<String>,
) -> Result<Worked, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let Some(mut o) = r
        .auto_reply()
        .order_lock(row.id)
        .await?
        .filter(|o| o.state == OrderState::Calling)
    else {
        // The sweep took it as interrupted meanwhile.
        return Ok(Worked::Skipped);
    };
    let c = r.conversations().lock(row.conversation_id).await?;
    let activity = r
        .conversations()
        .send_state(row.conversation_id)
        .await?
        .activity_revision;
    let person = person_after_summary(r.as_mut(), &o).await?;
    // Still the agent's, ours, as when the model was asked (generation and activity), and no person
    // on the team writing since the summary: only then does anything go out.
    let current = c.filter(|c| {
        c.executor == Executor::Agent
            && c.executor_generation == s.generation
            && c.state == ConvState::Ours
            && activity == s.activity_revision
            && !person
    });
    // The conversation as it is, when still the agent's and ours (for a hand-over).
    o.finished_at = Some(ctx.now);
    let mut outboxes = Vec::new();
    let worked = match outcome {
        Ok(created) => {
            o.state = OrderState::Created;
            o.reference = created.reference.clone();
            o.pay_url = Some(created.url.clone());
            r.auto_reply().order_save(&o).await?;
            accept_quote(deps, ctx, r.as_mut(), o.quote_id).await?;
            record(
                r.as_mut(),
                ctx,
                "inbox.autoreply.ordered",
                "conversation",
                o.conversation_id,
                json!({
                    "run_id": run.id,
                    "order_id": o.id,
                    "quote_id": o.quote_id,
                    "amount_minor": o.amount_minor,
                    "currency": o.currency,
                }),
            )
            .await?;
            crate::usecases::inbox::notices::queue_best_effort(
                deps,
                ctx,
                r.as_mut(),
                NoticeKind::OrderCreated,
                o.conversation_id,
                format!("order:{}", o.id),
                None,
            )
            .await?;
            let message = link_message(line.as_deref(), &created.url);
            let sent = match &current {
                Some(c) => {
                    replies::supersede_held_auto(r.as_mut(), ctx, c.id).await?;
                    let send = replies::AutoSend {
                        run_id: run.id,
                        expected_generation: s.generation,
                        activity_revision: r
                            .conversations()
                            .send_state(c.id)
                            .await?
                            .activity_revision,
                        quote: None,
                        handing_over: false,
                    };
                    enqueue(deps, ctx, r.as_mut(), c.id, &message, &send).await?
                }
                None => Err("order_link_unsent".to_owned()),
            };
            match sent {
                Ok(outbox) => {
                    outboxes.push(outbox);
                    run.outcome = RunOutcome::Ordered;
                    run.reason = None;
                    run.outbox_id = Some(outbox);
                    Worked::Answered
                }
                Err(_) => {
                    // Nothing went out: the person sends the link.
                    let text = format!(
                        "Sipariş oluşturuldu ama ödeme bağlantısı otomatik gönderilemedi. Mağaza \
                         referansı: {}. Bağlantı: {}",
                        o.reference.as_deref().unwrap_or("-"),
                        created.url
                    );
                    record(
                        r.as_mut(),
                        ctx,
                        "inbox.autoreply.refused",
                        "conversation",
                        o.conversation_id,
                        json!({ "run_id": run.id, "reason": "order_link_unsent" }),
                    )
                    .await?;
                    match &current {
                        Some(c) => {
                            hand_over(
                                deps,
                                ctx,
                                r.as_mut(),
                                c,
                                HandOver {
                                    run_id: Some(run.id),
                                    reason: "order_link_unsent",
                                    by: By::Server,
                                    summary: Some(&text),
                                    line: None,
                                    cards: "",
                                    line_allowed: false,
                                },
                            )
                            .await?;
                        }
                        None => note(deps, ctx, r.as_mut(), &o, text).await?,
                    }
                    run.outcome = RunOutcome::Ordered;
                    run.reason = Some("order_link_unsent".into());
                    Worked::HandedOver
                }
            }
        }
        Err(f) => {
            o.state = f.state;
            o.reason = Some(f.reason.to_owned());
            o.reference = f.reference;
            r.auto_reply().order_save(&o).await?;
            if let Some(outbox) =
                hand_over_failed(deps, ctx, r.as_mut(), current.as_ref(), &o).await?
            {
                outboxes.push(outbox);
            }
            run.outcome = RunOutcome::HandedOver;
            run.reason = Some(f.reason.to_owned());
            Worked::HandedOver
        }
    };
    r.auto_reply().run_update(&run).await?;
    r.commit().await?;
    for outbox in outboxes {
        if let Err(e) = replies::send_step(deps, ctx, outbox).await {
            warn(Some(ctx.workspace_id), e.code.as_str());
        }
    }
    Ok(worked)
}

/// Accepts the ordered quote (the journey becomes `Pending`) inside a savepoint: should it fail
/// (the journey closed meanwhile), only the acceptance is undone (logged by code), and the order
/// stands.
async fn accept_quote(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: Uuid,
) -> Result<(), AppError> {
    let Some(quote) = r.quotes().get(id).await? else {
        return Ok(());
    };
    if quote.quote.state == QuoteState::Accepted {
        return Ok(());
    }
    if let Err(e) = r.savepoint().await {
        warn(Some(ctx.workspace_id), e.code.as_str());
        return Ok(());
    }
    match crate::usecases::inbox::quotes::accept_in(deps, ctx, r, quote).await {
        Ok(_) => r.release_savepoint().await,
        Err(e) => {
            warn(Some(ctx.workspace_id), e.code.as_str());
            r.rollback_to_savepoint().await?;
            r.release_savepoint().await
        }
    }
}

/// The sweep's part for workspace `ws` (see [`reconcile`]): every order left `calling` longer
/// than [`ORDER_CALL_STALE`] (a crash between the shop's call and its answer) becomes `unknown`,
/// and its conversation goes to a person (`order_interrupted`). Errors are logged with a code.
pub(super) async fn interrupted(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) {
    let result = async {
        let ids = {
            let mut r = deps.uow.tenant(ws).await?;
            r.auto_reply()
                .orders_calling_before(now - ORDER_CALL_STALE, INTERRUPTED_BATCH)
                .await?
        };
        let ctx = system_ctx(ws, now);
        for id in ids {
            let mut r = deps.uow.tenant(ws).await?;
            r.people().lock_workspace().await?;
            r.people().set_write_time(now).await?;
            let Some(mut o) = r
                .auto_reply()
                .order_lock(id)
                .await?
                .filter(|o| o.state == OrderState::Calling)
            else {
                continue;
            };
            o.state = OrderState::Unknown;
            o.reason = Some("order_interrupted".into());
            o.finished_at = Some(now);
            r.auto_reply().order_save(&o).await?;
            // Still the agent's and ours under the generation the shop was asked under, and no
            // person on the team writing since the summary: only then does the line go out.
            let person = person_after_summary(r.as_mut(), &o).await?;
            let current = r
                .conversations()
                .lock(o.conversation_id)
                .await?
                .filter(|c| {
                    c.executor == Executor::Agent
                        && c.state == ConvState::Ours
                        && Some(c.executor_generation) == o.generation
                        && !person
                });
            let outbox = hand_over_failed(deps, &ctx, r.as_mut(), current.as_ref(), &o).await?;
            r.commit().await?;
            if let Some(outbox) = outbox
                && let Err(e) = replies::send_step(deps, &ctx, outbox).await
            {
                warn(Some(ws), e.code.as_str());
            }
        }
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(e) = result {
        warn(Some(ws), e.code.as_str());
    }
}
