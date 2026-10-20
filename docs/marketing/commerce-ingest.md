# Sending your store's orders to Jeeta

Jeeta can receive every order from your own online store — Shopify,
WooCommerce or a shop you built yourself — so that sales show up next to the
leads, campaigns and ads that brought them in. Each order becomes an
**external order** in your workspace; the buyer is matched to an existing lead
by email or phone, or added as a new lead with source **E-commerce**
(`COMMERCE`), along with the UTM / click-id attribution of the visit that led
to the purchase.

This page is the setup guide for the store side. The binding technical
contract is `docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md` §1.

> **Availability.** The endpoint is switched on per installation
> (`COMMERCE_INGEST_ENABLED`). While it is off it answers `404`; you can still
> create sources and tokens in advance. Managing sources needs the
> **API access** feature in your package and the Manager role.

---

## 1. What you need

| Thing | Where it comes from | Header |
|---|---|---|
| **Ingest token** — identifies your workspace | Minted by a Manager with `POST /api/marketing/research/tokens` `{"label":"…"}` (the same tokens the lead-ingest API uses). Shown once; starts with `mkt_live_`. | `x-ingest-token` |
| **Commerce source** — names your store, holds its signing secret | `POST /api/marketing/commerce/sources` (step 2). | `x-jeeta-source` |
| **Signing secret** — signs every request | Returned once when you create (or rotate) the source; starts with `whsec_`. | used to compute `x-jeeta-signature` |

Keep the token and the secret on your server only (environment variables or
your platform's secret store). Never put them in browser code, in a public
repository, or in a support ticket. Jeeta stores the token as a hash and the
secret encrypted; neither can be shown again.

## 2. Create a commerce source

Signed in to Jeeta as a Manager (the panel's API calls carry your session):

```bash
curl -sS -X POST https://jeetagrowth.com/api/marketing/commerce/sources \
  -H "Authorization: Bearer $JEETA_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"my-shop","kind":"CUSTOM"}'
```

```json
{ "id": "…", "slug": "my-shop", "kind": "CUSTOM", "status": "ACTIVE",
  "lastEventAt": null, "createdAt": "…", "signingSecret": "whsec_…" }
```

- `slug`: 2–40 characters of `a-z`, `0-9`, `-`. You send it as `x-jeeta-source`.
- `kind`: `SHOPIFY`, `WOOCOMMERCE` or `CUSTOM`.
- **Copy `signingSecret` now** — this is the only response that contains it.

Other calls on the same path:

| Call | Does |
|---|---|
| `GET /api/marketing/commerce/sources` | Lists your sources (never the secret). |
| `POST /api/marketing/commerce/sources/{id}/rotate` | Issues a new secret (shown once). The old one keeps working for **24 hours**, so you can deploy the new one without dropping orders. |
| `DELETE /api/marketing/commerce/sources/{id}` | Revokes the source. Its orders stay in Jeeta; new requests get `401 UNKNOWN_SOURCE`. |

## 3. Send an order event

```
POST https://jeetagrowth.com/api/marketing/commerce/ingest/orders
Content-Type: application/json
x-ingest-token:    mkt_live_…
x-jeeta-source:    my-shop
x-jeeta-timestamp: <unix seconds, now>
x-jeeta-signature: v1=<hex HMAC-SHA256>
```

### Events

| `event` | Send it when | Effect on the order |
|---|---|---|
| `order.created` | An order exists but is not paid yet (optional — skip it if orders are paid at creation) | `PENDING` |
| `order.paid` | Payment succeeded | `PAID`, paid date = `occurredAt` |
| `order.refunded` | Any refund. `order.refundedMinor` is the **cumulative** refunded total | full refund → `REFUNDED`; partial stays `PAID` |
| `order.cancelled` | The order was cancelled (send a refund separately if money went back) | `CANCELLED` |

The status only moves forward (`PENDING` → `PAID` → `REFUNDED`/`CANCELLED`). An
event that arrives late is recorded but does not move the order back, and the
refunded amount never goes down.

### Body (schema version 1)

```json
{
  "version": 1,
  "eventId": "my-shop:order.paid:1042",
  "event": "order.paid",
  "occurredAt": "2026-10-21T09:14:03.000Z",
  "order": {
    "externalId": "1042",
    "groupRef": null,
    "createdAt": "2026-10-21T09:02:11.000Z",
    "currency": "TRY",
    "amountMinor": 349900,
    "refundedMinor": 0,
    "paymentMethod": "card",
    "items": [{ "sku": "fig-15", "name": "Custom figure 15 cm", "qty": 1, "unitMinor": 349900 }]
  },
  "customer": { "email": "buyer@example.com", "phone": "+905321234567", "name": "Ayşe Yılmaz" },
  "attribution": {
    "utmSource": "instagram", "utmMedium": "paid_social", "utmCampaign": "october-gifts",
    "utmContent": null, "utmTerm": null, "fbclid": "IwAR0abc", "gclid": null, "ttclid": null,
    "landingUrl": "https://shop.example/?utm_source=instagram", "referrer": "https://l.instagram.com/"
  }
}
```

| Field | Rule |
|---|---|
| `eventId` | 1–200 chars, **unique per event within the source**. Suggested: `{source}:{event}:{orderId}[:{n}]` — e.g. a second partial refund gets `:2`. |
| `occurredAt`, `order.createdAt` | ISO-8601 UTC. `occurredAt` may be at most 5 minutes in the future. |
| `order.externalId` | 1–120 chars, your order number. One order = one `externalId`, across all its events. |
| `order.currency` | ISO-4217, capitals (`TRY`). Cannot change for an order (`422 CURRENCY_MISMATCH`). |
| `order.amountMinor`, `refundedMinor`, `items[].unitMinor` | **Integers in minor units** (kuruş, cents): ₺3.499,00 → `349900`. `refundedMinor` ≤ `amountMinor`. |
| `order.items` | Up to 100 lines; `qty` ≥ 1. |
| `customer` | Optional. Without an email or phone the order is kept as anonymous and no lead is created. |
| `attribution` | Optional; each value ≤ 512 chars. Pass what you captured on the landing visit (UTM parameters, `fbclid`/`gclid`/`ttclid`). |

Unknown fields are rejected (`400 VALIDATION_FAILED`) so that a typo never goes
unnoticed.

### Signature

```
signed  = "<x-jeeta-timestamp>.<raw body bytes>"
header  = "v1=" + hex( HMAC_SHA256(key = signing secret, signed) )
```

Sign the **exact bytes you send** — serialize the JSON once, sign that string,
and send that same string (no re-formatting, no added newline). Requests more
than 300 seconds away from Jeeta's clock are refused, so use the current time.

Node.js:

```js
import crypto from 'node:crypto';

const body = JSON.stringify(event);
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.createHmac('sha256', process.env.JEETA_SIGNING_SECRET)
  .update(`${ts}.${body}`).digest('hex');

await fetch('https://jeetagrowth.com/api/marketing/commerce/ingest/orders', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ingest-token': process.env.JEETA_INGEST_TOKEN,
    'x-jeeta-source': 'my-shop',
    'x-jeeta-timestamp': ts,
    'x-jeeta-signature': `v1=${sig}`,
  },
  body,
});
```

Shell (`body.json` holds the JSON on one line, no trailing newline):

```bash
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$(cat body.json)" | openssl dgst -sha256 -hmac "$JEETA_SIGNING_SECRET" | sed 's/^.* //')
curl -sS -w '\n%{http_code}\n' -X POST https://jeetagrowth.com/api/marketing/commerce/ingest/orders \
  -H 'Content-Type: application/json' \
  -H "x-ingest-token: $JEETA_INGEST_TOKEN" \
  -H 'x-jeeta-source: my-shop' \
  -H "x-jeeta-timestamp: $TS" \
  -H "x-jeeta-signature: v1=$SIG" \
  --data-binary @body.json
```

Always send the body from the file (`--data-binary @body.json`). Passing it as
an argument (`--data-binary "$BODY"`) works on Linux and macOS, but on Windows
(Git Bash, PowerShell) the shell re-encodes non-ASCII characters such as
`ş`, `ö`, `ü` on the way to `curl.exe`. The bytes sent then differ from the
bytes signed, and the request is rightly refused with `BAD_SIGNATURE`.

**Check your implementation against the test vector.** With secret
`whsec_3f9a1c7e5b2d4f60a8e1c9b7d5f3a1e2` (a published example, not a real key),
timestamp `1792574043` and the 818-byte body in contract §1.4, the signature
must be `7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8`.

## 4. Responses

`200` — recorded:

```json
{ "ok": true, "duplicate": false, "orderId": "…", "status": "PAID", "leadId": "…", "leadMatched": "created" }
```

- `leadMatched`: `email` / `phone` (an existing lead was found), `created` (a new
  E-commerce lead), `none` (anonymous order). It is present on the event that
  first links the order to a person; later events of the same order omit it.
- Sending the **same event again** (same `eventId`, same bytes) returns `200`
  with `"duplicate": true` and changes nothing — retries are always safe.

Errors are `{ "ok": false, "code": "…", "message": "…" }`:

| HTTP | `code` | Meaning — what to do |
|---|---|---|
| 401 | `MISSING_INGEST_TOKEN` / `INVALID_INGEST_TOKEN` | Token missing, wrong or revoked. |
| 401 | `UNKNOWN_SOURCE` | `x-jeeta-source` is not an active source of this workspace. |
| 401 | `BAD_SIGNATURE` | Signature missing or wrong — check you sign the exact bytes you send, with the current secret. |
| 401 | `STALE_TIMESTAMP` | Timestamp more than 300 s off. Check the server clock (NTP). |
| 400 | `MALFORMED_JSON` / `VALIDATION_FAILED` / `UNSUPPORTED_VERSION` | Fix the body; `details[]` lists each problem. |
| 409 | `EVENT_ID_REUSED` | This `eventId` was already used for a different body. Give each distinct event its own id. |
| 422 | `CURRENCY_MISMATCH` | The order was first reported in another currency. |
| 413 | — | Body over 256 KB. |
| 429 | `RATE_LIMITED` | Over 120 requests per minute. Retry with backoff. |
| 5xx | — | Temporary. Retry with exponential backoff. |

**Retry policy:** retry `429` and `5xx` with exponential backoff (for example
1 min, 5 min, 30 min, 2 h, 12 h). Do not retry other `4xx` — the same request
will fail the same way. Because duplicates are free, a queue that retries
until it sees `200` is the simplest correct sender.

## 5. What happens in Jeeta

- **External order** rows hold status, amounts, items, dates and the visit's
  UTM values (Lead → timeline shows "Order … paid" / "refunded").
- **Lead matching**: email first, then any spelling of the phone number
  (`+90…`, `0…`, `90…`). An existing lead is linked, never renamed or re-sourced.
- **Attribution** is first-touch: an existing lead's original source is kept.
  If `utmCampaign` equals one of your ad campaign ids, the lead is linked to
  that campaign.
- **Ad performance (ROAS)**: paid orders can be counted as revenue for the
  campaigns that brought the buyer, net of refunds and in your workspace's
  currency only. This is a separate switch (`COMMERCE_REVENUE_IN_ROAS`) because
  it changes the figures the budget autopilot acts on; it is off until your
  account owner turns it on.
- No raw request body is stored; only its SHA-256, for duplicate detection.
