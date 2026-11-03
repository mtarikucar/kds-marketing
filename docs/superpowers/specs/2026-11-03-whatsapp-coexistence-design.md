# WhatsApp Business app coexistence: design note

Status: draft, 2026-11-03. Scope: Rust Jeeta (`rust/`), the `whatsapp_cloud` capability kind.

## Why

A business that already answers its customers in the WhatsApp Business **app** on a phone (the
first one is figurunica, +90 850 840 73 03) wants the same number in Jeeta's inbox **without
losing the app**. Today's `whatsapp_cloud` connection is for Cloud-API-only numbers: its connection
step calls `POST /{phone_number_id}/register`, which is not what Meta asks for an app number.

Meta's "coexistence" onboarding keeps both. The source of truth is Meta's page
<https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>
(read 2026-11-03). What it says, and what this design relies on:

- Embedded Signup is launched with `extras.featureType = "whatsapp_business_app_onboarding"`,
  `extras.setup = {}`, `extras.sessionInfoVersion = "3"`, `config_id`, `response_type = "code"`,
  `override_default_response_type = true`. The business needs app version 2.24.17 or later; the
  platform must be a Tech Provider or Solution Partner.
- After onboarding: subscribe the webhook fields `account_update`, `history`,
  `smb_app_state_sync`, `smb_message_echoes`; **skip the number's registration** ("the number is
  already registered"); optionally check `GET /{phone_number_id}?fields=is_on_biz_app,platform_type`
  (success: `is_on_biz_app: true`, `platform_type: "CLOUD_API"`).
- `POST /{phone_number_id}/smb_app_data` with `messaging_product: "whatsapp"` and
  `sync_type: "smb_app_state_sync"` (contacts) or `sync_type: "history"` (messages): each **once**,
  **within 24 hours** of onboarding; the answer is `{messaging_product, request_id}`; it does not
  confirm the business agreed to share its history.
- Webhooks (`object: whatsapp_business_account`, each change's `value.metadata.phone_number_id`
  names the number): `smb_message_echoes` (`value.message_echoes[]`: what the business sent from
  the app), `history` (`value.history[]`: `metadata.{phase, chunk_order, progress}` and
  `threads[].messages[]`, or `errors[]` with code `2593109` when the business declined; a media
  item arrives later under `value.messages[]`), `smb_app_state_sync` (`value.state_sync[]`:
  `type: "contact"`, `contact.{full_name, first_name, phone_number}`, `action: add|remove`), and
  `account_update` (`value.event`: `PARTNER_REMOVED` with `disconnection_info.{reason,
  initiated_by}`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`; `value.waba_info.waba_id`; it names
  no phone number).
- Limits: 20 messages per second; no group chats; the Deregister API cannot be used on such a
  number (the business disconnects in the app).

The webhook override page
<https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/>
(read 2026-11-03): `POST /{waba_id}/subscribed_apps` with `override_callback_uri` (at most 200
characters) and `verify_token` sends that WABA's webhooks to another URL; the app must be
subscribed first. `messages`, `message_echoes`, `smb_message_echoes`, `smb_app_state_sync` and
`history` follow an override; **`account_update` never does**: it always goes to the app's own
callback URL.

## Decisions

**D1. Base branch.** Rust Jeeta is not on `main` (no `rust/` there): every Rust PR targets the
integration branch `feat/rust-panel-money-inputs`. This work branches from it and its PR targets
it.

**D2. The sign-in is a redirect, not the JavaScript SDK.** Jeeta's OAuth flows are redirects to
the provider's dialog and back to `/oauth/callback/{app}`. The coexistence flow is one more Meta
flow of that kind: `https://www.facebook.com/{version}/dialog/oauth` with
`config_id = JEETA_META_WHATSAPP_CONFIG_ID` (the WhatsApp Embedded Signup configuration),
`response_type=code`, `override_default_response_type=true` and `extras` as the JSON above.
*Unverified:* Meta documents Embedded Signup through `FB.login` only; that the dialog honours
`extras` when opened by redirect has to be tried on staging (open question Q1). Embedded Signup v5
(released 2026-10-20 per Meta's versions page) turns coexistence on by default; this design sends
the v4 extras the onboarding page shows and does not set `extras.version`.

**D3. The choice is explicit and kept with the flow.** `connector.start_oauth` takes an optional
`flow`: absent is today's Facebook Login ("new Cloud API number"), `"whatsapp_business_app"` is
the coexistence flow ("a number already in the WhatsApp Business app"), accepted only for
`whatsapp_cloud`, and refused `CONFLICT provider_product_not_enabled` while the platform's Meta
app has no WhatsApp configuration id. The flow is stored on the pending row
(`oauth_pending.flow`, migration 0019), so the callback exchanges the code and lists the assets
the way that flow needs. A reconnection of a coexistence capability signs in through the
coexistence flow again.

**D4. Exchange and discovery of a coexistence flow.** The code is exchanged for the business's
token (with the flow's redirect URI, as every redirect flow does); the token is **not** put
through `fb_exchange_token` (a business integration system user token is not a user token;
unverified whether Meta would accept it, so it is not tried). Its WABAs come from
`GET /debug_token` (with the app access token, which Graph's `debug_token` reference accepts)
`granular_scopes[scope = whatsapp_business_management].target_ids`, the method Meta's
"manage accounts" page gives; then each WABA's `phone_numbers`, and each number's
`is_on_biz_app,platform_type` (best effort). Only WhatsApp numbers are offered. Each asset's
public facts say `onboarding: "whatsapp_business_app"`.

**D5. Registration is never forced on an app number.** On every `whatsapp_cloud` connection the
connection step subscribes the WABA, then sets the override (D6), then asks the number
`is_on_biz_app`; it registers only when the number is not on the app and the capability did not
come through the coexistence flow. It reports `subscribed`, `callback_override`,
`on_business_app`, `registered`.

**D6. Each instance receives its own customers' WABA events.** The override URI is this
instance's `JEETA_PUBLIC_BASE_URL` + `/hooks/meta`, the verify token this instance's
`JEETA_META_VERIFY_TOKEN`; `GET /hooks/meta` already answers Meta's challenge for that token.
Nothing is hard-coded: staging subscribes staging, yeni subscribes yeni. Set best effort after the
plain subscription, so a refused override never leaves the WABA unsubscribed.

**D7. The sync job.** `whatsapp_app_sync` (every 5 minutes) asks contacts first, then history, for
every capability whose `connector_public.business_app` says a sync is due and whose 24-hour
window (from `business_app.onboarded_at`, written when the coexistence flow's asset is confirmed)
is open. Each request is asked at most once: a provider answer is written in the same step
(`requested` with the `request_id`, `refused` with the reason), a busy or unreachable provider is
asked again on the next run while the window is open, an answer lost after the request may have
reached Meta (`Unknown`) is **not** asked again (`unknown`, shown to the owner), and a window
that closes first is `expired`. A refusal (an unsupported country included) is shown on the
capability.

**D8. Routing.** `smb_message_echoes`, `history` and `smb_app_state_sync` route by
`metadata.phone_number_id`, as `messages` do. `account_update` names only the WABA: it is routed
to every connected `whatsapp_cloud` capability whose `connector_public.asset.waba_id` is that
WABA, in every workspace. `PARTNER_REMOVED` and `ACCOUNT_OFFBOARDED` turn each such capability
`unreachable` with `reconnect_required` and the reason (`disconnection_info.reason`), as TikTok's
`authorization.removed` does (left alone when the capability was verified after the event);
every other `account_update` event is stored for the agent.

**D9. History is the past.** History, contact-sync and phone-app echo events are stored already
processed (never in `events.pending`, so no agent reacts to them) and the inbox consumer files
them: a history message becomes a message of the person's conversation with that number, at its
own time, inbound from the customer or outbound from the business; a conversation it creates is
**closed** and has no inbound activity (`insert_for_send`), so nothing is owed, no 24-hour
customer service window opens (Meta: only a message to the onboarded business opens one), and no
journey event is written. A message already filed (same `wamid`) is not filed again.

**D10. Phone-app echoes.** An `smb_message_echoes` item is an outbound message authored
`business_app` ("the business, from the WhatsApp Business app"), deduplicated by its `wamid`
against what Jeeta sent and by text against a send in flight. When it is newer than the
conversation's last inbound message, the conversation turns `theirs` (the business answered from
the phone, so no reply is owed and the agent does not answer again); otherwise it only joins the
thread.

**D11. Contacts.** An `add` becomes a person with that phone identity (the existing matching:
an existing identity is reused); a `remove` changes nobody (a phone's address book is not an
erasure request) and is only recorded.

**D12. Failures surface.** Meta's refusals reach the owner where they happen: a refused sign-in
on Meta's own page, a refused discovery as the callback's error, a refused sync on the capability
(`business_app.contacts|history.state = refused` with the reason), a disconnection as
`reconnect_required` with Meta's reason. Turkey's support is not assumed either way.

## Open questions

- **Q1.** Does the dialog honour `extras` when opened by redirect? If not, the panel must launch
  `FB.login` (the JavaScript SDK, a CSP change) and post the code; the rest of this design holds.
- **Q2.** The Embedded Signup configuration (v1 used `1621685652883996`, template "WhatsApp
  embedded sign-up configuration with 60-day expiry token"): does it need the coexistence option,
  or a new configuration, for v4? The owner checks the Meta dashboard.
- **Q3.** Is +90 supported for coexistence? Vendor lists disagree; Meta's page names no country.
- **Q4.** `account_update` always goes to the app's callback, which points at staging during App
  Review: yeni does not hear its customers' disconnections until the callback points at it. The
  hourly probe is the backstop only if a disconnected number fails its probe (unverified).
- **Q5.** D10 turns a conversation `theirs` on a phone-app reply. The owner confirms that is the
  wanted behaviour (the alternative: the echo only joins the thread).
- **Q6.** Existing `whatsapp_cloud` capabilities get the override only when reconnected.
