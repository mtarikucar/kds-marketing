# KDS Marketing — multi-tenant AI lead-generation platform

A standalone, product-agnostic SaaS (originally extracted from the
Restaurant POS monorepo, then generalized): customer **workspaces** sign up,
describe WHO they sell to (research profiles), and a nightly Claude research
routine fills their pipeline with evidence-backed leads — metered by a daily
quota that their **package** (TRIAL/STARTER/GROWTH/SCALE + boosts) decides.
On top sits the full sales workbench: lead pipeline, activities, tasks,
offers, commissions, click-to-call, installation ops, sales targets.

Three realms, three credentials:
- **Workspace users** (OWNER ⊃ MANAGER ⊃ REP) — JWT with a `wsp` claim;
  every query is workspace-scoped (enforced by an architecture-fitness test)
- **Platform operators** (`/platform/*`) — separate JWT realm; workspace
  administration + manual bank-transfer approvals
- **Machine principals** — per-workspace ingest tokens (sha256 at rest),
  the research routine's `RESEARCH_ROUTINE_TOKEN`, core's
  `INTERNAL_SERVICE_TOKEN`

Payments: PayTR (TRY, iframe) · Stripe (USD, redirect) · manual bank
transfer (operator-approved) — all settling through one idempotent path.

Ops docs: `ops/CUTOVER.md` (monorepo → standalone switch),
`ops/research-routine-prompt.md` (the routine's canonical prompt).

```
kds-marketing/
├── backend/            NestJS service (port 3100 on the host; core owns 3000. Global prefix /api)
├── frontend/           React + Vite panel (workspace console at /, platform console at /platform)
├── ops/                cutover runbook + routine prompt
└── docker-compose.yml  postgres + backend + frontend
```

## Architecture

The marketing context was decoupled in phases 1–4 (ports, outbox events, soft references, independent auth); this repo is the mechanical split. **No business logic changed** — only transport wiring:

### Database

`prisma/schema.prisma` contains ONLY the marketing-owned tables:

```
marketing_users, leads, lead_activities, marketing_tasks, lead_offers,
commissions, marketing_notifications, marketing_distribution_config,
sales_calls, installation_crews, installation_jobs, installation_tasks,
sales_targets               + outbox_events (durable eventing)
```

Cross-context links are **soft references with snapshots** (no FK, no join needed): `leads.convertedTenantId`, `commissions.tenantId`/`sourcePaymentId`, `lead_offers.planId` (+ `planCode/planName/planMonthlyPrice/planCurrency`). A single init migration lives in `backend/prisma/migrations/0_init/` (includes the raw-SQL partial-unique on `commissions(sourcePaymentId, type)` for exactly-once commission credits).

### Integration with core (over HTTP)

The canonical wire contract lives in the vendored shared-kernel files `backend/src/core-contracts/{internal-http.contract,provisioning/http-contract,referral/http-contract}.ts` — byte-identical to core's copies under `backend/src/core-contracts/`. Both sides import the route constants and envelope types from there; nothing is inlined.

All service-to-service calls carry the shared `x-internal-token: ${INTERNAL_SERVICE_TOKEN}` header. **Every route is POST with a JSON body and answers 200 (202 for events) with a JSON envelope** — never an empty body; a 404 from these routes always means "wrong URL", never "no result".

| Direction | Endpoint | Request body | 200 response |
| --- | --- | --- | --- |
| marketing → core | `POST ${CORE_SERVICE_URL}/api/internal/provisioning/provision-tenant-for-lead` | `ProvisionTenantForLeadCommand` | `ProvisionTenantForLeadResult` — lead → tenant conversion (idempotent on `leadId`) |
| marketing → core | `POST ${CORE_SERVICE_URL}/api/internal/provisioning/list-provisioned-leads` | `{ createdAfter, createdBefore }` (ISO-8601 strings) | `{ leads: ProvisionedLeadRecord[] }` — orphan-reconciliation sweep |
| marketing → core | `POST ${CORE_SERVICE_URL}/api/internal/provisioning/describe-plan` | `{ planId }` | `{ plan: PlanSnapshot \| null }` — `null` for an unknown plan (always 200) |
| core → marketing | `POST /api/internal/referral/resolve` | `{ code }` | `{ resolved: { marketingUserId, referralCode } \| null }` — never an error for a bad code |
| core → marketing | `POST /api/internal/events` | `{ type, payload, idempotencyKey?, tenantId? }` | 202 `{ id }` — core relays `payment.succeeded.v1` (forwarding the producer's `idempotencyKey`/`tenantId`); appended to the local outbox, drained onto the in-process `DomainEventBus`, consumed by `SettlementCommissionConsumer` unchanged |

**Error contract** (core's provisioning endpoints → marketing): non-2xx with body `{ code, message, ... }`. `HttpCoreProvisioningClient` maps `code` back onto the port-local error classes:

| `code` | HTTP status (core side) | Mapped error |
| --- | --- | --- |
| `EMAIL_IN_USE` | 409 | `CoreProvisioningEmailInUseError` |
| `PLAN_INVALID` | 422 | `CoreProvisioningPlanInvalidError` |
| `SUBDOMAIN_UNAVAILABLE` | 409 | `CoreProvisioningSubdomainError` |
| anything else | 5xx | `CoreProvisioningError` |

`marketing.lead.converted.v1` stays fully in-process (producer `MarketingLeadsService` and consumer `InstallationConsumer` both live here, over the local outbox → bus path).

### Route surface (unchanged from the monorepo)

The backend keeps the global `api` prefix and every existing route — `/api/marketing/auth/*`, `/api/marketing/leads/*` (incl. `POST /api/marketing/leads/ingest` guarded by `x-ingest-token`), `/api/marketing/tasks`, `/api/marketing/offers`, `/api/marketing/commissions`, `/api/marketing/reports/*`, `/api/marketing/users`, `/api/marketing/notifications`, `/api/marketing/distribution-config`, `/api/marketing/calls/*`, `/api/marketing/installations/*`, `/api/marketing/sales-targets/*` — so the panel works as-is.

The frontend exposes the same routes as the source app (`/marketing/login`, `/marketing/dashboard`, `/marketing/leads[...]`, `/marketing/tasks`, `/marketing/calendar`, `/marketing/offers`, `/marketing/reports`, `/marketing/commissions`, `/marketing/users` for managers), with `/` redirecting to `/marketing/dashboard`.

## Quick start (Docker)

```bash
docker compose up --build
# panel    → http://localhost:5173
# API      → http://localhost:3100/api  (host port 3100 — core's backend owns 3000)
# postgres → localhost:5433 (db: marketing)
```

Override secrets and `CORE_SERVICE_URL` with an `.env` file next to `docker-compose.yml` (see the `${VAR:-default}` entries inside).

## Local development

### Backend

```bash
cd backend
cp .env.example .env          # fill in DATABASE_URL + secrets (PORT=3100)
npm install
npx prisma generate
npx prisma migrate deploy     # apply 0_init to your marketing DB
npm run start:dev             # http://localhost:3100/api
npm test                      # unit: 56 suites / 419 tests
npm run test:e2e              # e2e: full-app HTTP pipeline (mocked Prisma seam)
# health probes: GET /api/health (liveness) · GET /api/health/ready (readiness)
# architecture conformance audit + backlog: docs/ARCHITECTURE-CONFORMANCE.md
```

### Frontend

```bash
cd frontend
cp .env.example .env          # VITE_API_URL=http://localhost:3100/api
npm install
npm run dev                   # http://localhost:5173
npm run build                 # tsc + vite build
```

## Environment variables (backend)

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (marketing DB) |
| `PORT` | no (3000) | HTTP port — convention is 3100 on the host (docker publishes 3100→3000; `.env.example` sets 3100) so core can keep 3000 |
| `CORS_ORIGIN` | prod | Comma-separated allowed frontend origins |
| `MARKETING_JWT_SECRET` / `MARKETING_JWT_REFRESH_SECRET` | yes | Marketing auth realm; ≥ 32 chars, must differ from each other (and from core realms if mirrored) |
| `PLATFORM_JWT_SECRET` | yes | Platform (superadmin) realm JWT secret |
| `INTERNAL_SERVICE_TOKEN` | yes | Shared service token for `/api/internal/*` in both directions (`x-internal-token`); must match core's value |
| `RESEARCH_ROUTINE_TOKEN` | yes | Token for the nightly research routine surface (`/api/internal/research/*`, `x-research-token`) — separate principal from `INTERNAL_SERVICE_TOKEN`. (Lead ingest itself uses per-workspace tokens minted in the panel — no env.) |
| `ROUTINE_TOKEN` | no | Token for the nightly cloud-routine surface (`/api/internal/reviews/*`, `x-routine-token`) — separate principal from `RESEARCH_ROUTINE_TOKEN`. Guard fails closed when unset (routine endpoints 401). |
| `ROUTINE_REVIEW_DAILY_CAP` | no | Per-workspace nightly cap on reviews the review-draft routine drafts (default 50). |
| `REDIS_URL` | prod (≥2 replicas) | Distributed rate-limit store; unset → per-replica in-memory buckets (dilutes the global limit under >1 replica). `rediss://` for TLS, embed auth in the URL |
| `CORE_SERVICE_URL` | yes | Base URL of the core service, no trailing slash — core's compose publishes its backend on host port 3000, e.g. `http://host.docker.internal:3000` |
| `MARKETING_SECRET_KEY` | when sealing secrets | AES-256-GCM master key (base64 32 bytes) sealing per-workspace channel/PSP secrets; format-validated at boot if set |
| `LOG_FORMAT` | no | `json` (default in prod, X-Request-ID correlated) or `pretty` (default in a dev TTY) |
| `METRICS_SCRAPE_TOKEN` | recommended in prod | Bearer token gating `GET /api/metrics`; also restrict that path at the edge |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_FROM` / `APP_NAME` / `FRONTEND_URL` | no | SMTP for the tenant-welcome email; unset → mock mode (emails logged, not sent) |
| `NETGSM_SALES_LINE` | no | Informational sales line for click-to-dial health checks |
| `OUTBOX_RETENTION_DAYS` | no (14) | Retention for dispatched outbox rows |
| `TRUST_PROXY` | no (1) | Express trust-proxy hops |

Ops endpoints (unauthenticated except `/api/metrics` when `METRICS_SCRAPE_TOKEN` is set): `GET /api/health` (liveness), `GET /api/health/ready` (readiness, 503 when the DB is down), `GET /api/metrics` (Prometheus).

Frontend: `VITE_API_URL` (e.g. `http://localhost:3100/api`) — baked in at build time.

## What core must provide (counterpart wiring)

1. Expose `POST /api/internal/provisioning/{provision-tenant-for-lead, list-provisioned-leads, describe-plan}` wrapping its `TenantProvisioningService`, guarded by the same `INTERNAL_SERVICE_TOKEN`, returning the envelopes and the `{ code, message }` error contract above (route constants: `core-contracts/provisioning/http-contract.ts`).
2. Replace its in-process `ReferralDirectoryService` binding with an HTTP client calling this service's `POST /api/internal/referral/resolve` and unwrapping the `{ resolved }` envelope.
3. Relay its outbox `payment.succeeded.v1` rows to `POST /api/internal/events`, forwarding the row's `idempotencyKey` and `tenantId` (at-least-once; consumers here dedupe on `sourcePaymentId`).
