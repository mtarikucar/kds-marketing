# Connecting Google Analytics 4

Jeeta can read your Google Analytics 4 property once a day — sessions, users,
traffic sources, campaigns, key events and purchases — so the weekly report
shows site traffic next to your content, ads and orders. Access is
**read-only** (`analytics.readonly`); Jeeta never changes anything in GA4.

Binding technical contract: `docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md` §6.

> **Availability.** GA4 is switched on per installation (`GA4_SYNC_ENABLED`).
> While it is off, the card does not appear in the panel and the GA4 routes
> answer `404`.

---

## 1. Connect (workspace owner or manager)

1. In the panel open **Account Center → Integrations**. Under **Your website**
   find the **Google Analytics 4** card.
2. Click **Connect Google Analytics**. Google asks you to sign in and to allow
   *"See and download your Google Analytics data"*. Use the Google account
   that can see your GA4 property, and approve every prompt.
3. You are sent back to the Integrations tab. Choose your **GA4 property**
   from the list and click **Save property**.
4. The first sync pulls the **last 35 days** within the hour. After that the
   data is refreshed once a day. Each run re-pulls the last 3 days, because
   GA4 keeps processing recent days for a while.

The card then shows the property and **Last synced**. **Sync now** pulls
immediately. **Disconnect** deletes the stored Google tokens and stops syncing;
days already pulled stay in your reports.

If the card says *"Google access was revoked or expired"*, someone removed
Jeeta's access in the Google account (or the password changed). Click
**Reconnect** and approve again; syncing resumes on the next run.

## 2. What is read

For every day, three breakdowns, from the GA4 Data API:

| Breakdown | Key | Metrics |
|---|---|---|
| `TOTAL` | — | sessions, total users, new users, key events, purchases, purchase revenue |
| `SOURCE_MEDIUM` | e.g. `instagram / paid_social` | same |
| `CAMPAIGN` | campaign name | same |

Source/medium and campaign keep the **top 50 per day** by sessions; the rest is
summed into one `(other)` row. Purchase revenue is stored in the property's
currency. Days are the property's own calendar days (its time zone in GA4).

GA4 metric names: `sessions`, `totalUsers`, `newUsers`, `keyEvents`,
`ecommercePurchases`, `purchaseRevenue`. Purchases and revenue only appear if
your site sends GA4 `purchase` events.

## 3. For the operator (one-time server setup)

GA4 uses the same Google OAuth client as Google Calendar and Business Profile.

| What | Where |
|---|---|
| OAuth client id / secret | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) |
| Token encryption | `MARKETING_SECRET_KEY` (tokens are stored encrypted; without it GA4 stays off) |
| Panel base URL | `MARKETING_PUBLIC_URL` (the callback and the return to the panel are built from it) |
| Switch | `GA4_SYNC_ENABLED=true` |
| Optional | `GA4_OAUTH_REDIRECT_URI` overrides the callback URL |

In Google Cloud Console, for that OAuth client:

1. **APIs & Services → Library**: enable **Google Analytics Data API** and
   **Google Analytics Admin API**.
2. **Credentials → OAuth client → Authorized redirect URIs**: add
   `https://jeetagrowth.com/api/marketing/integrations/ga4/callback`
   (your `MARKETING_PUBLIC_URL` + that path).
3. **OAuth consent screen → Data access**: add the scope
   `https://www.googleapis.com/auth/analytics.readonly`. It is a *sensitive*
   scope: until Google verifies the app, only accounts listed as **test users**
   can connect, so add the GA4 owner's Google account there first.

Nothing else is installed: Jeeta calls Google's REST endpoints directly.

## 4. Troubleshooting

| Message after Connect | Cause — fix |
|---|---|
| *Google rejected the redirect URI (redirect_uri_mismatch)* | Register the exact callback URL above in the OAuth client. |
| *Google rejected the OAuth client (invalid_client)* | Client id and secret are not from the same OAuth client. |
| *Access to Google Analytics was not granted* | The consent was cancelled, or the account is not a test user yet. |
| *Google did not grant offline access* | Reconnect and approve every prompt (Jeeta needs a refresh token). |
| *The connection link expired* | The consent took more than 10 minutes; click Connect again. |
| Property list is empty | The Google account has no GA4 property it can read; connect with the account that owns it. |
| *Last synced* never moves | Check the card's error line. `GA4 Data API 403` usually means the Data API is not enabled in Google Cloud. |

## 5. Privacy

Only aggregated daily numbers are stored — no visitor-level data. The Google
access and refresh tokens are encrypted at rest and never returned by any API.
Disconnecting deletes them.
