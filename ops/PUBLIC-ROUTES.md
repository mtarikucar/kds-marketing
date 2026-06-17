# Public routes & the optional vanity-URL nginx config

The marketing service exposes a set of **unauthenticated public routes** for
customer-facing surfaces. They are all served under `/api/public/**` and work
out of the box behind the existing reverse proxy — **no nginx change is
required for them to function.**

| Surface | Route (works today) | Pretty vanity URL (optional) |
|---|---|---|
| Web-chat widget loader | `GET /widget.js` (SPA static) | same |
| Web-chat (public page) | `/widget?key=…` (SPA route) | same |
| Web-chat API | `POST/GET /api/public/webchat/:widgetKey/*` | — |
| Meta webhook (WA/IG/Messenger) | `GET/POST /api/public/channels/meta/webhook` | — |
| NetGSM inbound SMS (MO reply) | `POST /api/public/channels/netgsm/:channelId/:token/mo` | — |
| NetGSM DLR push (deprecated no-op) | `POST /api/public/channels/netgsm/dlr` | — |
| Campaign open pixel | `GET /api/public/t/o/:token` | `/t/o/:token` |
| Campaign click | `GET /api/public/t/c/:token?i=N` | `/t/c/:token` |
| Campaign unsubscribe | `GET /api/public/u/:token` | `/u/:token` |
| Funnel page render | `GET /api/public/p/:ws/:slug` | `/p/:ws/:slug` |
| Form submit | `POST /api/public/f/:formId` | `/f/:formId` |
| Booking page / slots / reserve | `GET/POST /api/public/book/:ws/:cal[...]` | `/book/:ws/:cal` |

## NetGSM SMS (two-way) — delivery is polled, inbound is pushed

NetGSM's API is asymmetric, so the two directions are handled differently:

- **Delivery reports (DLR): POLLED, not pushed.** `NetgsmDlrPollService` queries
  `GET https://api.netgsm.com.tr/sms/report` once a minute (advisory-locked,
  single-replica, ≤10 reports/tick per NetGSM's rate limit) for recently-sent
  SMS still in `SENT` and applies the mapped status. The legacy
  `POST …/netgsm/dlr` push route is a **logged no-op** that performs no writes —
  it is retained only so a stray/misconfigured POST neither errors nor
  retry-storms. (It previously updated message status by a guessable job id with
  no auth or workspace scope; that cross-tenant vector is removed.)
- **Inbound MO replies: PUSHED to a tokenized URL.** NetGSM does not sign
  callbacks, so the MO URL embeds the `channelId` plus an HMAC `token`
  (`HMAC-SHA256(MARKETING_SECRET_KEY, "netgsm-mo:<channelId>")`) — only someone
  holding the master key can mint a valid URL, so it is unforgeable.

**Onboarding the operator:** the exact URL to paste into the NetGSM panel
(**İnteraktif SMS → "URL Adresine Yönlendir"**) is returned as the `callbackUrl`
field on the SMS channel's API view (`GET /marketing/channels/:id`). It is null
until both `MARKETING_SECRET_KEY` and `PUBLIC_BASE_URL` are set. Inbound MO
replies do **not** consume the monthly outbound message quota.

## Optional: prettier customer-facing URLs

For nicer shareable/SEO URLs on the campaign + funnel surfaces (e.g.
`https://marketing.hummytummy.com/p/<ws>/<slug>` instead of the `/api/public/…`
form), add a **one-time** location block to the marketing vhost that proxies
the vanity prefixes to the API container (port 3211), and serves `/widget.js`
from the panel (3210):

```nginx
# Pretty public funnel / tracking routes → API container
location ~ ^/(p|f|book|t|u)(/|$) {
    proxy_pass http://127.0.0.1:3211;   # marketing API
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Web-chat embed loader → panel (SPA static)
location = /widget.js {
    proxy_pass http://127.0.0.1:3210;
}
```

If you add this, also set `PUBLIC_BASE_URL` and the rendered links will use the
vanity form — but the backend handlers are mounted under `/api/public/**`
regardless, so the rewrite must map `/p/...` → `/api/public/p/...`. The simplest
zero-rewrite option is to keep `PUBLIC_BASE_URL` pointing at the `/api/public`
paths (the default the code emits today). Apply the vanity block only when you
want the shorter URLs; it is **not** required for any feature to work.
