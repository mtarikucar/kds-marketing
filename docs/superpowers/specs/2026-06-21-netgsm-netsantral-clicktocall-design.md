# NetGSM Netsantral click-to-call — multi-tenant cloud-PBX dialing

**Date:** 2026-06-21
**Status:** Design — awaiting approval
**Part of:** [[netgsm-integration]] / [[ghl-parity-program]]

## Problem

Today the marketing app can only do **click-to-dial** for outbound sales calls: the
`NetgsmLiteAdapter` returns a `tel:` URI that the rep's own device dials, so the call
goes out from the **rep's personal SIM** — the customer sees the rep's number, not the
business line. The company bought a real **0850 number (08508407303)** and wants calls
to originate **from the 0850** (proper caller ID, billed through NetGSM).

`tel:` links fundamentally cannot do this. Originating from the 0850 requires
**NetGSM Netsantral** (NetGSM's cloud PBX), which exposes a programmatic
**call-origination ("dış arama" / tıkla-ara) API**: NetGSM rings the rep's extension
(`internal_num`), then dials the customer (`customer_num`), and bridges them over the
`trunk` (the 0850) — so the customer sees 0850.

The codebase already anticipates this: `TelephonyProvider` is a registry-based
interface, `NetgsmLiteAdapter` is explicitly the "Lite / click-to-dial" provider, and
its header comments say a `NetgsmApiAdapter` with `api-dial` / `recording` / `webhook`
capabilities "is added later, registered alongside; SalesCallService is unchanged."
This design fills that in.

## Multi-tenant constraint (drives everything)

This product is **SaaS**. Every tenant (workspace) brings their **own** NetGSM
account, 0850 trunk, and extensions, and must **self-serve** their Netsantral
integration. Therefore:

- Netsantral credentials/config are **per-workspace, sealed in the DB** (AES-256-GCM,
  reusing `secret-box.helper`) — **NOT** environment variables. (The current
  `NETGSM_SALES_LINE` env var is single-tenant and stays only as a legacy fallback for
  the Lite adapter.)
- There is a **self-service settings UI** for a tenant manager to enter their
  Netsantral creds + trunk and map each rep → extension (dahili).
- Everything is **workspace-scoped** and gated by the existing `telephony` entitlement
  feature.

## Grounded API facts (from official package + bilgibankası)

- **Auth:** `username` = the 11-digit abone no / `850XXXXXXX`, `password` = the API
  **sub-user** password (same credential family as the SMS integration). Posted in the
  request body, never the query string (mirrors SMS hygiene).
- **Origination** (`call.start`): params `customer_num` (lead, `5XXXXXXXXX`),
  `internal_num` (rep extension, e.g. `104`), `trunk` (`850XXXXXXX`); also documented:
  `pbxnum`, `originate_order`, `ring_timeout`, `wait_response`, `crm_id`, `call_time`.
  Response includes a `unique_id` (the call id) + status.
- **Other ops** (future): `call.end`, `mute/unMute`, `transfer`, queue stats/breaks.
- **OPEN ITEMS to lock from official docs + a live capture** (JS-rendered dev portal,
  not scrapeable now): the exact origination **base URL/endpoint path**, the **webhook /
  CDR event** wire format (ringing/answered/hangup/duration), and **recording**
  retrieval. Phase 2 code parses these **tolerantly** (unreadable shape → safe no-op,
  call stays in its last known state) — the same strategy used for the SMS `/sms/report`
  format.

Sources: netsantraldokuman, sanal-santral/custom-api, `netgsm/netsantral` (PHP),
`bahri-hirfanoglu/netsantral-js`.

## Architecture

Reuse the existing telephony seam; add a workspace-aware provider + per-workspace
config. Units kept small and single-purpose:

| Unit | Responsibility | Depends on |
|---|---|---|
| `TelephonyConfig` (Prisma model) | per-workspace Netsantral config: sealed `{username,password}`, public `{provider, pbxnum, trunk, status}` | — |
| `TelephonyConfigService` | CRUD + seal/open + mask (never returns secrets, only which keys set); mints the webhook token | secret-box, prisma |
| rep `dahili` field | per-user extension mapping (on the marketing user / membership) | — |
| `netsantral.client.ts` | thin HTTP client: `originate()` (+ Phase 2: recording fetch); `withRetry` + `AbortSignal.timeout` + password scrub | — |
| `NetgsmApiAdapter` | `TelephonyProvider` (`api-dial`, +P2 `recording`,`webhook`); `prepareOutboundCall` calls `originate()` and returns `{externalCallId: unique_id, mode:'api-dial', dialUri:null}` | client, registry |
| `SalesCallService` (extend) | resolve provider **per workspace**: Netsantral config ACTIVE → api-dial; else Lite (tel:) fallback. Records `SalesCall` with `externalCallId` | telephony registry, config service |
| `TelephonySettingsPage` (FE) | self-service config + rep→dahili UI + webhook URL display (P2); mirrors `ChannelsSettingsPage` | marketingApi |
| `ClickToDialButton` (FE, extend) | branch on returned `mode`: `click-to-dial` → `tel:` (today); `api-dial` → "calling… your extension is ringing" state, no redirect | — |
| `NetsantralWebhookController` (P2) | public **tokenized per-workspace** URL; verifies HMAC token, workspace-scopes, parses CDR → updates `SalesCall` status/duration/recording | callback util, ingress |

The `TelephonyProvider.prepareOutboundCall` signature gains a resolved `config`
(creds + trunk + internal_num), mirroring how `ChannelAdapter.send` receives
`config.secrets`. The Lite adapter ignores it (still returns a `tel:` link).

## Call flow (Phase 1)

1. Rep clicks **Call** on a lead/Calls page → `POST /marketing/calls/start {toPhone, leadId}`.
2. `SalesCallService.startCall`: load workspace `TelephonyConfig`.
   - **ACTIVE Netsantral** → resolve rep's `internal_num`; `NetgsmApiAdapter.prepareOutboundCall`
     → `netsantral.originate({customer_num: toPhone, internal_num, trunk, creds})` →
     `unique_id`. Create `SalesCall {status: INITIATED, externalCallId: unique_id}`.
     Return `{call, mode:'api-dial', dialUri:null}`.
   - **No config** → Lite fallback: `{call, mode:'click-to-dial', dialUri:'tel:…'}` (today's behavior).
3. NetGSM rings the rep's extension (their GSM via dahili-forward, or a softphone — a
   NetGSM-side dahili setting, transparent to us → "supports both"), rep answers, NetGSM
   dials the customer, bridges over 0850.
4. **Phase 1:** rep logs the outcome manually (existing `POST /calls/:id/log`).
   **Phase 2:** the webhook auto-updates status/duration + attaches the recording.

## Security & multi-tenancy

- Creds **sealed** per workspace (`secret-box`, needs `MARKETING_SECRET_KEY`); masked
  reads expose only which keys are set — same contract as `ChannelsService`.
- Phase-2 webhook URL is **per-workspace, HMAC-tokenized** (NetGSM does not sign
  callbacks) — reuse the `netgsm-callback.util` pattern (`HMAC-SHA256(MARKETING_SECRET_KEY,
  "netsantral-cdr:<workspaceId>")`), constant-time verify, ACTIVE-config guard, batch cap.
- All reads/writes **workspace-scoped**; gated by `@RequiresFeature('telephony')` and
  `settings.manage` / `leads.write` permissions (as today).
- Password never logged; scrubbed from errors (mirror `NetgsmSmsAdapter`).

## Phasing (build order)

**Phase 1 — outbound core (independently shippable):**
TelephonyConfig model + service + sealing · rep `dahili` field · `netsantral.client.originate`
· `NetgsmApiAdapter` (api-dial) · workspace-aware provider selection in `SalesCallService`
· `TelephonySettingsPage` (creds + trunk + rep→dahili) · `ClickToDialButton` api-dial mode.
→ Calls originate from 0850; outcome via existing manual log. Inert until a workspace
configures Netsantral (and provisions it at NetGSM) — safe to ship ahead, like the SMS work.

**Phase 2 — automation:**
Public tokenized `NetsantralWebhookController` · CDR parse → `SalesCall`
status/duration/`recordingRef` · recording playback (authenticated proxy/download +
Calls-page player) · webhook URL surfaced in settings to paste into the NetGSM panel.
→ Auto status + recording. Wire format locked from official docs + live capture.

## Dependencies & risks (independent of code quality)

1. **Per-tenant Netsantral provisioning** — Netsantral is a separate **paid** NetGSM
   product; the tenant must provision it, set the 0850 as trunk, and create extensions.
   Nothing fires until a workspace has an ACTIVE config → safe to ship ahead.
2. **Phase-2 wire format unknown** from public docs → lock from official Netsantral docs
   + a live captured CDR/recording; until then Phase-2 parsing is tolerant (null = no-op).
3. **Origination endpoint/base URL** to confirm from official docs before Phase-1 wiring;
   the client isolates it behind one constant (one-line change when confirmed).

## Testing

- Unit: `netsantral.client` (mocked fetch: success `unique_id`, error codes, timeout,
  password scrub); `NetgsmApiAdapter` (origination params built correctly);
  `SalesCallService` provider selection (config present → api-dial; absent → Lite);
  `TelephonyConfigService` seal/open/mask + token mint/verify.
- FE: `TelephonySettingsPage` mounts + saves; `ClickToDialButton` renders both modes
  without crashing (regression-guards the Radix-Select class of bug just fixed).
- Phase 2: webhook token verify (valid/forged), CDR parse (known + unknown shape → no-op),
  workspace scoping.

## Out of scope (YAGNI for now)

Inbound call routing/IVR via Netsantral, queues/agent-break management, attended
transfers, WebRTC in-browser softphone, real-time call control (mute/hold) from the UI.
The interface leaves room (`call.end/transfer/queue` exist) but we don't build UI for them.
