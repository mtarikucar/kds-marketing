# The Jeeta site snippet (`jeeta.js`)

One line in your website's HTML lets Jeeta:

- **count page views** per day, page and traffic source (anonymous: no visitor
  id, IP address or browser details are stored), and
- **remember where each visitor came from** — UTM parameters and ad click ids
  (`fbclid`, `gclid`, `ttclid`) — in a first-party cookie for 90 days, so your
  store can attach that to the order it later reports to Jeeta.

Binding technical contract: `docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md` §7.

> **Availability.** Site tracking is switched on per installation
> (`SITE_TRACKING_ENABLED`). While it is off, the snippet still loads and its
> requests still succeed, but nothing is counted, and the key card is hidden.

---

## 1. Get your snippet

In the panel open **Account Center → Integrations → Your website → Website
snippet (jeeta.js)** (owner or manager; needs the **API access** feature).

1. Optionally give it a **label** and the **allowed hosts**: the domain names
   your pages are served from, e.g. `shop.example.com, www.shop.example.com`.
   With allowed hosts set, page views from any other site are ignored.
   Leave empty to accept any host.
2. Click **Create snippet key**. The card shows the tag to paste:

```html
<script src="https://jeetagrowth.com/jeeta.js" data-site-key="jst_…" async></script>
```

The key is not a secret (it is visible in your page source); it only says
which workspace the page views belong to. **Revoke** stops counting for that
key; views already counted stay.

## 2. Install it

Paste the tag into every page, ideally just before `</head>`. It is ~3 KB,
loads `async`, and never blocks your page.

**Cookie consent.** The snippet makes no consent decision of its own. Load it
from your consent tool (after analytics consent is given), or use
`data-consent="denied"` to count page views without setting the cookie:

```html
<script src="https://jeetagrowth.com/jeeta.js" data-site-key="jst_…" data-consent="denied" async></script>
```

**Single-page apps** (Next.js, React Router…): client-side navigations
(`history.pushState`, back/forward) are counted automatically, once per new
path. To count one by hand: `window.jeeta && window.jeeta.pv()`.

**Self-hosting** the file, or testing locally: add `data-api="https://your-jeeta-host"`
so the page views go to the right server (by default they go to the host the
script was loaded from).

## 3. The `_jeeta_attr` cookie

| | |
|---|---|
| Name | `_jeeta_attr` (first-party, on your own domain) |
| Lifetime | 90 days (`Max-Age=7776000`), `Path=/`, `SameSite=Lax`, `Secure` on https |
| Value | URL-encoded JSON, at most 1200 bytes |
| Written when | the URL carries `utm_*`, `fbclid`, `gclid` or `ttclid`, **or** another site referred the visitor (the *last meaningful touch*) |
| Not written when | a direct visit, or navigating inside your own site — the earlier source is kept |

```json
{"v":1,"utmSource":"instagram","utmMedium":"paid_social","utmCampaign":"october-gifts",
 "utmContent":null,"utmTerm":null,"fbclid":"IwAR0abc","gclid":null,"ttclid":null,
 "landingUrl":"https://shop.example/?utm_source=instagram&…","referrer":"https://l.instagram.com/","ts":1792574043000}
```

The field names are **exactly** those of the `attribution` object in the
order webhook (`docs/marketing/commerce-ingest.md`), so a store can parse the
cookie server-side and put it into its order event as it is (drop `v` and `ts`).

## 4. How page views are counted

Each page view is a 1×1 image request — no CORS, no preflight:

```
GET https://jeetagrowth.com/api/public/s/<site key>/pv.gif?p=<path>&s=<source>&m=<medium>&c=<campaign>&r=<referrer host>
→ 200 image/gif, Cache-Control: no-store
```

- **Path**: the query string is never sent. Ids in the path are replaced, so
  `/siparis/FIG-7K2M9QXA` and `/orders/12345` are counted as `/siparis/:id`
  and `/orders/:id`; readable slugs such as `/urun/custom-figure-15cm` stay.
- **Source**: `utm_source` / `utm_medium` / `utm_campaign` of the landing URL;
  else the referring site (medium `referral`); else, inside your own site, the
  source kept in the cookie; else `(direct)`.
- **Day**: your workspace's time zone.
- **Not counted**: unknown or revoked keys, hosts outside the allowed list,
  bots, crawlers and headless browsers, or when site tracking is off. The
  answer is the same 200 GIF in every case, so your page never shows a broken
  image.

## 5. Check it works

1. Open one of your pages with `?utm_source=test&utm_medium=check`.
2. In the browser's developer tools → **Network**, a request to `pv.gif`
   answers **200**; under **Application → Cookies** you see `_jeeta_attr`.
3. The counts appear in Jeeta's weekly report (site traffic section).
