# Inbox auto-reply (Claude API)

The server can answer a customer's WhatsApp message itself, through the Claude API, within what
the workspace owner set in Kurallar and what the knowledge cards say. Anything outside the
standard is asked of the owner, and the conversation stays the agent's. This reverses the "no AI inside Jeeta" rule for inbox replies only
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

- A customer's message is scheduled 6 s after the last one of a burst (never more than 20 s after
  the first); the `inbox_consume` job reads new messages every 3 s and the `inbox_auto_reply` job
  runs every 3 s. A typical answer goes out about 10 to 25 s after the customer's last message
  (consume within 3 s, settle 6 s, the next tick within 3 s, then the model and its check); a
  customer who keeps typing is answered at most about 20 s after the first message of the burst
  plus that time, and a message arriving during a run drops that answer and is answered instead. The model reads the fixed instructions,
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
- It answers through one tool: a reply, a quote, or a hand-over (it asks the owner). A reply the
  server's rules refuse for a number, an amount, a link or for passing the matter on is asked for
  once more in the same run, with a line saying why; the second answer is checked the same way
  (and by the model's check). If that fails too and the customer asked nothing about price, the
  refused reply's own sentences the rules let through go out instead (none left: the owner is
  asked with the first reason). That call is stored and counted like any other.
- **The ordinary steps of a sale are the agent's**: confirming a design, choosing an option, the
  details the order needs and taking them, how the customer pays, explaining a price the business
  already gave, a thank-you. `hand_over` is only for what it cannot answer; `payment_problem` is
  a payment that failed or is disputed, never a price question or an order's details.
- **What the agent knows.** The last 30 messages, the business's own among them (a person's in the
  panel and the phone's Business App included), and the business's own notes on the customer's
  journey (a person's or an agent's, the latest ten, each cut to 1000 characters; the server's own
  hand-over and order notes are not read), sent as an uncached note. A reply may state again a
  price or a number the business already gave this customer there (an amount beside its currency,
  `3500 olur`, an order's number), and the second check is told those prices; an amount that
  appears nowhere is still refused. Once the business named the payment method (havale, ödeme,
  EFT), a reply may too.
- It never says or implies it is a person. Asked whether the customer is talking to a person, a bot
  or an AI, it says in one short sentence that it is the business's automatic assistant; it does
  not say so unprompted. A customer who then asks for a person is handed over (`asks_for_person`).
  No automatic text ever says that the matter was passed on or that the team, a colleague or a
  person will write (`passed_on`: `ekibimize`, `arkadaşım`, `ilettim`, `aktardım`, `devrettim`,
  `yönlendirdim`, `our team`, `colleague` …). It writes short, everyday
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
  anything but a clear "allowed" (a refusal, an error, no answer) is not sent and the owner is
  asked (`judge_refused`, `judge_unavailable`). The check is a model call like any
  other: recorded, counted and paid for.
- **The assistant answers first; a person is the second factor.** It answers every customer
  message that is the latest one of a conversation it serves, whatever a person wrote before (in
  the panel or from the phone's Business App), unless a person has taken the conversation over:
  then it stays out until the conversation is handed back, and a customer message still waiting
  inside the 24-hour reply window is answered at once on the hand-back. A run whose message a
  person answers meanwhile (the conversation turns `theirs`, or a newer message moves its
  activity) drops its answer, at the run's end, at the send and at the approval of a held reply
  (`stale`), so the customer never gets two answers to one message; a take-over during a run
  refuses the send too. While it answers a conversation, agents are not offered it.
- **Who holds a conversation.** A person holds it only by pressing take-over ("Devral"); it
  comes back with a hand-back ("Ajana bırak"). No hand-over of the automatic replies changes who
  holds it (below, "The agent keeps every conversation"). An automatic hand-over made before that
  (the model's, the server's or the response-time job's) gave the conversation to a person and is
  recorded on the queue row with the executor generation it wrote (`auto_handed_generation`,
  `auto_handed_at`, migration `0051_auto_reply_reenter`); while the conversation is still at that
  generation and no person wrote to the customer since (in the panel or from the Business App),
  the customer's next message brings the assistant back, as a hand-back would (a new generation,
  ledger `inbox.autoreply.reentered`), on the normal settle time, but only when the assistant
  could answer it (every check of a run passes); otherwise the conversation stays with the
  person. An order's hand-over (`order_*`) was never marked: the assistant comes back from it only
  with a hand-back. For a served conversation the response-time
  job asks nothing whose customer message is outside the 24-hour reply window or was answered by
  a run (a reply or a quote queued after it; a run skipped or given up did not answer it);
  conversations the automatic replies do not serve, and every conversation with the feature off,
  keep the job's rule as it was (it hands them to a person). An operator can always hand a
  conversation back by hand.
- When a person on the team stated money in the current journey (an amount, a currency, a
  discount or payment word, or a bare number such as "3500 olur"), it never quotes in that
  journey: a quote becomes a hand-over (`human_quoted`), and the model is told so. Replies still
  go out, continuing from what the team said, never contradicting it, and may repeat the price the
  team gave.
- **Bargaining.** In Kurallar, next to "En az / En çok", the owner sets "Pazarlık indirimi":
  a preferred and a largest percent (0 to 50, preferred at most largest; both 0, the default: no
  bargaining, and the request to the model is as before). Only a person saves them, from the
  panel. When the customer bargains over the assistant's own quote (sent, still valid), the model
  may call `discount`, which takes no amount: the server gives the next step, the preferred one,
  then (only after that discounted quote went out and the customer still pushes) the largest,
  priced from the journey's first automatic quote (never compounding), less the percent, rounded
  up to a whole ten, never below the lowest price. The message is the model's short line (when
  it names no money) and the server's line "İndirimli fiyatımız: {price}."; the discounted quote
  replaces the earlier one (one current price per journey), and the run and the ledger record the
  step (`discount_step`). The customer bargains only with a bargaining word (indirim, pahalı,
  son fiyat …) or a lower price in a money form ("3.500 TL", "3 bin", "3,5k"); a bare number (an
  address, a quantity) does not. A discount the customer did not ask for, or with no current
  quote, is not given, and bargaining never ends in a hand-over: the model is told where the
  conversation stands in a note of its own (uncached; the policy itself sits in the cached
  workspace part), and when it asks again anyway the server answers "Size sunabileceğimiz en iyi
  fiyat bu." (nothing more to give, or not asked) or "Size en uygun teklifi hazırlayalım:
  isteğinizi biraz daha anlatır mısınız?" (no current quote). A discounted quote is sent only as
  the second check saw it: a bargain that moved during the call is asked again. A person's price
  in the journey still hands over (`human_quoted`). A stored percent that is not a whole number
  from 0 to 50, or a preferred above the largest, reads as no discount.
- The capability's policy applies: approval (the reply waits in the approvals list and in the
  conversation, where it can be approved or discarded; automatic messages carry an "otomatik"
  mark there), working hours
  (outside them the owner is asked) and the daily cap.
- Limits per local day: 24 model calls per conversation and 600 per workspace (each automatic
  message takes two: the answer and its check), $2 of model cost per workspace. Reaching one
  hands the conversation over.
- Every model call is recorded at once and counts towards the day's limits and spend (a failed
  call at a conservative estimate). A rate limit or an outage is asked again; after three calls on
  one burst (counted before any step that could fail) the owner is asked
  (`failed`). One tick works at most five conversations and 8 s per workspace, starts after the
  workspace it served last, and stops starting new ones after 20 s. Once a minute, inside that
  budget, the job also schedules a customer message left without a schedule (a crash between the
  consumer and the schedule), only when it is at most 15 minutes old and came after the number
  was turned on.
- A hand-over asks the owner and keeps the conversation the agent's (below): a task for the
  journey's owner (or the unassigned queue), the model's summary as a journey note, and an email
  to the team managers (below). The customer is never told of it.
- While it answers a number's conversations, agents are not offered them in `work.pending`.

## The agent keeps every conversation

How every workspace works (it was a switch in Kurallar for a while; a stored
`knowledge_settings.auto_reply.keeps_conversations` is ignored and dropped at the next save). A
hand-over never changes who holds a conversation: a conversation becomes a person's only when a
person presses "Devral" (a reply from the panel does not take it over; it never did).
Every hand-over cause above (the model's `hand_over`, a text the server refuses after its
repairs, the check, a model failure or a run that kept failing, the day's limits, the working
hours, a price from the team, a send the capability's policy refuses, an order the shop did not
create or whose link could not go, and the response-time job) does instead:

- **An open item for the owner.** A task on the person's journey, due now, for the journey's
  owner (the unassigned queue without one): "Otomatik yanıt danışıyor: {the reason in plain
  words} · {the model's summary, cut short}"; the summary whole becomes a journey note, as a
  hand-over's does. Migration `0056_auto_reply_owner_items` ties the task to its conversation and
  reason (codes and ids only). One per conversation and reason, claimed before the task is made
  (`insert … on conflict do nothing`, a done task's item replaced only while it still names that
  task), so two runs at once ask once: the same reason again while its item is open makes nothing
  new (no task, no note, no email). Once the owner marks the task done, the next time the reason
  comes up is a new point. A person with no journey gets an item without a task: it still marks
  the conversation and keeps repeats quiet, and it closes when a person takes the conversation
  over, hands it back or closes it.
- **The owner's email**, as for a hand-over, worded "Otomatik yanıtın bir konuda size ihtiyacı
  var; konuşma otomatik yanıtta kalıyor…": once per open item.
- **Nothing to the customer about it.** No line says the matter was passed on, or that the team
  or a person will write. What the customer gets is the model's own answer in the hand-over's
  `text` (everything it can answer, and for that point, briefly, that it will confirm it and get
  back to them), sent as the agent's automatic message when it passes the rules and the check
  (its sentences that pass, when some do not); without one, nothing. A hand-over the server
  decides (a refusal, a model failure, the limits, the working hours, the response-time job)
  sends nothing to the customer.
- **The conversation stays the agent's** and the customer's next message is answered as any
  other. The model is told, in the cached workspace part, that a hand-over asks the business about
  one point and keeps the conversation, and, in the conversation's note, which points are still
  open, so it answers everything else and does not hand the same point over again.

What the agent may say does not change: a price only through `quote` and within the range, the
one automatic quote per journey, nothing the cards do not say, the discount steps, the second
check, and no quote after a person on the team priced. Whatever the server refuses is still never
sent; only the holder of the conversation differs. The day's limits and spend are counted as
before (the run that would have handed over is still a `handed_over` run; the line is not a
model call). Ledger `inbox.autoreply.needs_owner` (`run_id`, `reason`, `by`, `task_id`;
`repeat`, `owner_notified: false`, `customer_told: false` when no answer went out) takes the place
of `inbox.autoreply.handed_over`. The response-time job hands no served conversation over: it asks
the owner once for the customer's latest message (`response_overdue`), and not at all while
another item is open on the conversation. A take-over, a lost journey and a departing member
change the executor as before, and an agent (an MCP key) may write in a conversation the agent
keeps.

**In the inbox.** The default queue "Bizde" lists, besides the conversations owed a reply, those
the agent holds (open or answered) that have an open item for the owner, each with a small "Seni
bekliyor" mark (`owner_items` on the conversation's view, left out at zero); the owner's home list
shows the task among the due tasks. No new tab: a conversation leaves "Bizde" when its task is
done and the customer owes the next word, as any other does.

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

**Connecting it (operator, two calls).** Run them on the server, so the shop's token never
passes through an AI agent's conversation: put the token in a root-only file first
(`install -m 600 /dev/null /root/shop-token`, then paste it with an editor), and let the shell
read it. The first call takes an API key with `capabilities.manage`, through the MCP tool
`jeeta.connector.set_credentials` on `/mcp` (the panel's `/api` accepts only a signed-in panel
session, not a key); the second is a person's act and takes a signed-in owner's session (an API
key or an MCP connection is refused, `403 person_only`). Invented example values:

```sh
KEY=$(cat /root/jeeta-key)      # a jt_live_… key with capabilities.manage, also from a file
TOKEN=$(cat /root/shop-token)
MCP=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json'
     -H 'Accept: application/json, text/event-stream')
# Open an MCP session; its id comes back in the Mcp-Session-Id header.
SESSION=$(curl -s -D - -o /dev/null -X POST http://127.0.0.1:8080/mcp "${MCP[@]}" -d \
  '{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
    "capabilities": {}, "clientInfo": {"name": "operator", "version": "1"}}}' \
  | awk 'tolower($1) == "mcp-session-id:" {print $2}' | tr -d '\r')
curl -s -X POST http://127.0.0.1:8080/mcp "${MCP[@]}" -H "Mcp-Session-Id: $SESSION" \
  -d @- <<JSON
{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "jeeta.connector.set_credentials", "arguments": {
   "kind_key": "shop_mcp", "name": "shop.example.com",
   "credential": {"kind": "mcp_bearer", "endpoint": "https://shop.example.com/api/mcp", "token": "$TOKEN"}}}}
JSON
unset TOKEN
```

The answer (a JSON-RPC result, possibly as one server-sent event) holds the capability (`id`, `status`). The endpoint becomes its external id and its one
tenant host; the capability is probed at once (`initialize`, `tools/list`): it is `verified` when
the shop lists its order tool (`call_api_operation` until a template names another). Then the
owner (or the operator signed in as the owner) sets the template, with the capability's id:

```sh
curl -s -c /root/jar -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' -H 'X-Requested-With: jeeta-panel' \
  -d '{"email": "owner@example.com", "password": "…"}'
curl -s -b /root/jar -X PUT http://127.0.0.1:8080/api/connectors/$CAPABILITY_ID/shop-order \
  -H 'Content-Type: application/json' -H 'X-Requested-With: jeeta-panel' -d '{
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
rm /root/jar
```

The MCP twin of the first call is `jeeta.connector.set_credentials` (never pass the token through
it); `jeeta.connector.set_shop_order` exists but refuses an agent, like the route under an API key.
Template rules: a JSON string that is exactly `"{{var}}"` becomes the value (`amount` a number of
whole units, `amount_minor` an integer, the rest strings), `"{{var?}}"` drops its key when empty,
and nothing is interpolated inside a longer string. The variables are `ref` (the order's id,
`jeeta_ref`), `amount`, `amount_minor`, `currency`, `name`, `email`, `phone`, `street`,
`neighbourhood`, `district`, `province`, `postcode`, `payment_method` (`card` or `bank_transfer`)
and `item`; `ref` and an amount must appear; at most 8 KiB and depth 8. `result` names JSON
pointers into the tool's result (`content[0].text` read as JSON with `text_json`, else
`structuredContent`): `ok` must be `true`; `url` and `amount_minor` (the order's amount in minor
units) are required, and the amount must equal the quote's before anything is sent; `reference` is
optional. Kurallar then shows "Sipariş: {host} üzerinden ödeme bağlantısı".

**What happens.**

- The tool is offered only when an order could pass: the journey's one quote, automatic, delivered,
  unexpired and in the template's currency (or an order already created, whose link may be asked
  for again).
- The model calls `create_order` with the details, copied exactly from the customer's words, and a
  short line. It has no amount (the order is always for the quote's) and no acceptance of its own.
- The server checks, before anything goes to the shop: exactly one verified shop with an enabled
  template (`order_unavailable`; a shop capability that requires approval hands over,
  `order_needs_approval`); the journey's order (created: the same link is sent again, without a
  call; calling, failed or unknown: `order_exists`); the quote (`no_auto_quote`, `quote_ambiguous`,
  `quote_expired`, `order_currency`); the details: every word of the name, street, neighbourhood,
  district, province and postcode a whole word the customer wrote in this journey (case,
  punctuation and spacing aside), the email a whole address the customer wrote, a given phone a
  whole number the customer wrote (country and trunk prefixes aside); no phone means the WhatsApp
  number. Missing, malformed or unclear details are asked for once with a fixed message
  ("Siparişi oluşturmak için şunlar eksik ya da net değil: e-posta adresiniz, ilçe. Yazar
  mısınız?"); the second time the owner is asked (`order_details`). At most 10
  orders per shop per local day unless the shop capability's daily cap says otherwise
  (`order_limit`, counted when the shop is asked: a summary never confirmed does not count).
- **The customer confirms.** The first call sends the server's own summary and creates nothing at
  the shop; the row (`confirming`) keeps only an HMAC of exactly what the shop would receive
  (every detail as written, whitespace collapsed; the line items; the amount):

  ```text
  Siparişinizi oluşturmadan önce bilgilerinizi kontrol eder misiniz?
  Ad soyad: {name}
  E-posta: {email}
  Telefon: {phone}
  Adres: {street}, {neighbourhood}, {district} / {province}, {postcode}
  Ürün: {item} x{quantity}
  Ödeme: Kart | Havale / EFT
  Tutar: 1.500 TRY

  Bilgiler doğruysa siparişi onaylamak için “Evet” yazın.
  ```

  (In English: "Could you check your details before I create your order? Name … Email … Phone …
  Address … Item: … x1. Payment: Card | Bank transfer. Amount: 1,500 TRY. If the details are right,
  write “Evet” (yes) to confirm the order." The customer-facing text is Turkish, like every fixed
  line.) The order goes ahead only when: the summary's send succeeded (one held for approval,
  refused or still in the outbox confirms nothing); every customer message after that send is an
  explicit yes; no person on the team wrote in the conversation after the summary, queued or sent
  (`order_person_wrote`: the conversation goes to them); and the model calls `create_order` again
  with exactly the same details (the same HMAC). An explicit yes is a whole message, in lower case
  with only surrounding whitespace and emoji and a trailing `.`, `!` or `,` removed, equal to one of:
  evet, evet doğru, evet onaylıyorum, evet onay, onaylıyorum, onay veriyorum, kabul ediyorum, evet
  kabul ediyorum, doğru, doğrudur, evet tamam, tamam, tamamdır, olur, evet olur, evet lütfen, yes,
  yes please, ok, okay, okey; a message with `?` is never one. Anything else (a no, a question, a
  correction, other details) shows the summary again; after three summaries in all the
  owner is asked (`order_details`).
- The order row (`calling`) then commits; the shop is asked with no lock held (15 s, never
  retried); the answer is stored in a new transaction. The amount must be the quote's
  (`order_amount_mismatch`), and the link a bare `https` URL (no whitespace or control character,
  at most 300 characters) on the endpoint's own host (`order_link_host`); the link is sent as the
  URL parser reads it. The shop's reference is kept and shown only when it is letters, digits, `-`
  and `_`, at most 40.
- On success the customer gets, in one message, the model's line (if any) and: "Siparişiniz
  oluşturuldu. Ödemeyi kartla ya da havaleyle bu bağlantıdan yapabilirsiniz: {link}" ("Your order
  has been created. You can pay by card or bank transfer at this link: {link}"). This text is the
  server's and is not put through the reply rules. The quote becomes accepted (the journey
  `Pending`), the team managers get the email "Jeeta: yeni sipariş oluşturuldu" with the amount and
  the shop's reference, and the conversation stays with the assistant, which answers from the cards
  only (a change, a cancellation or a payment question the cards do not answer asks the owner).
  Marking the journey won stays a person's act: Jeeta sees no payment.
- On a refusal, an outage, an unknown outcome or a failed check, the owner is asked
  (`order_rejected`, `order_auth`, `order_unavailable`, `order_unknown`, …), the customer gets
  "Siparişinizi kontrol edip kısa süre içinde size dönüş yapacağım." ("I will check your order and
  get back to you shortly."), and a journey note names the code and says to
  look in the shop for `jeeta_ref {id}`. After the call, only the tool's own refusal counts as
  "nothing was done"; any other status (`408`, `409`, `425`, `429`, a `5xx`, …), a timeout or a
  broken connection is an unknown outcome. A take-over during the call, or a send fence's refusal,
  sends nothing: the note holds the reference and the link (`order_link_unsent`). An order left
  `calling` for two minutes (a crash) is handed over by the minute sweep (`order_interrupted`); its
  line goes out only when the conversation is still the agent's under the same generation and no
  person is active, otherwise only the note is left.

**What is kept.** `auto_reply_orders`: the order's state, reason, amount, currency, an HMAC of
the confirmed details, the summary message's id, the shop's reference and the payment link. The customer's name, email, phone and address exist in memory
only, between the model's answer and the shop's call: never in the database, the runs, the
ledger, a log or `Debug`. Erasing the person clears the link and keeps the reference and amount.

**Data protection.** The details go only to the workspace's own shop, which belongs to the same
controller (the owner's business). Erasing a person in Jeeta does not erase the shop's copy of the
order: the owner erases it in the shop's own admin.

**Turning it off.** `PUT /api/connectors/{id}/shop-order` with `"enabled": false`, or retire the
shop capability: the tool is no longer offered and nothing else changes.

## The owner's email notices

- When the automatic replies need the owner on a conversation, the workspace's team managers
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
