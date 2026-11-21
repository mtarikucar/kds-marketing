# Inbox auto-reply (Claude API)

The server can answer a customer's WhatsApp message itself, through the Claude API, within what
the workspace owner set in Kurallar and what the knowledge cards say. Anything outside the
standard goes to a person. This reverses the "no AI inside Jeeta" rule for inbox replies only
(spec `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`, addendum C).

Code: `rust/crates/jt_app/src/usecases/inbox/autoreply.rs` (the use case), `rust/crates/domain/
jt_inbox/src/autoreply.rs` (the server's rules), `rust/crates/adapters/jt_claude` (the API
adapter), migrations `0047_inbox_auto_reply`, `0048_inbox_person_latest` (an index for the
person's-hold lookup), `0049_owner_notices` (the owner's email notices) and
`0050_auto_reply_orders` (the orders, below; the use case's part is
`usecases/inbox/autoreply/orders.rs`, the template rules `jt_inbox/src/order.rs`, the shop's MCP
client `rust/crates/adapters/jt_mcp_client`).

## Configuration

| Variable | Meaning |
|---|---|
| `JEETA_ANTHROPIC_API_KEY` | The platform's Claude API key. Optional. Unset: the feature is off in every workspace and the panel says "Sunucuda Claude anahtarı yok". A secret: never logged, masked in `Debug`, wiped from memory when dropped. |
| `JEETA_AUTOREPLY_MODEL` | The model; `claude-haiku-5-5` when unset. A model `jt_claude` has no prices for refuses the start. |

The key goes into `/etc/jeeta/jeeta.env` (root:jeeta, 0640) as `JEETA_ANTHROPIC_API_KEY=...`,
then `systemctl restart jeeta`. Requests go to `api.anthropic.com` only (the `anthropic` entry of
`jt_outbound`'s fixed hosts), under a 20 s timeout. A customer's photo is read from Meta
(`graph.facebook.com`, then `lookaside.fbsbx.com`, both `meta` entries of the fixed hosts).

## Turning it on for a workspace

**Turning it on sends the number's customer messages, their text and their photos, to Anthropic
(the Claude API).** Photos can show faces and children. The owner's privacy notice must say so
before the switch is turned on (see "Data protection").

1. The workspace is `active` (a `pending_payment` workspace sends nothing), the inbox module is
   installed and its WhatsApp number is connected and verified.
2. The owner opens Bilgi bankası → Kurallar → Düzenle, turns on "Mesajlara otomatik yanıt" for the
   number and enters the range ("En az", "En çok"). Saving creates the card "Standart iş ve fiyat".
3. The owner writes that card in their own words: what the standard work is, what places a price
   low or high in the range, and what is outside the standard. Until it has text the feature
   waits, and Kurallar says so.

Kurallar then shows one line: "Mesajlara otomatik yanıt: WhatsApp · ₺min–₺max".

## What it does

- A customer's message is scheduled 12 s after the last one of a burst (never more than 45 s after
  the first); the `inbox_auto_reply` job runs every 3 s. The model reads the fixed instructions,
  the workspace's cards, rules, notes and range, and the last 30 messages.
- A customer's photo is stored as the text `[image]` (and its caption on the next line); a
  document as `[document: name]` (and its caption). When the model is asked, the latest four of
  the customer's photos in those messages are read from Meta by the inbound event's media id, in
  memory only, and shown to the model as images in the customer's turn: JPEG, PNG or WebP by
  their bytes, at most 5 MiB each, 8 s each and 15 s in all. A photo that cannot be read (an
  error, too large, another type, too slow) is shown as its text with a note that the model cannot
  see it; an older photo with a note that it is not shown. Documents and 3D files are never read:
  the model is told it cannot open them. The model uses what it sees to place the work in the
  range, and hands over when a photo is unclear or shows something outside the standard. The
  server's check on the answer stays text-only.
- It answers through one tool: a reply, a quote, or a hand-over to a person.
- It never says or implies it is a person. Asked whether the customer is talking to a person, a bot
  or an AI, it says in one short sentence that it is the business's automatic assistant and that a
  person from the team can take over whenever the customer wants; it does not say so unprompted. A
  customer who then asks for a person is handed over (`asks_for_person`). It writes short, everyday
  messages in the customer's language, with at most one emoji and at most three short questions at
  a time. The server's check never refuses a message for saying it is the automatic assistant.
- The server checks every answer. A reply (and a hand-over's line) is first normalised (NFKC,
  zero-width and other format characters removed, every script's digits as ASCII, Turkish lower
  case); then every digit sequence is refused unless it is a date, a clock time, a phone number,
  a count with an allowed unit (gün, saat, hafta, ay, cm, mm, adet …) or the bare current or next
  year; number words that build an amount ("bin" with any suffix, "dokuz yüz", "elliye", "iki
  buçuk bin") and the money lexicon (currency words and symbols, indirim, iskonto, kdv, yüzde, %,
  bedava, beleş, ücretsiz, yarı fiyat, taksit, peşin, kapora, hediye çeki) are refused. No link
  the cards lack (any `label.tld`, an IP address, an `xn--` name, anything with a scheme). A quote
  is within the range, states that amount exactly once next to its currency and nothing else of
  money, and is the journey's first one that went out; the currency is the workspace's.
- Whatever passes those rules is checked once more by the model (one strict `verdict` tool):
  anything but a clear "allowed" (a refusal, an error, no answer) is not sent and the conversation
  goes to a person (`judge_refused`, `judge_unavailable`). The check is a model call like any
  other: recorded, counted and paid for.
- It stops when a person takes the conversation over, or when a newer message arrives (that one is
  answered instead). Once a person writes in the conversation (in the panel, or from the phone's
  Business App) it stays out for the rest of that customer journey and for at least 24 hours
  after the person's last message, unless a person hands the conversation back to the agent;
  then a customer message still waiting inside the reply window is answered at once. While the
  replies stay out of a conversation, agents are offered it as usual. The hand-back's mark commits
  with the hand-back itself, so no agent is offered the conversation in between. A held or queued
  automatic reply whose conversation moved on is refused (`stale`).
- The capability's policy applies: approval (the reply waits in the approvals list and in the
  conversation, where it can be approved or discarded; automatic messages carry an "otomatik"
  mark there), working hours
  (outside them the conversation goes to a person) and the daily cap.
- Limits per local day: 24 model calls per conversation and 600 per workspace (each automatic
  message takes two: the answer and its check), $2 of model cost per workspace. Reaching one
  hands the conversation over.
- Every model call is recorded at once and counts towards the day's limits and spend (a failed
  call at a conservative estimate). A rate limit or an outage is asked again; after three calls on
  one burst (counted before any step that could fail) the conversation goes to a person
  (`failed`). One tick works at most five conversations and 8 s per workspace, starts after the
  workspace it served last, and stops starting new ones after 20 s. Once a minute, inside that
  budget, the job also schedules a customer message left without a schedule (a crash between the
  consumer and the schedule), only when it is at most 15 minutes old and came after the number
  was turned on.
- A hand-over: the conversation goes to the journey's owner (or the unassigned queue), the model's
  summary becomes a journey note, and its short line to the customer is sent when it passes the
  same rules. The conversation then shows in the owner's home list and in the inbox queue, and the
  team managers are told by email (below).
- While it answers a number's conversations, agents are not offered them in `work.pending`.

## The order and its payment link

With a shop connected, a customer who accepts the automatic quote and gives the order's details
gets an order draft created in the workspace's own shop and its payment link, without a person.
Without a shop nothing of this exists: the model is not offered the tool and its request is
exactly as before.

**What the shop must offer.** An MCP endpoint over streamable HTTP (`https` only), reached with a
bearer token, with one tool that creates an order draft and answers its payment link (a page on
the endpoint's own host). The token should be able to do nothing else. Guards on the shop's side
(order total, line items, a daily cap) apply on top of Jeeta's; an idempotent replay on the order's
`jeeta_ref` (the same draft for the same reference) is strongly advised, because Jeeta never retries
a call whose outcome is unknown.

**Connecting it (operator, two calls, an API key with `capabilities.manage`).** Run them on the
server with `curl`, so the shop's token never passes through an AI agent's conversation: put the
token in a root-only file first (`install -m 600 /dev/null /root/shop-token`, then paste it with
an editor), and let the shell read it. Invented example values:

```sh
KEY=$(cat /root/jeeta-key)      # a jt_live_… key with capabilities.manage, also from a file
TOKEN=$(cat /root/shop-token)
curl -s -X POST http://127.0.0.1:8080/api/connectors/credentials \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d @- <<JSON
{"kind_key": "shop_mcp", "name": "shop.example.com",
 "credential": {"kind": "mcp_bearer", "endpoint": "https://shop.example.com/api/mcp", "token": "$TOKEN"}}
JSON
unset TOKEN
```

The answer is the capability (`id`, `status`). The endpoint becomes its external id and its one
tenant host; the capability is probed at once (`initialize`, `tools/list`): it is `verified` when
the shop lists its order tool (`call_api_operation` until a template names another). Then the
template, with the capability's id:

```sh
curl -s -X PUT http://127.0.0.1:8080/api/connectors/$CAPABILITY_ID/shop-order \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "enabled": true, "tool": "call_api_operation", "currency": "TRY",
  "arguments": {"id": "admin.orders.create", "confirm": true,
    "body": {"customerName": "{{name}}", "email": "{{email}}",
      "shippingAddress": {"adres": "{{street}}", "mahalle": "{{neighbourhood?}}", "ilce": "{{district}}",
                          "il": "{{province}}", "postaKodu": "{{postcode?}}", "telefon": "{{phone}}"},
      "lineItems": [{"description": "{{item}}", "unitPriceTry": "{{amount}}", "quantity": 1}],
      "paymentMethod": "{{payment_method}}",
      "attributes": [{"name": "jeeta_ref", "value": "{{ref}}"}]}},
  "result": {"text_json": true, "ok": "/ok", "url": "/data/payUrl",
             "reference": "/data/reference", "amount_minor": "/data/amountKurus"}}'
```

The MCP twins are `jeeta.connector.set_credentials` and `jeeta.connector.set_shop_order`; use
them for the template only (it holds no secret), never to pass the token. Template rules: a JSON
string that is exactly `"{{var}}"` becomes the value (`amount` a number of whole units,
`amount_minor` an integer, the rest strings), `"{{var?}}"` drops its key when empty, and nothing is
interpolated inside a longer string. The variables are `ref` (the order's id, `jeeta_ref`),
`amount`, `amount_minor`, `currency`, `name`, `email`, `phone`, `street`, `neighbourhood`,
`district`, `province`, `postcode`, `payment_method` (`card` or `bank_transfer`) and `item`; `ref`
and an amount must appear; at most 8 KiB and depth 8. `result` names JSON pointers into the tool's
result (`content[0].text` read as JSON with `text_json`, else `structuredContent`): `ok` must be
`true`, `url` is required, `reference` and `amount_minor` are optional (when mapped, the amount
must equal the quote's). Kurallar then shows "Sipariş: {host} üzerinden ödeme bağlantısı".

**What happens.**

- After an automatic quote went out, the model may call `create_order` with the details, the
  customer's own words accepting the price and a short line. It has no amount: the order is always
  for the quote's.
- The server checks, before the shop is asked: exactly one verified shop with an enabled template
  (`order_unavailable`; a shop capability that requires approval hands over, `order_needs_approval`);
  the journey's order (created: the same link is sent again, without a call; any other state:
  `order_exists`); the journey's one quote, automatic, delivered, not expired, in the template's
  currency (`no_auto_quote`, `quote_ambiguous`, `quote_expired`, `order_currency`); the words of
  acceptance found in a customer message after the quote (`acceptance_unverified`: this proves the
  customer wrote them, not that they mean yes); the details (the email and a given phone found in
  the customer's own messages; no phone means the WhatsApp number). Missing or malformed details are
  asked for once with a fixed message ("Siparişi oluşturmak için şunlar eksik: e-posta adresiniz,
  ilçe. Yazar mısınız?"); the second time the conversation goes to a person (`order_details`). At
  most 10 orders per shop per local day unless the shop capability's daily cap says otherwise
  (`order_limit`). The model's line follows the reply rules and the second check.
- The order row (`calling`) commits first; the shop is asked with no lock held (15 s, never
  retried); the answer is stored in a new transaction. The link must be `https` on the endpoint's
  host (`order_link_host`) and the amount the quote's (`order_amount_mismatch`).
- On success the customer gets, in one message, the model's line (if any) and: "Siparişiniz
  oluşturuldu. Ödemeyi kartla ya da havaleyle bu bağlantıdan yapabilirsiniz: {link}". This text is
  the server's and is not put through the reply rules. The quote becomes accepted (the journey
  `Pending`), the team managers get the email "Jeeta: yeni sipariş oluşturuldu" with the amount and
  the shop's reference, and the conversation stays with the assistant, which answers from the cards
  only (a change, a cancellation or a payment question the cards do not answer goes to a person).
  Marking the journey won stays a person's act: Jeeta sees no payment.
- On a refusal, an outage, an unknown outcome or a failed check, the conversation goes to a person
  (`order_rejected`, `order_auth`, `order_unavailable`, `order_unknown`, …), the customer gets
  "Siparişinizi ekibimiz tamamlayacak, kısa süre içinde dönüş yapacağız.", and a journey note
  names the code (for an unknown outcome: "check the shop for jeeta_ref {id}"). A take-over during
  the call, or a send fence's refusal, sends nothing: the note holds the reference and the link
  (`order_link_unsent`). An order left `calling` for two minutes (a crash) is handed over by the
  minute sweep (`order_interrupted`).

**What is kept.** `auto_reply_orders`: the order's state, reason, amount, currency, the shop's
reference and the payment link. The customer's name, email, phone and address exist in memory
only, between the model's answer and the shop's call: never in the database, the runs, the
ledger, a log or `Debug`. Erasing the person clears the link and keeps the reference and amount.

**Data protection.** The details go only to the workspace's own shop, which belongs to the same
controller (the owner's business). Erasing a person in Jeeta does not erase the shop's copy of the
order: the owner erases it in the shop's own admin.

**Turning it off.** `PUT /api/connectors/{id}/shop-order` with `"enabled": false`, or retire the
shop capability: the tool is no longer offered and nothing else changes.

## The owner's email notices

- When the automatic replies hand a conversation to a person, the workspace's team managers
  (active members whose role has `team.manage`, at most five) are told by email, through the
  workspace's own oldest verified mailbox: subject "Jeeta: bir konuşma sizi bekliyor", three lines
  (what happened, the reason in plain words from a fixed table, the conversation's link in the
  panel) and how to turn them off. Never a customer's name, text or the model's summary.
- On by default wherever a verified mailbox exists; Kurallar shows "E-posta bildirimi: {address}"
  and the dialog's checkbox "Devir ve siparişleri e-postayla bildir" turns them off. No mailbox:
  no line, no checkbox, no email.
- At most 20 per workspace in a rolling day; past that a notice is kept as `skipped`
  (`daily_cap`). One per hand-over, written in a savepoint of the hand-over's transaction: a
  failing notice write never undoes the hand-over (logged by code).
- Sent by a job of its own, `owner_notices`, every 30 s (never by `inbox_auto_reply`): at most
  three notices per workspace and 20 s per run, each email within 15 s. A failed attempt (a
  transient send failure, or an error before the send) waits 1, 5 then 15 minutes; after the
  fourth the notice is `failed`. A send whose outcome is unknown (or that timed out) counts as
  sent and is never repeated; so does a notice found still `sending` ten minutes later.
- Each email's `Message-ID` is `<jeeta-notice.{id}.{n}@{mailbox domain}>`, with
  `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: All` and `X-Jeeta-Notice: {id}`.
  The consumer drops a polled mail (`own_notice`, it never becomes a conversation) when its
  `Message-ID` or `In-Reply-To` names a notice the workspace holds (the inbox copy, the Sent copy,
  an answer); when it comes from the workspace's own mailbox address with `Auto-Submitted` and the
  marker of a notice it holds (a provider that rewrote the `Message-ID`); and when it is a
  delivery report (from `mailer-daemon` or `postmaster`, or a `multipart/report`) that quotes a
  notice's `Message-ID` or marker, or bears a notice's subject, addressed back to the mailbox
  within 30 minutes of a notice. A standard failed delivery report is already turned by `jt_mail`
  into a delivery status keyed by the original `Message-ID`, which the first rule catches.
- `owner_notices` (migration `0049_owner_notices`) holds codes and ids only.

## What is kept

- `auto_reply_runs`: one row per model call with codes and numbers (outcome, reason, tokens,
  cost in millionths of a dollar). Never in `messages.cost_minor`.
- Ledger: `inbox.autoreply.{replied, quoted, ordered, refused, handed_over, skipped, failed}`,
  `inbox.reply.held`, `connector.shop_order_set`, with codes and numbers only.
- `auto_reply_orders`: see "The order and its payment link".
- No customer text, model answer, quote basis or hand-over summary in logs or the ledger; logs
  name the job, the workspace, a code and Anthropic's `request-id`.
- No photo anywhere: the feature never writes one to disk, the database, a log or the ledger. It
  lives in memory for one model call (a photo that cannot be shown logs the code `image_unseen`).

## Data protection

Turning the feature on sends the customers' message text and photos to Anthropic, as a data
processor. Photos can show faces and children. The owner's privacy notice must name Anthropic and
say that photos are included (KVKK) before the feature is turned on.

## Turning it off

Kurallar → the number's switch off (per workspace), or remove `JEETA_ANTHROPIC_API_KEY` and
restart (everywhere): nothing is scheduled or asked any more, and nothing else changes.

## First-message drafts

With the same key, the "Mesaj gönder" dialog on a prospect opens with a draft of the first
message in its field (email: subject and body; SMS, WhatsApp, Instagram: two or three
sentences), written by the same model (`prospects.message_draft`, `POST
/api/prospects/{id}/draft`, `usecases/prospects/draft.rs`, `jt_claude/src/draft.rs`). It is only
text for the person: the server never sends it. When the person sends it, it takes the same send
path and checks as a hand-written message (footer, unsubscribe, basis, consent, suppression,
caps).

- **Sent to Anthropic.** The prospect's recorded business facts are sent: its name, sector,
  place, why it fits with its sources, and the notes about the business. No contact person is
  sent. The workspace's cards, prohibitions and open notes are sent too.
- **Limits.** At most 100 drafts per workspace per UTC day (`DRAFTS_PER_WORKSPACE_DAILY`).
  Without a key there is no draft, and the field stays empty.
- **Kept.** Each call is a ledger entry `drafts.first_message` with the channel, the model, the
  tokens and the cost. A draft's text is never stored or logged.

Removing the key turns the drafts off as well.
