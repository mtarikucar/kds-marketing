# Inbox auto-reply (Claude API)

The server can answer a customer's WhatsApp message itself, through the Claude API, within what
the workspace owner set in Kurallar and what the knowledge cards say. Anything outside the
standard goes to a person. This reverses the "no AI inside Jeeta" rule for inbox replies only
(spec `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`, addendum C).

Code: `rust/crates/jt_app/src/usecases/inbox/autoreply.rs` (the use case), `rust/crates/domain/
jt_inbox/src/autoreply.rs` (the server's rules), `rust/crates/adapters/jt_claude` (the API
adapter), migration `0047_inbox_auto_reply`.

## Configuration

| Variable | Meaning |
|---|---|
| `JEETA_ANTHROPIC_API_KEY` | The platform's Claude API key. Optional. Unset: the feature is off in every workspace and the panel says "Sunucuda Claude anahtarı yok". A secret: never logged, masked in `Debug`, wiped from memory when dropped. |
| `JEETA_AUTOREPLY_MODEL` | The model; `claude-haiku-5-5` when unset. A model `jt_claude` has no prices for refuses the start. |

The key goes into `/etc/jeeta/jeeta.env` (root:jeeta, 0640) as `JEETA_ANTHROPIC_API_KEY=...`,
then `systemctl restart jeeta`. Requests go to `api.anthropic.com` only (the `anthropic` entry of
`jt_outbound`'s fixed hosts), under a 20 s timeout.

## Turning it on for a workspace

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
- It answers through one tool: a reply, a quote, or a hand-over to a person.
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
  replies stay out of a conversation, agents are offered it as usual. A held or queued automatic reply
  whose conversation moved on is refused (`stale`).
- The capability's policy applies: approval (the reply waits in the approvals list), working hours
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
  same rules. The conversation then shows in the owner's home list and in the inbox queue. No email
  is sent yet.
- While it answers a number's conversations, agents are not offered them in `work.pending`.

## What is kept

- `auto_reply_runs`: one row per model call with codes and numbers (outcome, reason, tokens,
  cost in millionths of a dollar). Never in `messages.cost_minor`.
- Ledger: `inbox.autoreply.{replied, quoted, refused, handed_over, skipped, failed}`,
  `inbox.reply.held`, with codes and numbers only.
- No customer text, model answer, quote basis or hand-over summary in logs or the ledger; logs
  name the job, the workspace, a code and Anthropic's `request-id`.

## Data protection

Customer messages now go to Anthropic as a data processor. The owner's privacy notice must name it
(KVKK) before the feature is turned on.

## Turning it off

Kurallar → the number's switch off (per workspace), or remove `JEETA_ANTHROPIC_API_KEY` and
restart (everywhere): nothing is scheduled or asked any more, and nothing else changes.
