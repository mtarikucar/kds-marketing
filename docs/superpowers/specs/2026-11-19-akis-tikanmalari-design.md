# Where work stops between pages — audit and design

Date: 2026-11-19. Status: audit done; the fixes marked **built** are in branch
`feat/flow-dead-ends`; the rest are proposals or wait for the owner's decision (§6). Builds on the
content module (`2026-11-10-uc-modul-ve-panel-iskeleti-design.md`, "design 2026-11-10"), the
materials library (`2026-11-03-studio-materials-design.md`, "spec 2026-11-03") and the olay root
(`2026-11-18-icerik-olay-koku-design.md`).

## 1. Why

On 2026-11-19 the owner asked for something simple: "bu paylaşımları tiktok için de yap" (make two
approved Instagram posts for TikTok too). Each obstacle showed up only after the previous one was
cleared:

1. TikTok takes only video (`tiktok_video`); the posts were images. Nothing said so when the content
   was asked for.
2. The agent wakes hourly; the contents sat "Sırada" (branch `feat/agent-wake`).
3. The versions came out `blocked: hypothesis_does_not_post`: the strategy chose channel `any`,
   but all five hypotheses had `channel: instagram`. Nothing said so when the TikTok account was
   connected, nor when the content naming that account was created.
4. A strategy draft adding TikTok hypotheses was approved. The versions stayed blocked: each
   version carries the hypothesis the agent chose at delivery (an Instagram one), and
   `VersionAccounts::of` accepted an account only when that very hypothesis posts there. The
   page kept saying "sorunlu içerik" with a sentence about cadence that was not the cause. The only
   way out was a revision of each content.
5. The routine's own prompt schedules only on accounts whose policy has
   `requires_human_approval: true`; the TikTok account's was false, although every TikTok post
   passes the owner's posting screen anyway. Set by hand.
6. Earlier: images added to a content opened a duplicate content (`fix/olay-trigger-and-cancel`), a
   post could not be cancelled from the social page (same branch), the token line of an account
   read like a daily expiry.

The pattern: Jeeta is a chain of independent gates built to keep an autonomous agent safe
(strategy, hypothesis, material rules, content steps, posting rules, approval, the platform's own
screen). Each gate speaks only when work reaches it, late and one at a time; clearing a gate does
not restart the work behind it; and gates meant to limit what an agent decides by itself also stop
what the owner asked for in person.

## 2. Three rules

- **R1. Say everything at the moment of asking.** When a person asks for something (a content for
  an account or format, a post, a revision, connecting an account, a research task), the system
  works out then everything that stands between the request and its result, shows it once as a
  short list, does by itself whatever it can, and asks the person for what only they can give,
  all together and each with one action. Nothing knowable at that moment may first appear later as
  a "blocked" or "problem" state.
- **R2. Work continues by itself when the obstacle is gone.** Every blocked, held or problem state
  names its cause as data; when the cause stops holding (strategy approved, account connected or
  resumed, material supplied or analysed, permission given, time passed), the item moves on
  without anybody redoing anything, the agents that can take it are told (through
  `work.pending` today, the wake of `feat/agent-wake` once merged), and the page's text changes
  with it. No state keeps showing a reason that is no longer true.
- **R3. The owner's explicit request is the decision.** A gate that limits what an agent may
  decide by itself does not stop a thing the owner asked for in person, by name. The final look
  stays: the owner still approves the finished post (or completes the platform's screen), once.
  Safety that protects other people stays untouched: consent and permission rules for people in
  photos, brand and prohibition checks, platform rules, rate limits, spend limits.

## 3. The audit

One row per place where work can stop, be refused, be held, wait for a person or an agent, or
lapse. Columns:

- **Seen today**: what the person sees and where ("nothing" when nothing in the panel says it).
- **R1**: was it knowable when the person asked for the thing that led to it?
- **R2**: does it clear by itself when its cause is fixed? If not, what must be redone today.
- **R3**: does it also stop work the owner asked for in person, that it should not?
- **Change**: what this branch does (**built**), proposes, or "fine as is".
- **Odds / cost**: how likely the owner meets it, and how costly it is when they do (H/M/L).

Rows are sorted by odds × cost. The ids say the chain: C content to publication, S social
accounts and connection, T strategy, I inbox, R research, A ads, G agent-side assumptions.

| # | Stop (code) | Raised at | Seen today | R1 | R2 | R3 | Change | Odds / cost |
|---|---|---|---|---|---|---|---|---|
| C1 | `hypothesis_does_not_post` although another hypothesis of the strategy posts on the account (the version keeps the hypothesis the agent chose at delivery) | `social/schedule.rs` `VersionAccounts::of`, `why_blocked` | Content page: "sorunlu içerik", Yayın red, `socialAccounts.blocked.hypothesis_does_not_post` ("…Sıklığı hiç yazılmamışsa…", not the cause). Social page: same line, "Stratejiyi düzelt" | Partly: the account's channel had no hypothesis when it was connected and when the content was created | **No**: approving the TikTok hypotheses did not clear it; a revision of each content was the only way | **Yes** | **Built F1**: the version's hypothesis is a preference, settled per account on every read and at scheduling (own → same segment → same channel → owner's request); recorded on the slot and in the ledger | H / H |
| C2 | No hypothesis of the strategy posts on the account's channel at all | same | same line as C1 | **Yes**: at connection and at content creation | Yes once a strategy with one is approved (after F1) | **Yes**: stops what the owner asked for by name | **Built F2** (owner's request posts anyway), **F3** (said at connection and creation, one action prepares the draft), copy fixed | H / H |
| C3 | Image version offered for TikTok; the engine then refuses `media_type` | `VersionAccounts::of` listed the account without looking at the materials; `posts.rs` `check_item` refuses | Agent: the item stays in its check-in and every schedule fails. Person: "Planlanamadı: media_type" on the social page | **Yes**: the materials are known when the content is created | n/a: the material must change | No (the platform's rule) | **Built**: such an account is not offered; `blocked: media_not_accepted` says why; F3 says it at creation ("TikTok yalnızca video alır; bu içerikte video yok", "Video ekle") | H / H |
| C4 | TikTok not counted as human-gated (`requires_human_approval: false`); the routine schedules only on gated accounts | `social/accounts.rs` `account_of`; routine prompt (outside the repo) | Nothing; the TikTok header has no "Her paylaşım onay bekler" badge | Yes: the kind decides it | n/a | **Yes**: the owner's TikTok content was never scheduled | **Built F5**: `requires_human_approval` is true for TikTok in `social.accounts_list`/`account_get`, `human_gate` names the step there and per account in `versions_waiting`; tool texts say every listed account may be scheduled | H / H |
| C5 | Agent hint "Nobody approves the post; it goes out at its time" | `work.rs` `SOCIAL_SCHEDULE_HINT` | n/a (agent text) | — | — | Leads agents to invent their own rule | **Built F5**: the hint names the human gate | H / M |
| C6 | Strategy change retires the planned posts of retired hypotheses (`hypothesis_retired`, `strategy_archived`); their versions keep a dead `slot_id` | `studio/lifecycle.rs` → `posts.rs` `retire_posts_after` | Yayın "geri alındı"; nothing waits; the content looks finished | Yes at approval | **No**: revision only | **Yes** | **Built F4**: the version is freed in the same transaction and waits again under the new strategy (F1 settles its hypothesis) | H / H |
| C7 | `missed_grace` of a post that waited for a person (approval, TikTok screen), a hold or a pause past its grace | `studio/planner.rs` | Yayın red, "Gönderilemedi"; only a revision brings it back | Partly: lead and grace are known at scheduling | **No** | **Yes** | **Built F4**: a post never attempted frees its version, which waits for a new time; one that was attempted and failed stays failed | M / H |
| C8 | A post's one attempt failed or was refused at the provider (login lapsed, permission, provider refusal); never sent again | `studio/publish.rs`; `content/pipeline.rs` `failed` | Yayın red; social page "Gönderilemedi" | No | **No**: after reconnecting nothing retries; revision or cancel | No | **Proposed**: free the version when the provider confirms nothing was created (`Refused`, `Auth`, `Permission` before upload); needs per-provider evidence that no duplicate can result, so not built (§6 O5) | M / H |
| C9 | Kept slot fails the chain at sending after a narrowing strategy change (`TargetNotSelected`, `HypothesisInactive`) | `studio/chain.rs` `authorize_execution_at`; `studio/work.rs` pending does not run the chain | Nothing until grace passes | Yes at approval | Becomes C7, which F4 now frees | Yes | **Partly built** (through F4). **Proposed**: run the chain in `studio.pending` with stable codes | M / H |
| C10 | Blocked version is nobody's work: `work.pending` lists none to the agent and nothing to the person | `work.rs` (`filter(|v| !v.accounts.is_empty())`) | Only the content page's red stage | Yes | Yes (reason is derived) | — | **Proposed**: a person's item naming the reason and its one action; left for after `feat/agent-wake` (it rewrites `work.rs`) | M / M |
| C11 | Area held after three refused deliveries (`ContentAreaHeld`) | `content/delivery.rs` | Content page "Paket" red with findings; home item | Partly: `media_type`, `account_refused` for a named account were knowable at creation (now said by F3) | Waits for a person (revision or release) | No | Fine as is; F3 removes the knowable causes | M / M |
| C12 | `hypothesis_not_in_approved_strategy` at delivery | `content/delivery.rs` `held_versions` | Agent refusal; counts towards the hold | — | The agent redelivers | No | Fine as is; `hypothesis_reserved` added for the owner's request | L / L |
| C13 | Capture request (`ContentMaterialRequest`, area `waiting_material`) | `studio/projects.rs` `project_request` | Content page "Eksikler", Görsel "kişi bekliyor"; home item | n/a (asked later) | Yes: upload + answer in the content (one place) | No | Fine as is | M / M |
| C14 | Engine refusals at scheduling: `lead_too_short`, `beyond_horizon`, `quiet_hours`, `cap_per_day`, `spacing` | `jt_studio` `validate_package` | Social page "Planlanamadı: …" with the reason in words | Lead **yes** (said by F3: "TikTok videosu en erken 48 saat sonrasına planlanır") | n/a | Lead also applies to the owner scheduling by hand | Fine as is with F3; §6 O3 on the lead for a person | M / M |
| C15 | Area queued until the agent wakes | `work.rs`, routine schedule | "Sırada" | Yes | Yes when the agent runs | — | `feat/agent-wake` | H / M |
| C16 | Approval of a planned post / TikTok posting screen | `studio/chain.rs`, `studio/tiktok.rs` | "Onayınızı bekliyor", TikTok screen | Yes (F3 says it at connection) | Waits for the person, by design | No (the final look) | Fine as is | H / L |
| C17 | `material_check_hold` at publishing (permission revoked, window passed) on a version's post | `studio/materials.rs` `publish_check` | Social page "Bekletiliyor"; `next_action: fix_piece` (the piece is the version: only a revision fixes it) | Partly (windows are checked at scheduling) | Yes for a permission given again (derived); else revision | No (third-party protection) | Fine as is; **proposed** copy: "İçeriği düzenleme isteyin" as the action | L / M |
| C18 | `account_paused`, `studio_braked` | `studio/chain.rs`, `schedule.rs` | "Duraklatıldı"; red stage | Yes | Yes on resume | Owner's own act | **Built**: a version made for a paused account said `its_account_unavailable` whenever another account was open (found by the journey tests); it now says `account_paused`. F3 line | L / L |
| C19 | `capability_unavailable`, `access_expired`, `credential_scope_missing` at sending | `studio/chain.rs` `capability_access` | Social header "Bağlantı kullanılamıyor"; pending `reconnect` | A missing write scope is knowable at connection | Yes on reconnect, unless the attempt already failed (C8) | No | F3 says "Bağlantıyı yenileyin" at connection and on the header | M / M |
| C20 | `area_redo_open`, `version_already_scheduled`, `version_cancelled` | `schedule.rs` | Refusal text | — | — | No | Fine as is | L / L |
| C21 | Package requests (olay, calendar, floor) expire after 7 days | `planner.rs` | Agent only | — | A new trigger opens a new one | No | Fine as is | L / L |
| S1 | Nothing said at connection about what stops a post there | `connector.rs` `confirm_assets`; panel `OAuthCallbackPage` | Toast "Bağlanan hesap sayısı" | **Yes** | — | — | **Built F3**: the connect success state lists each new social account's stops | H / H |
| S2 | Account header says "Paylaşım açık" while the connection cannot post | panel `AccountHeader.tsx` (stored status only) | "Paylaşım açık" | Yes | — | No | **Built F3**: the header shows the checklist for an account that cannot post yet | M / L |
| S3 | TikTok's screen missing from the header badge and the settings help | `AccountHeader.tsx`, `SettingsDialog.tsx`, `CapabilityCard.tsx` | No badge; "Onay gerekmez" | Yes | — | No | **Built** for the header (`requires_human_approval` now effective); settings/capability card proposed | H / L |
| S4 | `capabilities.set_policy` replaces the whole policy; an agent's key can switch `requires_human_approval` off | `capabilities.rs` `set_policy` | Nothing | — | — | Inverse: an agent can remove the owner's gate | **Needs the owner's decision** (§6 O4) | L / H |
| S5 | Retiring an account leaves its planned posts, which then miss grace | `capabilities.rs` retire | Retire dialog does not mention posts | Yes | Becomes C7 (now freed by F4, then blocked `no_connected_account` if no account is left) | Yes | **Proposed**: retire cancels and frees, the dialog says how many | L / M |
| S6 | Removing an account from a capability group drops it out of a group-narrowed strategy channel | `groups.rs` | Later `channel_not_in_strategy` | Yes | Derived | Possibly | **Proposed**: warn on remove | L / L |
| S7 | OAuth state/pending TTL, `account_mismatch`, `account_taken`, provider app not configured | `connector.rs` | "…süresi doldu…; yeniden başlatın" | Yes | Restart | No | Fine as is | L / L |
| S8 | Verification older than 30 days; probe unreachable | `jt_capability/status.rs`, `jt_connector/health.rs` | "Doğrulama eskidi", "Yoklama başarısız" | Yes | Yes (hourly probe) | No | Fine as is | L / L |
| T1 | Gap `hypotheses[i].channel` when the kind is connected but not a chosen channel | `strategy.rs` `approval_gaps`; panel `GapList.tsx` | "{{n}}. hipotez: bu kanal için bağlı hesap yok." (false) | Yes | Derived | No | **Built**: copy says the true cause | M / L |
| T2 | Strategy with organic cadence 0 a week posts nothing | `strategy.rs` `submit` | Later C2 | Yes at approval | Needs a new version | Possibly | **Proposed**: an approval note "bu strateji paylaşım planlamaz" | L / M |
| T3 | `no_paid_lane` when a person opens an ad campaign | `ads/mod.rs` | "Onaylı stratejide … ücretli kanal yok" | Yes | Clears on approval | **Yes** | **Needs the owner's decision** (§6 O6) | M / M |
| T4 | Approval conflicts, archive, consultation states | `strategy.rs` | Draft gaps, "Önce bir strateji onaylayın" | Yes | Resubmit/approve | No | Fine as is | L / L |
| A1 | `binding_stale` after every hourly probe rewrites `last_verified_at` and evidence → automatic paid brake | `studio/chain.rs` `binding_current`, `studio/ads.rs` refresh | Pending `rebind_adset`; ads "Reklam harcaması durdurulmuş" | n/a (time) | **No**: rebind and release the brake by hand | **Yes**: stops campaigns the owner approved | **Proposed** (spend safety, tested separately): compare the account's identity, not the probe's time; refuse one binding instead of braking the lane; release a system brake when its cause clears | M / H |
| A2 | Any refusal in `refresh_period` brakes the whole paid lane | `studio/ads.rs` | as A1 | Partly | No | Yes | **Proposed** with A1 | M / H |
| A3 | `requires_human_approval` on an ad account is shown but the ads module never reads it | `usecases/ads/*` | "Her eylem insan onayı bekler" | — | — | Shows a protection that is not there | **Proposed**: hide the line for ad kinds or honour it (§6 O7) | L / M |
| I1 | `response_sla` handover (15 min WhatsApp/DM, 60 min comments/SMS) against a daily agent check-in; nothing gives it back | `jobs.rs` `run_inbox_timer`; `ports/mod.rs` `InboxPolicy::default` | "ekibe devretti"; the agent loses the conversation | Yes (check-in interval known) | **No**: a person must hand it back | **Yes**: takes back work the owner delegated | **Needs the owner's decision** (§6 O1) | H / H |
| I2 | `reply_window_closed` (24 h) also on email and SMS | `inbox/replies.rs` `fence` | "Bu kanalda yanıt süresi doldu." | Yes | Only when the customer writes again | **Yes**: the owner's own reply | **Proposed** as a bug (the code's own comment says email/SMS have no such window; only Meta's channels do); not built here (§6 O2 for the window length) | H / H |
| I3 | SMS reply: `strategy_required` before queuing; at sending `unknown_unit_price`, `lane_budget_missing`, `outside_work_hours`, `spend_stopped` | `inbox/replies.rs`, `studio/budget.rs` | "Gönderim için onaylı bir strateji gerekiyor." then a generic conflict while it may still go out later | Yes (at connecting the line) | Mixed: some retry by themselves after the person was told it failed | Strategy gate **yes**; spend limits no (keep) | **Needs the owner's decision** (§6 O1); answer `queued` with `waits_for` instead of an error (proposed) | H / H |
| I4 | `journey_lost` disables replies to a customer who writes again | `jt_inbox/fence.rs`, `inbox/consumer.rs` | "Bu yolculuk kaybedilmiş…" | Yes | No: an owner/manager reopens | **Yes** | **Needs the owner's decision** (§6 O1) | M / H |
| I5 | An agent's reply refused while a person holds the conversation; its text is thrown away | `jt_inbox/fence.rs` | Agent: FORBIDDEN | Yes | No: the agent redoes it after a hand-back | Designed gate; wrong after I1 | **Proposed**: keep it as a held draft the person sends in one click | H / M |
| I6 | `executor_changed` kills a person's own queued reply when they hand back | `jt_inbox/fence.rs` | "Gönderim reddedildi: executor_changed" (raw) | No | No: resend | Yes | **Proposed** (bug): refuse only agent-written rows on a generation change | M / M |
| I7 | Appointment booking fails as a whole on an ambiguous mailbox or a closed window | `inbox/appointments.rs` | "Bu işlem mevcut durumla çakışıyor." | Yes | No | **Yes**: the owner booking in person | **Proposed**: use the conversation's channel; the notification never fails the booking | M / H |
| I8 | Quote sending: `capability_down`, ambiguous mailbox, `reply_window_closed`, `quote_expired` (raw) | `inbox/quotes.rs` | generic conflict / raw code | Yes | No | Yes | **Proposed** as I7 | M / M |
| I9 | Comment-reply refusals (`deadline_passed`, `contact_data_in_public_reply`, `private_window_closed`, …) shown as "Bu işlem için yetkiniz yok." | domain `public.rs`; panel `lib/errors.ts` | wrong sentence | mostly | varies | No (platform rules, keep) | **Proposed**: words for each code | H / L |
| I10 | `inbox.send` (a person's own commercial message) behind the strategy gate | `catalog.rs`, `gate.rs` | "…önce onaylı bir strateji gerekiyor." | Yes | Send again after approval | **Yes** | **Needs the owner's decision** (§6 O1) | M / M |
| I11 | Temporary `capability_down` refuses for good at sending | `inbox/replies.rs`, `fence.rs` | "Gönderim reddedildi: capability_down" | No | No | partly | **Proposed**: keep queued while unreachable, within the window | M / M |
| I12 | Inbox module needs a messaging capability; comments from Instagram/Facebook come in but cannot be reached | `modules.rs` | "Bu bölüm, gerekli yetenek bağlanıp…" | Yes | Yes | No | **Proposed**: requirement `messaging|instagram|facebook_page` | L / H |
| I13 | Quote acceptance needs a confirmed delivery; a Won journey refuses a repeat | `inbox/quotes.rs` | generic conflict | Yes | No | Yes | **Proposed** | L / M |
| I14 | Held comment reply waits for approval; approval after the item's deadline fails as "yetkiniz yok" | `inbox/replies.rs`, `public.rs` | "Onay bekleyen taslak" | Yes | Waits by design | No | Fine as is; deadline on the home agenda (proposed) | M / L |
| I15 | Platform and third-party rules (Meta 24 h, one private reply, suppression, consent, erased people, daily caps) | `jt_inbox` | various | Yes | Derived | No | Fine as is: they protect other people | — |
| R1 | `prospecting_off`: a research task asked for without an ICP in the strategy, said only after the form is filled | `research.rs` | "Onaylı stratejide hedef müşteri profili yok…" after submit | **Yes**: known before the form opens | No: strategy edit and approval | **Yes**: the owner's one-off brief | **Proposed**: say it before the form (panel); a person's one-off task without an ICP is §6 O8 | M / M |
| R2 | Standing research tasks superseded on every approval, even with the same ICP entry (`task_closed`) | `research.rs` `plan_in` | "Strateji değişince kapandı" | Yes | A replacement opens, but claims and counters are lost and the error does not name it | No | **Proposed**: keep the task when its ICP entry is unchanged, else `replaced_by` | M / M |
| R3 | `rubric_mismatch`, `daily_cap`, claim lease, `standing_task` close, research gate | `prospects/*`, `research.rs` | clear sentences | Yes | Derived / by time | Minor | Fine as is; a release action for a claim proposed | L / L |
| G1 | Agent rule "schedule only where `requires_human_approval` is true" (the routine's prompt) | routine | — | — | — | Stopped the owner's TikTok post | **Built F5**: `versions_waiting` says per account whether a person gates it and that every listed account may be scheduled | H / H |
| G2 | Agent has to choose a hypothesis at delivery without knowing which account's channel the version goes to | `CONTENT_AREA_HINT` | — | — | — | — | **Built F1/F5**: the hypothesis is a preference; the hint says so | H / M |
| G3 | Inbox tool texts do not say intent (reply vs commercial), the 24 h window, `held`, a person holding the conversation, `item_id` for comments | `jt_mcp/tools/inbox.rs` | — | — | — | — | **Proposed** | M / M |
| G4 | Refusals carry only `details.reason`: nothing says what clears them or when | all `chain::refuse` | — | — | — | — | **Proposed**: `clears_when` (`person`, `time`, `strategy`, `connection`) next to `reason` | M / M |

## 4. Decisions

| # | Decision |
|---|---|
| F1 | **A version's hypothesis is a preference.** The agent names a hypothesis when it delivers a version, before it knows which account the version will get. On every read (`social.versions_waiting`, `work.pending`, the content page) and again at `social.version_schedule`, the hypothesis of a post made of a version on an account is settled from the strategy in force: the version's own when it posts on that account's channel; else the first hypothesis of the **same segment** that posts there; else the first hypothesis that posts there; else, under F2, the owner's request; else the version is genuinely blocked with the true reason. "Posts there" is the existing rule (`posts::content_types`: live, channel `any` or the kind, an organic cadence with a content type). The version itself is not rewritten (it says what the agent delivered); the slot's chain, its arm and the planned post carry the hypothesis used, so learning and measurement read the truth, and the ledger entry `social.version.attributed` (`version_hypothesis_id`, `hypothesis_id`, `attribution`: `segment`, `channel` or `owner_request`, `born_version_id`) says why whenever it is not the version's own. Why the same segment first: the content was made for that audience; another channel of the same audience is the closest claim the measurement can make. |
| F2 | **The owner's request is a built-in hypothesis, "Sahibin isteği".** A content a person created in person (`studio.project_create` from a panel session, recorded as `ProductionProject.requested_by`; an agent's key never sets it) and that names an account, or names a format only one platform takes (a TikTok video, a reel, a story), goes out on that account even when no hypothesis of the strategy posts there. Its post is attributed to one hypothesis per workspace (stable id `stable_id(ws, "strategy.hypothesis:owner_request")`, channel `any`, segment `owner_request`, one organic content type `owner_request`), written into the strategy in force the first time a post needs it and carried into each version approved after one that has it. Why a hypothesis and not a bypass: every slot, arm and measurement references a hypothesis of the version it was born under (foreign keys of migration 0009, and `validate_chain` at sending); a real row keeps that chain whole and keeps what these posts earn on arms of their own, never mixed into a hypothesis the strategy wrote. It is never listed with the strategy (`strategy.get`, the drafts, the approval gaps, the hypothesis count), never an option of the planner or of an agent's own package (`posts::open_channels`, `check_item` refuses it outside a version's own package), and refused in a delivery (`hypothesis_reserved`). It does not bypass the strategy's channel choice: a strategy that chooses neither the kind nor `any` still stops the post (`channel_not_in_strategy`), because `validate_chain` checks it at sending; F3 says it at once with the action that adds the channel (§6 O9). The finished post still waits for its account's approval or TikTok's screen. Agent-created and system-created contents keep today's gate. |
| F3 | **What stands in the way is said when a person asks.** `social::ready` works out, from the facts now, every stop between a request and a post on an account: `reconnect`, `paused`, `braked`, `no_approved_strategy`, `channel_not_in_strategy` (each blocking), and what a post there will meet: `no_hypothesis` (advice: the agent plans nothing there by itself, the owner's requests still go out), `only_format`, `posting_screen`, `approval`, `lead` (hours for the format). For a content naming its accounts it adds `media_missing` when none of its materials is something the platform takes. Each stop has one action (`reconnect`, `resume`, `approve_strategy`, `prepare_strategy`, `add_material`) or none. They ride on what the pages already read: `stops` on each account of `social.accounts_list`/`account_get` (connect success state, social account header, the composer), `checks` on each content row of the content page. Nothing is stored: a stop goes the moment its cause does. `prepare_strategy` is `strategy.add_channel` (panel only, a person in person): it prepares the draft that adds the channel and, for each segment the strategy speaks to, a hypothesis on it mirroring that segment's first live one, and submits it when it has no gap, for the owner to approve. |
| F4 | **Work taken back by the system waits again by itself.** When a strategy change retires a version's planned post (`hypothesis_retired`, `strategy_archived`), and when a version's post passes its grace without ever being attempted (it waited for an approval or a screen, a hold, a pause), the version is freed in the same transaction and waits for a time again; F1 settles it under the strategy then in force. A post that was attempted and failed stays failed (§6 O5). |
| F5 | **What an agent needs is in the answer.** `social.versions_waiting` gives, per account a version can take (`choices`), `human_gate` (`approval`, `posting_screen`, or none) and `attribution`; its text says every listed account may be scheduled. `social.accounts_list`/`account_get` give `requires_human_approval` true for TikTok too (its screen is a person's step for every post), with `human_gate` naming which. The stored policy is not changed: other gates (inbox replies) read it and must not change. The scheduling hint no longer says "nobody approves the post"; the content hint says the hypothesis is a preference. |
| F6 | **Every blocked reason is derived and says its true cause.** `why_blocked` reasons were already read from the facts on every read; the frozen part was the version's hypothesis (F1) and the dead `slot_id` (F4). New reason `media_not_accepted`. `hypothesis_does_not_post` now means exactly "no hypothesis of the strategy posts on this account's channel", and its copy says so with the fix. The content page's "problem" follows the same reasons, so it goes when they do. |

Where the journey tests live and how to extend them: §7.

## 5. Copy

Checklist lines (`stops.*`, panel `pages/social/Stops.tsx`; `{{platform}}` is the account's kind, `{{format}}` the format's name):

| Code | Line | Action, or what happens by itself |
|---|---|---|
| `reconnect` | {{platform}} bağlantısı şu an paylaşım yapamıyor. | Yeniden bağla |
| `paused` | Bu hesapta paylaşım durduruldu. | Sürdür (on the account itself: "Yukarıdaki anahtardan sürdürün.") |
| `braked` | Tüm paylaşımlar durduruldu. | Paylaşım ayarlarından açılır. |
| `no_approved_strategy` | Onaylı strateji yok; hiçbir paylaşım planlanmaz. | Stratejiye git |
| `channel_not_in_strategy` | Strateji {{platform}} kanalını seçmemiş; buraya paylaşım çıkmaz. | Strateji taslağını hazırla → "Taslak hazır. Onaya git" |
| `no_hypothesis` | Stratejide {{platform}} için hipotez yok: ajan buraya kendi başına paylaşım planlamaz. Sizin istediğiniz içerikler yine paylaşılır. | Strateji taslağını hazırla |
| `media_missing` | {{platform}} yalnızca video alır; bu içerikte video yok. (other formats: "Bu içerikte {{platform}} için uygun dosya yok ({{format}}).") | Video ekle / Dosya ekle |
| `only_format` | {{platform}} yalnızca video alır. | — (left out when `media_missing` already says it) |
| `posting_screen` | Her {{platform}} paylaşımını yayından önce {{platform}} ekranında siz tamamlarsınız. | Sırası gelince size sorulur. |
| `approval` | Her paylaşım yayından önce onayınızı bekler. | Sırası gelince size sorulur. |
| `lead` | {{format}} en erken {{hours}} saat sonrasına planlanır. ("TikTok videosu en erken 48 saat sonrasına planlanır.") | Zaman buna göre seçilir. |

Where: the connect page's success state ("Hesap bağlandı" / "Bu hesaba paylaşım çıkmadan önce bilmeniz gerekenler:" / "Devam"), under a social account's header when a line blocks or the agent posts nothing there by itself, in the new-content composer for the chosen account, and on an opened content for each account it names. TikTok's badge reads "Her paylaşım TikTok ekranını bekler".

Blocked texts (`socialAccounts.blocked.*`), as corrected:

- `material_removed`: Bu sürümdeki bir dosya silindi. Yeni dosyayla düzenleme isteyin. (İçeriği aç)
- `no_approved_strategy`: Onaylı strateji yok; paylaşım planlanamaz. Strateji onaylanınca kendiliğinden devam eder.
- `media_not_accepted`: Bu sürümün dosyaları hesabın platformuna uymuyor (örneğin TikTok yalnızca video alır). Uygun dosyayla düzenleme isteyin. (İçeriği aç)
- `channel_not_in_strategy`: Onaylı strateji bu hesabın kanalını seçmemiş. Stratejiye eklenince kendiliğinden devam eder.
- `hypothesis_does_not_post`: Onaylı stratejide bu hesabın kanalı için paylaşım yapan bir hipotez yok. Stratejiye eklenince kendiliğinden devam eder. (was: "…Sıklığı hiç yazılmamışsa stratejiyi yeniden onaya sunmak tamamlar…", not the cause)
- Strategy gap `hypothesisChannel`: {{n}}. hipotez: bu kanal stratejinin kanalları arasında yok ya da bu kanalda bağlı hesap yok. (was: "bu kanal için bağlı hesap yok", false when the account is connected but the channel not chosen)

## 6. Needs the owner's decision

These change who may publish or send what, weaken a protection, or need a product choice. None is built here.

| # | Question | Recommendation |
|---|---|---|
| O1 | Inbox gates meant for the agent that also stop the owner: the 15/60-minute handover against a daily agent check-in (I1); `journey_lost` disabling replies (I4); the strategy gate on a person's own message and on SMS replies (I3, I10). | Give a timer handover back to the agent on its next check-in when no person acted, and never hand over faster than the agent's check-in. Let a reply (not a commercial message) go to a lost journey's customer who wrote again. Exempt a person's own message from the strategy gate; keep consent, suppression, sender identity and spend limits. |
| O2 | Reply window on email and SMS (I2). | Apply the 24-hour rule only to WhatsApp, Messenger and Instagram DM (Meta's rule). For email and SMS allow a reply for 7 days after the customer's last message (the existing `ANSWERING_WINDOW`). |
| O3 | The posting lead for a post a person schedules by hand (C14): TikTok's 48 hours apply to the owner too. | Keep the lead for the agent; let a person scheduling by hand go down to 15 minutes (the screen and the approval still apply). |
| O4 | An agent's key can switch an account's `requires_human_approval` off through `capability.set_policy`, which replaces the whole policy (S4). | Merge the fields given; only a person in person may turn the flag off. |
| O5 | A post whose only attempt failed or was refused is never sent again (C8). | Free its version when the provider's answer proves nothing was created (a refusal before upload, an expired login, a missing permission); keep "failed for good" for anything that may have reached the platform. Needs a per-provider list. |
| O6 | A person's ad campaign needs a paid lane in the strategy (T3). | Let a campaign the owner opens in person use the general ad budget as its cap when the strategy has no paid lane; agents' campaigns keep the gate. |
| O7 | The approval flag on an ad account is shown but not read (A3). | Honour it in the ads module (a person approves each plan) or remove the line for ad kinds; the first keeps what the owner was promised. |
| O8 | A research task without an ICP in the strategy (R1). | Allow a person's one-off brief without an ICP (its prospects unscored); standing tasks keep needing one. |
| O9 | The owner's request (F2) still needs the strategy to choose the channel (or `any`). | Keep it: choosing a channel is a one-click draft (`strategy.add_channel`), and lifting it would mean posts the strategy's chain cannot validate at sending. Revisit if the owner wants channels outside the strategy entirely. |
| O10 | A person scheduling an agent-made version by hand on an account no hypothesis posts on. | Treat it as the owner's request too (they name the account in person). Not built: the social page lists only the accounts the agent may use; offering the others needs a second list in the answer. |

## 7. Journey tests

`rust/crates/jt_app/tests/journeys.rs`, over the in-memory fakes and scripted providers, no network. A **platform** is one `Platform` row (kind, provider, format, a fitting material, its scopes, whether its policy asks for approval); `journey(p)` walks: connect an account of the kind with a strategy whose hypotheses post elsewhere → the account's stops say `no_hypothesis` (advice) and its person's step → the owner asks for a content naming the account, with a fitting material (no `media_missing`) → the agent delivers under the strategy's own hypothesis → `versions_waiting` offers the account with `owner_request` and the right `human_gate`, and the agent's check-in lists it → the version gets its time, attributed to the owner's request (ledger `social.version.attributed`), the strategy page does not list that hypothesis → the content waits for the owner exactly when the platform or policy asks → the owner's one step (TikTok screen, or approval) → the publisher sends it.

Platforms walked today: TikTok (posting screen), X (no gate), X with approval. Variants: a strategy change mid-way (the production sequence: blocked `hypothesis_does_not_post`, approve TikTok hypotheses, schedulable at once under the same segment's hypothesis, no revision); a post taken back by a strategy change waits again; an account paused and resumed; a material deleted (`material_removed`, then a revision goes out); a revision after scheduling; a post past its grace waiting for the owner's screen waits for a new time; an agent that never comes (queued, not a problem; `media_missing` said at once). Strategy rules are in `tests/strategy.rs` (`add_channel…`, `the_owners_request…`).

**To extend**: a new platform is a new `Platform` and one `#[tokio::test]` calling `journey`; Instagram, Facebook and LinkedIn are the next rows (their publishers need the media-URL path of the scripted Meta/LinkedIn connectors set up). A new gate is asserted where the journey meets it: the reason it gives, then clear its cause and assert the work goes on with nothing redone.
