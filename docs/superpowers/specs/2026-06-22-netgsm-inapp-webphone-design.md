# In-app WebRTC webphone (NetGSM Netsantral) — design

**Date:** 2026-06-22
**Status:** Design — awaiting approval
**Part of:** [[netgsm-netsantral-telephony]] / [[ghl-parity-program]]

## Problem & goal

Reps must place AND receive calls **directly in the marketing app, in the browser, with zero per-person setup** — no installing/configuring a softphone per user. Calls go out from the tenant's **0850 trunk** (business caller id) and inbound 0850 calls ring in the app. This is the "team uses it directly" requirement; it is the same SIP/dahili foundation the future AI-voice agent will sit on.

## Key finding that fixes the architecture (from the spike)

A free **UDP/TCP softphone (Zoiper) FAILED** to register to NetGSM ("SIP UDP/TCP: Not found"). NetGSM Netsantral exposes client registration to third parties **only over WSS/WebRTC** (or its own licensed Netsipp+). Therefore a browser **WebRTC webphone is the only viable third-party path** — which is exactly what we want. The WSS endpoint is known (shown on the dahili edit screen):

- **WSS:** `wss://sip5.netsantral.com:8089/ws`  ·  **SIP domain:** `sip5.netsantral.com`
- Per-rep **dahili** (extension, e.g. `101`) + its **SIP password**; outbound caller id = the dahili's "Varsayılan Giden Numara" / the **0850** trunk.

## Architecture

A browser SIP client (**SIP.js**, its `SimpleUser`/`UserAgent` API) embedded app-wide, registered to the rep's dahili over WSS while the rep is logged in. Outbound: the webphone places the INVITE; the santral routes it out via the 0850 trunk (no `originate` API needed — the Phase-1 `originate` stays as the fallback for reps with no webphone). Inbound: the santral routes 0850 inbound to the dahili → the registered webphone rings in-browser.

| Unit | Responsibility | Depends on |
|---|---|---|
| `TelephonyConfig` (+fields) | per-workspace `wssUrl` + `sipDomain` (already has sealed creds + trunk) | — |
| per-rep dahili secret | each rep's dahili number (`MarketingUser.dahili` exists) + **sealed SIP password** | secret-box |
| `GET /marketing/telephony/webphone-token` | returns the calling rep's webphone config `{wssUrl, sipDomain, dahili, sipPassword, displayName}` — auth'd, telephony-gated, **own rep only**, over HTTPS | config service |
| `webphone.store.ts` (FE) | SIP.js `UserAgent` lifecycle: fetch token → register on login → re-register/backoff → unregister on logout; exposes call state | SIP.js |
| `WebphoneProvider` (FE, app-shell) | mounts the store app-wide so the phone is live on every page; renders the dock + incoming-call modal | webphone.store |
| `WebphoneDock` (FE) | persistent mini-UI: status (registered/online), dialpad, active-call controls (answer/hangup/mute/hold), call timer | webphone.store |
| click-to-call hook | a lead/contact "Call" button → `webphone.call(number)` (replaces the `tel:`/originate path when a webphone is registered) | webphone.store |
| SalesCall logging | on call start/end, create/update a `SalesCall` (reuse existing service) so the Calls page + lead timeline capture webphone calls | SalesCallService |

SIP.js is the chosen lib (well-maintained, `SimpleUser` covers register/call/answer/hangup/mute cleanly over WSS+WebRTC). One small store with a clear interface; UI components are thin consumers.

## Call flows

**Outbound:** rep clicks Call on a lead → `webphone.call('+90…')` → SIP.js INVITE over WSS → santral dials out via 0850 trunk → media (DTLS-SRTP) in the browser → on connect, create `SalesCall(status INITIATED→CONNECTED)`; on end, set duration.
**Inbound:** 0850 inbound → santral gelen-çağrı routes to the dahili → SIP.js receives the INVITE → `WebphoneProvider` shows an incoming-call modal (caller id) → rep answers in-browser → media → `SalesCall(direction INBOUND)` logged.

## Security & multi-tenancy

- Per-rep dahili **SIP password sealed** (AES-256-GCM, secret-box), served only to the authenticated owning rep over HTTPS via the webphone-token endpoint (never to others; never logged). Same sealing contract as channel/telephony creds.
- `wssUrl`/`sipDomain` are per-workspace (`TelephonyConfig`). Everything workspace-scoped + `@RequiresFeature('telephony')`.
- getUserMedia (mic) needs a **secure context** → only works over the prod **HTTPS** app (already the case) — not file://.

## Phasing (build order — de-risk first)

**Phase A — foundation / de-risk (vertical slice, ships first):** `TelephonyConfig.wssUrl/sipDomain` + per-rep sealed dahili password + webphone-token endpoint + a minimal SIP.js register + a single outbound test call + a basic status indicator. **Goal: prove SIP.js registers to `wss://sip5.netsantral.com:8089/ws` and a call connects with audio over our HTTPS app.** This validates the entire foundation (WebRTC media, ICE, NetGSM compatibility) before investing in full UX. If ICE/media fails without TURN, that surfaces here (see risks).

**Phase B — full call UX:** persistent dock (dialpad + controls), inbound-call modal + answer, mute/hold/hangup, call timer, click-to-call from lead/contact, SalesCall logging (both directions).

**Phase C — provisioning & scale:** manager UI to create/map per-rep dahili + deliver SIP passwords (sealed); package-aware (Eko = 2 dahili → flag upgrade); graceful "no webphone → click-to-dial fallback".

Each phase = its own spec-confirm → plan → subagent-driven build. Phase A is the gating de-risk.

## Risks & dependencies (must surface, not code-quality)

1. **SIP.js ↔ NetGSM WebRTC unverified** — registration auth (realm/SIP headers) + media negotiation may need specifics. Phase A is exactly the probe; confirm with `teknikdestek@netgsm.com.tr` if it doesn't register first try.
2. **STUN/TURN for media** — WebRTC audio may not traverse NAT without TURN. Unknown whether NetGSM provides TURN. If Phase A connects signalling but has no audio, we need NetGSM's TURN (ask teknikdestek). High-uncertainty item.
3. **2-dahili Eko limit** — only 2 reps can have a webphone until the package is upgraded (more dahili). Team-wide rollout = package upgrade.
4. **HTTPS-only** — mic requires secure context; works on the prod app, not local file://.
5. **Inbound routing** — NetGSM gelen-çağrı must be configured (0850 → dahili/IVR) for inbound to ring the webphone (Phase B).
6. **Per-rep SIP creds in the browser** — accepted: sealed at rest, served only to the owning authenticated rep over HTTPS.

## Testing

- BE unit: webphone-token endpoint (own-rep scoping, telephony gate, sealed-password round-trip), TelephonyConfig wssUrl/domain mask.
- FE unit: webphone store state machine (idle→registering→registered→incall) with a mocked SIP.js UserAgent; dock renders each state; click-to-call invokes `call()`.
- Phase A live validation (over HTTPS prod): register shows "online"; an outbound test call connects with two-way audio + shows 0850 caller id.

## Out of scope (YAGNI)

Call transfer/conference, call recording playback (Phase-2 of the click-to-call spec / a later add), advanced IVR, the AI-voice agent (separate future feature that reuses this SIP foundation).
