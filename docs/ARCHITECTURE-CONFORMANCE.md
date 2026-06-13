# Architecture Conformance Audit — KDS Marketing

> Scope: the standalone marketing service (`backend/` NestJS + `frontend/`
> React). This document scores the codebase against the target quality
> attributes, cites the evidence in-tree, and tracks the hardening backlog.
> It is a **living document** — update the status column when a gap closes.
>
> Last reviewed: 2026-06-13 · Baseline: 65 unit suites / 456 tests + 10 e2e
> suites / 53 tests (+ an opt-in real-DB lifecycle suite, 5 tests), all green.

## How to read this

Each quality gets a status:

- **Strong** — first-class in the codebase, enforced (often by a test).
- **Partial** — present but incomplete or not uniformly applied.
- **Gap** — absent; tracked in the backlog below.

The goal is not a green wall of checkmarks for its own sake — it is an honest
map so the next change knows where the load-bearing walls are and where the
holes are.

---

## 1. Quality attribute scorecard

| # | Quality | Status | Evidence / Notes |
|---|---------|--------|------------------|
| 1 | **Reusability** | Strong | Adapter registries (`channel-adapter.registry.ts`, `telephony-provider.registry.ts`), shared `common/` helpers (crypto, pagination, transforms, PII mask), port interfaces in `core-contracts/`. |
| 2 | **Maintainability** | Strong | Bounded-context module layout, dense intent-comments, consistent NestJS idioms, `nest build` clean. |
| 3 | **Scalability — vertical** | Strong | Stateless request handlers; Prisma connection pooling; `--maxWorkers` tuned. |
| 3 | **Scalability — horizontal** | Strong | Stateless + replica-safe; the rate limiter now uses a Redis `ThrottlerStorage` (global bucket across replicas) when `REDIS_URL` is set, falling back to in-memory otherwise. Outbox claim is `FOR UPDATE SKIP LOCKED` (multi-worker safe). |
| 4 | **Modularity** | Strong | One Nest module per context (`marketing`, `billing`, `platform`, `internal`, `outbox`, `health`); cross-module access only via `@Global` providers + ports. |
| 5 | **Separation of Concerns** | Strong | Controllers→services→Prisma; transport in `core-client`, contracts in `core-contracts`, ACL in `marketing/acl`. HTTP wiring isolated in `app.config.ts`. |
| 6 | **Single Source of Truth** | Strong | Wire contracts vendored byte-identical in `core-contracts/`; HTTP bootstrap unified in `app.config.ts` (shared by `main.ts` + e2e harness). |
| 7 | **Extensibility** | Strong | Registry + adapter pattern for channels/telephony/PSPs; new event consumers subscribe to the `DomainEventBus` without touching producers. |
| 8 | **Testability** | Strong | 414 unit tests + **new** e2e harness (`test/`) booting the real app via `configureApp` with a mocked DB seam; arch-fitness + tripwire tests. |
| 9 | **Reliability** | Strong | Idempotent settlement, durable outbox with retry/DLQ, fail-fast env validation, **new** readiness probe drains unhealthy replicas. |
| 10 | **Idempotency** | Strong | Settlement two-phase flip, commission `sourcePaymentId` partial-unique, lead-convert keyed on `leadId`, ingest dedupe on `externalRef`, outbox `idempotencyKey`. |
| 11 | **Observability** | Strong | Structured JSON logger with the `X-Request-ID` threaded into every line via AsyncLocalStorage; `/api/metrics` Prometheus endpoint (request count/latency); `X-Request-ID` correlation middleware; health/readiness probes. |
| 12 | **Security** | Strong | Three isolated JWT realms, role hierarchy guard, per-workspace ingest tokens (sha256 at rest), AES-256-GCM secret box, helmet CSP, CORS allowlist, timing-safe token compare, throttling, prod query-log suppression. |
| 13 | **Performance** | Strong | Tight body limits, indexed scoped reads, entitlements cache, `SKIP LOCKED` outbox. |
| 14 | **Fault Tolerance** | Strong | Liveness≠readiness split, transport-neutral core errors, outbox retry/backoff, settlement no-ops on replay. |
| 15 | **Data Consistency** | Strong | Serializable settlement guard, partial-unique indexes, soft-reference snapshots avoid cross-context FK skew. |
| 16 | **Backward Compatibility** | Strong | `api` global prefix + every legacy route preserved (README §Route surface); versioned event names (`*.v1`). |
| 17 | **Clean Architecture** | Strong | Ports/adapters at the context boundary; domain errors decoupled from Nest exceptions. |
| 18 | **SOLID** | Strong | DI throughout; interface-segregated ports; registries enable open/closed extension. |
| 19 | **DRY** | Strong | Shared helpers + the `app.config.ts` unification removed the main/e2e bootstrap duplication. |
| 20 | **KISS** | Strong | Heuristic arch tests over heavyweight frameworks; offset pagination over premature cursoring. |
| 21 | **YAGNI** | Strong | AI surfaces gated/kill-switched; no speculative abstractions. |
| 22 | **Configurability** | Strong | All secrets/URLs via env + `ConfigModule`; boot-time validation in `main.ts`. |
| 23 | **Portability** | Strong | Dockerfile + compose (dev/prod); no host-specific assumptions. |
| 24 | **Deployability** | Strong | `migrate deploy` on boot, shutdown hooks, **new** k8s-style probes for rollout gating. |
| 25 | **Resilience** | Strong | See Fault Tolerance + readiness draining + throttle. |
| 26 | **Naming Consistency** | Strong | `marketing-*`, `*.service`, `*.controller`, `*.guard`, `*.consumer`, `*.adapter` conventions held across 270 files. |
| 27 | **Documentation** | Strong | Excellent README + in-code rationale + this audit + generated OpenAPI/Swagger at `/api/docs`. |
| 28 | **Monitoring & Alerting** | Strong | Health endpoints + structured logs + `/api/metrics` (Prometheus request count/latency histogram) enabling SLO/burn-rate alerts. |
| 29 | **Auditability** | Strong | Dedicated append-only `audit_log` table + `@Audit()` interceptor on material state changes (workspace/lead status, payment + commission approvals), each row carrying actor/resource/requestId/outcome; plus the prior implicit audit data. |
| 30 | **Multi-Tenancy Safety** | Strong | `workspace-scoping.arch.spec.ts` statically forbids unscoped multi-row/create queries; `wsp` claim verified against the live user row; SYSTEM sentinel can't authenticate. |

---

## 2. Per-module conformance

| Module | Auth/realm | Tenant scoping | Idempotency | Observability | Tests | Notes |
|--------|-----------|----------------|-------------|---------------|-------|-------|
| `marketing` | Marketing JWT + roles | Enforced (arch test) | Lead/offer/commission | Logger; req-id | Unit + arch + e2e (auth/authz) | Largest context; 38 controllers. |
| `billing` | PSP signatures | `order.workspaceId` | Settlement two-phase | Logger | Unit (settlement, providers, webhooks) | Production-hardened settlement. |
| `platform` | Platform JWT realm | Cross-workspace by design | Reuses settlement | Logger | e2e (realm isolation) — unit gap | → backlog #4. |
| `internal` | Service/research tokens | tenantId on events | Outbox key forwarded | thin | **new** e2e (contracts) | Wire contract now locked by e2e. |
| `outbox` | n/a (internal) | tenantId column | Dedupe key + SKIP LOCKED | Logger warnings | Indirect — unit gap | → backlog #7. |
| `health` | Public | n/a | n/a | Probes + no-store | **new** e2e | Added this session. |
| `common` | n/a | n/a | n/a | n/a | Unit (crypto/transforms/pii/email) + **new** req-id | — |
| `core-client` / `core-contracts` | service token | n/a | provision keyed on leadId | n/a | Unit (http client) | Transport-neutral errors. |

---

## 3. Hardening delivered this session (Phase 2/3, first slice)

1. **Liveness + readiness probes** — `GET /api/health`, `GET /api/health/ready`
   (`modules/health/`). Liveness never touches the DB; readiness pings it and
   503s when down so the LB drains the instance. (Observability, Monitoring,
   Deployability, Reliability, Fault Tolerance, Resilience.)
2. **`X-Request-ID` correlation middleware** — `common/middleware/request-id.middleware.ts`.
   Honors a safe inbound id, else mints a uuid; sets `req.id`/`req.requestId`
   and the response header CORS already advertised. (Observability,
   Auditability, Traceability.)
3. **Unified HTTP bootstrap** — `app.config.ts` is now the single source of
   truth for request-id / raw-body webhooks / helmet / CORS / global pipe /
   `api` prefix, consumed by both `main.ts` and the e2e harness so tests can
   never drift from production wiring. (DRY, SSOT, Testability.)
4. **End-to-end test harness** — `backend/test/` (`jest-e2e.json`,
   `utils/test-app.ts`, 4 specs / 30 tests). Boots the real `AppModule` through
   `configureApp` with `PrismaService` mocked (runs DB-less here and in CI;
   real-DB mode is a one-line override swap). Covers health/observability,
   the marketing auth pipeline (validation, fail-closed authn, rate limiting),
   cross-realm authorization isolation, and the `/api/internal/*` wire
   contracts. Run with `npm run test:e2e` (or `npm run test:all`).

---

## 3b. Delivered — session 2 (product scoping + UX + reliability)

- **Entitlement-aware grouped navigation** (`frontend/src/features/marketing/navigation.ts`,
  `hooks/useEntitlements.ts`, `MarketingSidebar.tsx`): nav is now a single
  declarative config gated by group + role + entitlement; modules the
  workspace's package doesn't include are hidden, so a core workspace sees a
  focused ~8–10 item menu instead of 26. (Modularity, KISS, UX/IA.)
- **Topbar breadcrumbs** (`Breadcrumbs.tsx`): route-derived `Group › Page ›
  Leaf` wayfinding. (Documentation/UX.)
- **Shared UI kit** (`frontend/src/components/ui/`): Button/Card/Badge/Skeleton/
  Spinner + `cn()` — the M2 design-system foundation pages migrate onto.
  (DRY, Reusability, Naming consistency.)
- **Per-page ErrorBoundary** (`frontend/src/components/ErrorBoundary.tsx`): a
  failing page no longer white-screens the panel. (Reliability, Fault Tolerance.)
- **Global exception filter** (`backend/.../all-exceptions.filter.ts`): uniform
  error envelope = Nest's `statusCode`/`message` PLUS `requestId`/`path`/
  `timestamp`; unknown errors become a clean logged 500. Closes backlog #8.
  (Reliability, Observability.)
- **E2e coverage** for the platform realm + research routine (principal
  isolation) and the error envelope. Closes backlog #4. E2e now **7 suites /
  41 tests**; unit **56 / 419**.

## 3c. Delivered — session 3 (closing the observability/scale/audit backlog)

- **Structured, correlated logging** (`common/logging/`): a `JsonLogger`
  installed via `app.useLogger()` turns every existing `Logger` call into a JSON
  line stamped with the request's `X-Request-ID`, pulled implicitly from an
  AsyncLocalStorage scope opened by the correlation middleware. (Backlog #1.)
- **Prometheus metrics** (`modules/metrics/`): `/api/metrics` + a global
  interceptor recording request count and a latency histogram, labelled by
  method / matched-route-pattern / status (raw URLs collapse to one label to
  bound cardinality). (Backlog #2.)
- **Append-only audit trail** (`modules/audit/` + `audit_log` migration): an
  append-only `AuditLogService` (no update/delete; non-fatal) and a declarative
  `@Audit()` interceptor that resolves the actor across all three realms and
  records actor/resource/requestId/ip/outcome. Applied to workspace-status,
  manual payment approve/reject, lead-status, and commission approve/pay.
  (Backlog #3.)
- **Distributed rate-limit store** (`common/throttler/`): a Redis
  `ThrottlerStorage` (atomic Lua increment+block) wired via `forRootAsync`,
  gated on `REDIS_URL`, fail-open on a Redis blip. Makes the throttle bucket
  global across replicas. (Backlog #6.)
- **Real-DB e2e + full lead lifecycle** (`test/utils` + `lead-lifecycle.realdb.e2e`):
  an opt-in (`E2E_REAL_DB=1`) harness that boots the app against real Postgres,
  and a single flow exercising ingest → assign → convert → commission with only
  the cross-context CORE provisioning port stubbed. (Backlog #7.)

All of the above ship with unit and/or e2e coverage; the audit migration and the
lifecycle flow were verified against a live Postgres.

## 4. Backlog — remaining phases (prioritized)

Ordered by impact ÷ risk. Each is a discrete, independently shippable PR.

| # | Item | Quality served | Effort | Notes |
|---|------|----------------|--------|-------|
| 1 | ✅ **Done** — structured JSON logger (`JsonLogger`) installed via `app.useLogger()`; `req.id` threaded through AsyncLocalStorage so every line is correlated; `prisma.service.ts` `console.log`s routed through it. | Observability, Auditability | M | `common/logging/` + json-logger.spec. |
| 2 | ✅ **Done** — `/api/metrics` Prometheus endpoint; global interceptor records `http_requests_total` + `http_request_duration_seconds` by method/route-pattern/status (cardinality-safe). | Monitoring & Alerting | M | `modules/metrics/` + unit + e2e. |
| 3 | ✅ **Done** — append-only `audit_log` table + `@Audit()` decorator/interceptor on material state changes (workspace status, manual payment approve/reject, lead status, commission approve/pay). Append-only + non-fatal service. | Auditability, Security | M | `modules/audit/` + migration + unit + e2e. |
| 4 | ✅ **Done** — e2e for `platform` realm + `internal-research` (principal isolation). `outbox` worker still pending. | Testability, Reliability | M | platform-auth.e2e + internal-research.e2e. |
| 5 | ✅ **Done** — OpenAPI/Swagger at `/api/docs`. | Documentation | S | swagger.ts + openapi.e2e. |
| 6 | ✅ **Done** — Redis `ThrottlerStorage` (atomic Lua), gated on `REDIS_URL`, fail-open; the per-replica bucket dilution is gone when Redis is configured. | Horizontal Scalability | S | `common/throttler/` + integration spec. |
| 7 | ✅ **Done** — real-DB e2e harness (`createRealDbTestApp`, opt-in via `E2E_REAL_DB=1`) + the full lead lifecycle (ingest → assign → convert → commission) as one real-Postgres flow. | Testability, Data Consistency | M | lead-lifecycle.realdb.e2e + `npm run test:e2e:realdb`. |
| 8 | ✅ **Done** — global exception filter; envelope = `{ statusCode, message, requestId, path, timestamp }`, additive (preserves success-path envelopes). | Reliability, Observability | S | all-exceptions.filter.ts + error-envelope.e2e. |

**Backlog status: all items (1–8) closed**, plus the follow-on nice-to-haves:
outbox-worker unit coverage ✅, `/metrics` business gauges (`outbox_events_pending`
/ `outbox_events_failed` ✅, `payment_orders_total{status}` ✅), and a CI
`backend-realdb` job wiring Postgres + Redis service containers to run the
opt-in real-DB suite ✅.

---

## 5. Running the checks

```bash
cd backend
npm test            # 55 unit suites / 414 tests
npm run test:e2e    # 4 e2e suites / 30 tests (DB-less; mocked Prisma seam)
npm run test:all    # both
npm run build       # nest build (type-check + emit)
```

Architecture-fitness tests that must stay green on every change:
`workspace-scoping.arch.spec.ts` (multi-tenant isolation),
`marketing-decoupling.arch.spec.ts` (context coupling),
`entitlements.tripwire.spec.ts` + `ai-credit-costs.tripwire.spec.ts`
(business-rule tripwires).
