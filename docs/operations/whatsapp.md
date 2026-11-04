# WhatsApp

Jeeta connects a workspace's WhatsApp number as a `whatsapp_cloud` capability through the
platform's Meta app, in one of two ways the owner chooses in the panel (Hesap bağla → WhatsApp
Business):

| Panel choice | Sign-in | What happens to the number |
|---|---|---|
| "Telefonda WhatsApp Business uygulamasında kullandığım numara" | Embedded Signup of a number already in the WhatsApp Business app ("coexistence", flow `whatsapp_business_app`) | it keeps working in the app on the phone; Jeeta never registers it; the app's contacts and history are asked for once |
| "Yeni bir Cloud API numarası" | Facebook Login, as before | Jeeta registers it for the Cloud API (`POST /{phone_number_id}/register`) |

Spec: `docs/superpowers/specs/2026-11-03-whatsapp-coexistence-design.md`. The adapter is
`rust/crates/adapters/jt_meta` (its crate and module docs hold the calls); Meta's page for the
coexistence onboarding is
<https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users>.

This page is for the operator and the owner: what to configure, what Jeeta does by itself, and
how to read what it reports. No key, secret or token belongs on this page, in Git or in a chat.

## 1. Environment

| Variable | Value |
|---|---|
| `JEETA_META_APP_ID`, `JEETA_META_APP_SECRET` | the Meta app |
| `JEETA_META_VERIFY_TOKEN` | the webhook verify token of **this host** (`GET /hooks/meta` answers Meta's challenge for it) |
| `JEETA_META_WHATSAPP_CONFIG_ID` | the Facebook Login for Business configuration of WhatsApp Embedded Signup; without it the business-app choice is refused (`CONFLICT provider_product_not_enabled`, the panel says the configuration is missing) |
| `JEETA_PUBLIC_BASE_URL` | this host's public address: the redirect URI and the webhook override are built from it |

Hosts: `yeni.jeetagrowth.com` (`/etc/jeeta/jeeta.env`) and `staging.jeetagrowth.com`
(`/etc/jeeta-staging/jeeta.env`). Each host has its own public base URL and may have its own verify
token; nothing in the code names a host.

## 2. What the owner configures in the Meta app dashboard

Jeeta changes nothing in the dashboard. Each item below is for the owner (or whoever holds the Meta
app), and each says what is known and what is not.

1. **The Embedded Signup configuration** (Facebook Login for Business → Configurations). v1 used
   configuration `1621685652883996` (template "WhatsApp embedded sign-up configuration with 60-day
   expiry token"). Check it still exists and set its id as `JEETA_META_WHATSAPP_CONFIG_ID` on the
   host. Meta's page says the feature is on when the account-selection screen of the sign-in
   offers to connect an existing WhatsApp Business account; whether the configuration needs a
   separate coexistence option, or a new configuration for Embedded Signup v4/v5, is **not
   verified**: open the sign-in on staging and look for that option on the account-selection
   screen. Meta also says the app must be a Tech Provider or Solution Partner.
2. **Redirect URI.** The sign-in comes back to `https://<host>/oauth/callback/meta`, the address
   every Facebook Login flow of that host already uses (Valid OAuth Redirect URIs). Where Facebook
   Login works on a host, nothing new is needed.
3. **Webhook fields** (Webhooks → WhatsApp Business Account): keep `messages`, and subscribe
   `smb_message_echoes`, `history`, `smb_app_state_sync` and `account_update` (the four Meta's
   page names for these numbers). Without them nothing the phone sends, no history and no
   disconnection reaches Jeeta.
4. **Permissions.** `whatsapp_business_management` and `whatsapp_business_messaging`; a business
   outside the app's own portfolio needs them with Advanced Access (App Review).

## 3. Which host receives a WhatsApp account's webhooks

The Meta app has one callback URL (during App Review it points at staging). When a number is
connected, Jeeta subscribes its WhatsApp Business Account and then sets an **override** on it
(`POST /{waba_id}/subscribed_apps` with `override_callback_uri` = this host's public base URL +
`/hooks/meta` and this host's verify token; Meta's page:
<https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override/>).
So a number connected on yeni sends its messages, echoes, history and contacts to yeni, and one
connected on staging to staging, whatever the app's callback URL is.

- The override is reported on the capability as `connector_public.callback_override` (`true` once
  Meta took it). `false` means the plain subscription stands and the events go to the app's
  callback URL: check that `JEETA_PUBLIC_BASE_URL` and `JEETA_META_VERIFY_TOKEN` are set on the host
  and that `https://<host>/hooks/meta?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=1`
  answers `1`.
- A number connected before this change has no override: reconnect it once (panel → the
  capability → Yeniden bağla) to set it.
- **`account_update` never follows an override** (Meta's override page): disconnections always go
  to the app's callback URL. While that points at staging, yeni does not hear its numbers'
  disconnections; the hourly probe is the only backstop, and whether a disconnected number fails
  its probe is not verified.

## 4. After a business-app number is connected

- **No registration.** The connection step asks Meta `is_on_biz_app` and never registers a number
  on the app or one connected through the business-app sign-in (`connector_public.registered` is
  `false`, `on_business_app` says what Meta answered).
- **One-time sharing, within 24 hours.** The job `whatsapp_app_sync` (every 5 minutes) asks for the
  app's contacts, then its history (`POST /{phone_number_id}/smb_app_data`), once each, while the
  capability is verified (an unreachable one waits, and turns `expired` once its 24 hours pass).
  Where each stands is on the capability, `connector_public.business_app`
  (panel: "WhatsApp Business uygulamasından aktarım" on the connection; MCP:
  `jeeta.capability.get`):

  | State | Meaning | What to do |
  |---|---|---|
  | `due` | not asked yet (`retry_reason`: Meta was busy, asked again on the next run) | wait 5 minutes |
  | `requested` | Meta took it (`request_id`, keep it for Meta support); the data arrives only if the business allows sharing in the app | keep the app open on the phone |
  | `refused` | Meta refused (`reason`: its error, e.g. a country or account the feature is not offered for) | read the reason; Turkey's (+90) support is not confirmed either way |
  | `unknown` | the request may have reached Meta but its answer was lost; never asked twice | ask Meta support with the time |
  | `expired` | the 24 hours passed first | Meta's page: the business must be offboarded and go through the flow again (it disconnects in the app, then reconnects the number here); a reconnection without offboarding starts a new window in Jeeta, and Meta's answer to the new request shows as `requested` or `refused` |

  A business that declined to share its history shows in the ledger as `inbox.whatsapp_history`
  with `declined: true` (Meta's code 2593109); each history chunk's progress as
  `inbox.whatsapp_history` with `progress`.
- **The history is the past.** History messages are filed in each customer's conversation at
  their own time, from the customer or from "İşletme · WhatsApp Business uygulaması"; a
  conversation they start is open with nothing owed, no journey moves, no 24-hour customer
  service window opens, and no agent is asked to answer (the events are stored already
  processed). Contacts become people (source "İçe aktarma"); a contact removed in the app changes
  nobody.
- **What the business sends from the phone** appears in the thread as "İşletme · WhatsApp
  Business uygulaması". When it answers the customer's last message, the conversation is no
  longer waiting for a reply, so the agent does not answer again.

## 5. Disconnection

`account_update` `PARTNER_REMOVED` (with Meta's `disconnection_info.reason`) or
`ACCOUNT_OFFBOARDED` turns every number of that WhatsApp Business Account in the workspace
`unreachable` with `reconnect_required`, its reason on the capability's health line and the ledger
entry `connector.authorization_removed`. Meta's page: the Deregister API cannot be used on such a
number; the business disconnects in the app (Settings → Account → Business Platform → Disconnect
Account).

## 6. Limits (Meta's page)

20 messages per second for a number on both the app and the Cloud API; no group chats; no
disappearing or view-once messages, live locations, broadcast lists, calls or catalogs through
the Cloud API; the app version must be 2.24.17 or later.
