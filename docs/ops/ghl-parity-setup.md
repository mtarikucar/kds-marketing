# GHL-Parity Program — Operator Setup & Go-Live Checklist

This document covers every env-gated integration introduced by the GHL-parity
program, what unlocks when you set each secret, where to obtain credentials, and
what is already live without any extra configuration.

---

## 1. What Works With No Extra Setup

The following capabilities are fully operational the moment the base stack is
deployed (they need no new env vars beyond the ones already in `.env.example`):

| Capability | Notes |
|---|---|
| Custom fields, tags, segments | CRM config — no extra env |
| CSV lead import wizard | Upload, map, dedupe, commit pipeline |
| Memberships (courses, enrollment, communities) | No external dependency |
| Affiliate manager | Referrals, commissions, payout tracking |
| Custom roles & RBAC | Per-workspace permission sets |
| 2FA enforcement | TOTP/email OTP; uses existing email stack |
| Compliance log | Immutable audit trail |
| IVR / phone-tree builder | Configures the existing Twilio voice flow; needs `TWILIO_*` which were already required |
| A/B testing & surveys | Internal feature flags + survey engine |
| Analytics dashboards | Funnel, source/business-type, rep performance |
| Multi-touch attribution | First/last/linear conversion value (internal) |
| Agency sub-account hierarchy | Parent/child workspace structure |
| Config snapshots | Capture + clone workspace config |
| Workflow DSL | Trigger-action automation engine |
| AI (conversation, content, voice, Agent Studio) | Already gated on `ANTHROPIC_API_KEY` |

---

## 2. Env-Gated Integrations — Setup Table

Each integration is **completely inert** (returns `400 "not configured"` or is
hidden in the UI) until **all** required vars for that integration are set.
No integration failure can crash the application.

### 2a. Shared prerequisite — `MARKETING_SECRET_KEY`

Every integration that stores OAuth tokens (Google Calendar, Social Planner,
SSO) seals them with AES-256-GCM using this key.

| Var | Purpose | How to generate |
|---|---|---|
| `MARKETING_SECRET_KEY` | AES-256-GCM master key that seals all stored integration tokens | `openssl rand -base64 32` |

This var is already present in `.env.example` (and in the deploy render). If it
is unset, Google Calendar and Social Planner connections will refuse to store
tokens. Set it first.

---

### 2b. SSO / OIDC

Unlocks per-workspace OIDC sign-in (authorization-code + PKCE flow, JIT user
provisioning). The IdP app (client ID, discovery URL) is configured **in-app**
by the workspace admin — no env is needed for the IdP side.

| Var | Required? | Purpose | Where to obtain |
|---|---|---|---|
| `MARKETING_PUBLIC_URL` | Recommended | Shared base URL used to derive the redirect URI (`<base>/api/marketing/auth/sso/callback`) | Your own deployment URL |
| `SSO_REDIRECT_URI` | Optional | Override the exact redirect URI if it differs from the auto-derived one | Your own deployment URL |

**What unlocks:** the SSO settings panel, "Connect IdP" flow, and OIDC callback
endpoint. Without at least `MARKETING_PUBLIC_URL`, the redirect URI falls back
to `http://localhost:3000/api/marketing/auth/sso/callback`, which will not work
in production.

**GitHub Actions / deploy render secrets to add:** none additional — these are
plain URLs, not secrets. Add `MARKETING_PUBLIC_URL` (and optionally
`SSO_REDIRECT_URI`) directly to the deploy render section in `deploy.yml` if
they should be injected at deploy time, or set them on the server's `.env.shared`.

---

### 2c. Google Calendar 2-way Sync

Unlocks OAuth connect + 2-way event sync per workspace. Requires
`MARKETING_SECRET_KEY` (tokens are sealed at rest).

| Var | Required? | Purpose | Where to obtain |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Yes | OAuth 2.0 client ID | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth 2.0 Client IDs |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Yes | OAuth 2.0 client secret | Same as above |
| `GOOGLE_OAUTH_REDIRECT_URI` | Optional | Exact redirect URI if it differs from `<MARKETING_PUBLIC_URL>/api/marketing/integrations/google-calendar/callback` | Your own deployment URL |

**Setup steps:**

1. Create a project in Google Cloud Console and enable the **Google Calendar API**.
2. Create an OAuth 2.0 Web Application credential.
3. Add the authorized redirect URI:
   `https://<your-domain>/api/marketing/integrations/google-calendar/callback`
4. Copy the Client ID and Client Secret into the env.
5. Set `MARKETING_SECRET_KEY` (if not already set).

**What unlocks:** the "Google Calendar" card in Integrations settings, per-user
OAuth connect, and the background sync job.

**GitHub Actions / deploy render secrets to add:**
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

Add them to the `Render .env.production` step env block and the rendered `.env`
heredoc in `deploy.yml` when ready to go live. `GOOGLE_OAUTH_REDIRECT_URI` is
optional and only needed if the auto-derived URI is wrong.

---

### 2d. Social Planner (Facebook, Instagram, LinkedIn)

Unlocks scheduled multi-network social publishing. Access tokens are connected
per-workspace via the Social Planner settings UI and sealed with
`MARKETING_SECRET_KEY`.

#### Meta (Facebook + Instagram)

| Var | Required? | Purpose | Where to obtain |
|---|---|---|---|
| `META_APP_ID` | Yes | Facebook/Instagram Graph API app ID | [Meta for Developers](https://developers.facebook.com) → Your Apps |
| `META_APP_SECRET` | Yes | App secret (also used for webhook HMAC) | Same — already in `.env.example` |
| `META_WEBHOOK_VERIFY_TOKEN` | Yes | Static token for webhook verification challenge | Choose any secret string; configure the same value in Meta's webhook settings |

Note: `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` were already present in
`.env.example`. `META_APP_ID` is the additional var the social planner gate
checks.

**What unlocks:** Facebook and Instagram publish targets in the Social Planner.
When either `META_APP_ID` or `META_APP_SECRET` is absent, those networks show
"not configured" and publishing attempts return an error.

**GitHub Actions / deploy render secrets to add:**
- `META_APP_ID`
- `META_APP_SECRET` (already in deploy render — verify it is present)
- `META_WEBHOOK_VERIFY_TOKEN` (already in deploy render — verify it is present)

#### LinkedIn

| Var | Required? | Purpose | Where to obtain |
|---|---|---|---|
| `LINKEDIN_CLIENT_ID` | Yes | LinkedIn OAuth app client ID | [LinkedIn Developers](https://www.linkedin.com/developers/apps) → Create App |
| `LINKEDIN_CLIENT_SECRET` | Yes | LinkedIn OAuth app client secret | Same |

**What unlocks:** LinkedIn publish target in the Social Planner. When either var
is absent, LinkedIn shows "not configured".

**GitHub Actions / deploy render secrets to add:**
- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`

---

### 2e. Agency Rebilling (Stripe Connect)

Unlocks live per-location Stripe Connect settlement (agency charges its
sub-account locations). Requires the base `STRIPE_SECRET_KEY` which is already
in the deploy render.

| Var | Required? | Purpose | Where to obtain |
|---|---|---|---|
| `STRIPE_CONNECT_CLIENT_ID` | Yes (for live charges) | Stripe Connect platform client ID | [Stripe Dashboard](https://dashboard.stripe.com) → Connect → Settings |
| `STRIPE_SECRET_KEY` | Yes | Already present; also used here | Stripe Dashboard → API Keys |
| Per-location connected account ID | Yes | Stored in `WorkspacePspConfig.configPublic.connectAccountId` for each location | Set in the agency console after connecting each sub-account |

**What unlocks:** live outbound Stripe Connect charges from agency to locations.
When `STRIPE_CONNECT_CLIENT_ID` is unset, rebilling still **records** internal
settlement (draft charges / owed amounts in the DB) but performs **no live
charge** — no crash, no data loss.

**GitHub Actions / deploy render secrets to add:**
- `STRIPE_CONNECT_CLIENT_ID`

---

## 3. Deploy & CI Notes

This branch (`feat/ghl-parity`) merges to `main` via PR + CI. A `v*.*.*` tag
triggers the existing `deploy.yml` which renders `.env.production` from GitHub
Actions secrets and deploys to the production server.

**All env-gated integrations remain inert in production until their secrets are
added to GitHub Actions.** The deploy does not fail if they are absent — the
app boots normally and the features show "not configured" in the UI.

### Secrets to add in GitHub Actions (Settings → Secrets → Actions)

The following secrets are **not currently in the deploy render** and must be
added both to GitHub Actions secrets AND to the `Render .env.production` env
block + rendered heredoc in `deploy.yml` before each integration can go live
in production:

| Secret name | Integration | Priority |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google Calendar | When enabling GCal |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Calendar | When enabling GCal |
| `META_APP_ID` | Social Planner (Facebook/Instagram) | When enabling social planner |
| `LINKEDIN_CLIENT_ID` | Social Planner (LinkedIn) | When enabling social planner |
| `LINKEDIN_CLIENT_SECRET` | Social Planner (LinkedIn) | When enabling social planner |
| `STRIPE_CONNECT_CLIENT_ID` | Agency rebilling (live charges) | When enabling rebilling |

The following secrets are **already in the deploy render** — verify they are
populated in GitHub Actions secrets:

| Secret name | Integration |
|---|---|
| `MARKETING_SECRET_KEY` | Required by GCal + Social Planner token sealing |
| `META_APP_SECRET` | Social Planner + webhook HMAC |
| `META_WEBHOOK_VERIFY_TOKEN` | Meta webhook challenge |
| `STRIPE_SECRET_KEY` | Stripe billing + Connect settlement |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook validation |

### Single-replica OAuth caveat

Both SSO and Google Calendar use an **in-memory** state map for the OAuth
round-trip (state token → pending connect record, 10-minute TTL). This means
the `/connect-start` and the `/callback` requests must land on the **same
replica**. If you run multiple backend replicas behind a load balancer, ensure
session affinity (sticky sessions) is configured for the OAuth callback paths,
or migrate the state store to Redis.

---

## 4. Recommended Follow-Up: Playwright E2E Coverage

The test suite currently has backend unit + e2e tests and frontend component
tests (all green on this branch). Playwright end-to-end coverage of the **new
UI flows** introduced by the GHL-parity program is a recommended follow-up:

- SSO IdP connect flow (mock OIDC provider)
- Google Calendar OAuth connect + event display
- Social Planner compose + schedule + publish (mock Graph API)
- Agency rebilling plan assignment + usage meter
- CSV import wizard (upload → map → commit)
- Membership course creation + enrollment

These flows touch backend + frontend + external OAuth redirects and benefit from
full-stack e2e coverage that component tests cannot provide.
