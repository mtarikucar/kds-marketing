# NetGSM SMS Integration — Completion Design

**Date:** 2026-06-17
**Status:** Approved (scope), in progress
**Branch:** `feat/netgsm-two-way-sms`

## Goal

Make the NetGSM SMS channel work **end-to-end on the real paid account** (number
`0850 840 73 03`): commercial campaigns (İYS-gated), transactional sends
(order/delivery), and **two-way** customer-service replies. Pair work — the
account owner performs NetGSM-panel steps; we implement the code.

## Current state (3 slices, uneven maturity)

1. **Outbound send — works.** `NetgsmSmsAdapter.send()` POSTs `usercode/password/
   gsmno/message/msgheader` to `api.netgsm.com.tr/sms/send/get`, accepts `00/01/02`,
   returns the job id. Driven by `MessageSenderService` (1:1) and
   `CampaignSenderService` (throttled 50/60s) with quota reserve/refund. Secrets are
   AES-256-GCM sealed in `Channel.configSealed`.
2. **Delivery reports — built wrong.** A `POST .../netgsm/dlr` controller expects
   NetGSM to *push* reports. **NetGSM does not push DLRs.**
3. **Inbound MO — broken.** `parseInbound()` exists but (a) no route calls it and
   (b) it reads the wrong field names.

## Corrected architecture (verified vs official `netgsm1/sms` package)

| Concern | Reality | Action |
|---|---|---|
| Delivery reports | **POLL** `GET /sms/report?...&bulkid=<id>&type=0&version=2` (≤10/min). `durumcode` 0=pending,1=delivered,2/3/4/11/12=fail,13=dup,15=blacklist,16/17=İYS. `hatakod`=reason. | Remove push `/dlr`; add a **poll service**. |
| Inbound MO | **PUSH** to our webhook; fields `ceptel, mesaj, gorevid, aboneno, tarih`. Configured panel-side under İnteraktif SMS → "URL Adresine Yönlendir". | Add MO route + fix field mapping. |
| Send errors | `30`=auth/API/IP, `40`=header unapproved, `50/51`=İYS, `20`=msg, `80/85`=rate. | Map codes → meaningful errors. |
| Auth | `usercode`=abone no; `password`=**API sub-user** password (not panel login); API access must be activated. | Document; surface `30` clearly. |
| Header | `msgheader` İYS-approved, 3–11 chars. | DTO validation. |
| İYS | Commercial sends require İYS registration or `50/51`. | Surface error + opt-out path. |

## Scope

**In:** two-way commercial+transactional SMS — send hardening, DLR poll, MO inbound,
İYS/error surfacing, webhook security, onboarding docs, live smoke test.
**Out (YAGNI):** telephony stays Phase-2 click-to-dial (`NetgsmLiteAdapter`); no
multi-provider SMS selector UI (NetGSM-only); no programmable-voice NetGSM API.

## Locked decisions

- **Webhook security:** unguessable **secret path token** in the callback URL
  (`/public/channels/netgsm/<token>/mo`) + defensive **workspaceId scoping** on
  status/conversation updates. NetGSM does not sign callbacks.
- **Inbound quota:** MO replies do **not** consume the monthly *send* quota.
- **Provider:** NetGSM-only; SMS channel secrets stay `usercode/password/msgheader`.
- **Callback host:** production marketing host.

## Work breakdown

### Code — account-independent (build now, TDD)
1. **MO inbound:** `@Post(':token/mo')` resolves the SMS channel by token → fixed
   `parseInbound()` (`ceptel/mesaj/gorevid/aboneno/tarih`) → `ConversationIngressService.ingest()`. Workspace-scoped. Tests with the real payload shape.
2. **DLR poll service:** scheduled job queries `/sms/report` for recently-sent
   messages still `SENT`, maps `durumcode`+`hatakod` → `Message.status`; respects
   ≤10/min + backoff. Remove dead push `/dlr` (or keep as 410/no-op + log).
3. **Send error mapping:** translate `30/40/50/51/20/80/85` into actionable errors.
4. **Validation:** `msgheader` 3–11 chars, phone → E.164, in Create/Update DTO.
5. **Resilience:** bounded retry/backoff on transient send failures in campaign sender.
6. **Boot assert** `MARKETING_SECRET_KEY` present (fail fast).

### Panel — account owner (human)
1. Create **API sub-user** + **activate API access** (+ optional IP allowlist) → bring `usercode` + API password.
2. Load **kontör/balance**.
3. **Gönderici Adı (header)** approval (KEP docs) or use the 0850 number as header.
4. **İYS** registration (iys.org.tr) + authorize NetGSM + panel **NetİYS** (commercial).
5. **İnteraktif SMS → URL Adresine Yönlendir**: paste the MO callback URL.

### Account-dependent (after creds)
7. **Live smoke test:** send → poll report → reply MO; capture real payloads and lock
   field names/codes. Onboarding docs (`.env.example`, README, `ops/PUBLIC-ROUTES.md`).

## Testing

Unit: `parseInbound` (real fields, aliases, junk), DLR `durumcode/hatakod` mapping,
send error-code mapping, DTO validation, token/workspace scoping. Integration: MO
route → ingress. Manual: live smoke once the account is provisioned.

## Open items requiring the live account
Confirm exact approved `msgheader`; confirm 0850 supports inbound-to-URL on this
package; capture one real DLR report row and one real MO POST to lock the contract.
