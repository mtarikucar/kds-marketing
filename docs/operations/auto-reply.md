# Inbox auto-reply (Claude API)

The server can answer a customer's WhatsApp message itself, through the Claude API, within what
the workspace owner set in Kurallar and what the knowledge cards say. Anything outside the
standard goes to a person. This reverses the "no AI inside Jeeta" rule for inbox replies only
(spec `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`, addendum C).

Code: `rust/crates/jt_app/src/usecases/inbox/autoreply.rs` (the use case), `rust/crates/domain/
jt_inbox/src/autoreply.rs` (the server's rules), `rust/crates/adapters/jt_claude` (the API
adapter), migrations `0047_inbox_auto_reply`, `0048_inbox_person_latest` (an index for the
person's-hold lookup) and `0049_owner_notices` (the owner's email notices).

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
- It answers through one tool: a reply, a quote, or a hand-over to a person. A reply the server's
  rules refuse for a number, an amount or a link is asked for once more in the same run, with a
  line saying why; the second answer is checked the same way (and by the model's check), and only
  if it fails too is the conversation handed over with the first reason. That call is stored and
  counted like any other.
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
- **The assistant answers first; a person is the second factor.** It answers every customer
  message that is the latest one of a conversation it serves, whatever a person wrote before (in
  the panel or from the phone's Business App), unless a person has taken the conversation over:
  then it stays out until the conversation is handed back, and a customer message still waiting
  inside the 24-hour reply window is answered at once on the hand-back. A run whose message a
  person answers meanwhile (the conversation turns `theirs`, or a newer message moves its
  activity) drops its answer, at the run's end, at the send and at the approval of a held reply
  (`stale`), so the customer never gets two answers to one message; a take-over during a run
  refuses the send too. While it answers a conversation, agents are not offered it.
- When a person on the team stated money in the current journey (an amount, a currency, a
  discount or payment word, or a bare number such as "3500 olur"), it never quotes in that
  journey: a quote becomes a hand-over (`human_quoted`), and the model is told so. Replies that
  are not about price still go out, continuing from what the team said, never contradicting it.
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
- Ledger: `inbox.autoreply.{replied, quoted, refused, handed_over, skipped, failed}`,
  `inbox.reply.held`, with codes and numbers only.
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
