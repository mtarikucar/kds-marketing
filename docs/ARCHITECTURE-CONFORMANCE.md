# Architecture Conformance Audit — KDS Marketing

> Scope: the standalone marketing service (`backend/` NestJS + `frontend/`
> React). This document scores the codebase against the target quality
> attributes, cites the evidence in-tree, and tracks the hardening backlog.
> It is a **living document** — update the status column when a gap closes.
>
> Last reviewed: 2026-06-13 · Baseline: 55 unit suites / 414 tests + 4 e2e
> suites / 30 tests, all green.

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
| 3 | **Scalability — horizontal** | Partial | App is stateless and replica-safe **except** the rate limiter uses an in-memory `ThrottlerModule` store — per-replica buckets dilute the global limit. Outbox claim is `FOR UPDATE SKIP LOCKED` (multi-worker safe). → backlog #6. |
| 4 | **Modularity** | Strong | One Nest module per context (`marketing`, `billing`, `platform`, `internal`, `outbox`, `health`); cross-module access only via `@Global` providers + ports. |
| 5 | **Separation of Concerns** | Strong | Controllers→services→Prisma; transport in `core-client`, contracts in `core-contracts`, ACL in `marketing/acl`. HTTP wiring isolated in `app.config.ts`. |
| 6 | **Single Source of Truth** | Strong | Wire contracts vendored byte-identical in `core-contracts/`; HTTP bootstrap unified in `app.config.ts` (shared by `main.ts` + e2e harness). |
| 7 | **Extensibility** | Strong | Registry + adapter pattern for channels/telephony/PSPs; new event consumers subscribe to the `DomainEventBus` without touching producers. |
| 8 | **Testability** | Strong | 414 unit tests + **new** e2e harness (`test/`) booting the real app via `configureApp` with a mocked DB seam; arch-fitness + tripwire tests. |
| 9 | **Reliability** | Strong | Idempotent settlement, durable outbox with retry/DLQ, fail-fast env validation, **new** readiness probe drains unhealthy replicas. |
| 10 | **Idempotency** | Strong | Settlement two-phase flip, commission `sourcePaymentId` partial-unique, lead-convert keyed on `leadId`, ingest dedupe on `externalRef`, outbox `idempotencyKey`. |
| 11 | **Observability** | Partial | Wide `Logger` usage (48 files) + **new** `X-Request-ID` correlation middleware + health/readiness. Still missing: structured JSON logs, metrics, the request-id threaded into log lines. → backlog #1, #2. |
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
| 27 | **Documentation** | Partial | Excellent README + in-code rationale; **this audit** added. Missing: generated OpenAPI/Swagger. → backlog #5. |
| 28 | **Monitoring & Alerting** | Partial | Health endpoints + logs give probes/log-based alerts; no metrics endpoint for Prometheus/SLO alerting. → backlog #2. |
| 29 | **Auditability** | Partial | Implicit audit data (commission `auditLog`, offer snapshots, operator approval stamps) + **new** request-id; no dedicated append-only audit table. → backlog #3. |
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

## 4. Backlog — remaining phases (prioritized)

Ordered by impact ÷ risk. Each is a discrete, independently shippable PR.

| # | Item | Quality served | Effort | Notes |
|---|------|----------------|--------|-------|
| 1 | Thread `req.id` into a structured (JSON) logger; replace ad-hoc `console.log` in `prisma.service.ts`/`main.ts` | Observability, Auditability | M | Adopt a Nest `LoggerService` (pino) bound to AsyncLocalStorage. |
| 2 | `/metrics` Prometheus endpoint (request count/latency, outbox depth, settlement outcomes) | Monitoring & Alerting | M | Enables SLO alerts. |
| 3 | Dedicated append-only `audit_log` table + interceptor for material state changes (lead status, role change, commission approval, workspace status) | Auditability, Security | M | Formalizes today's implicit audit data. |
| 4 | ✅ **Done** — e2e for `platform` realm + `internal-research` (principal isolation). `outbox` worker still pending. | Testability, Reliability | M | platform-auth.e2e + internal-research.e2e. |
| 5 | OpenAPI/Swagger generation (`@nestjs/swagger`) from existing DTOs | Documentation | S | DTOs are already class-validator decorated. |
| 6 | Distributed rate-limit store (Redis `ThrottlerStorage`) | Horizontal Scalability | S | Removes per-replica bucket dilution. |
| 7 | Real-DB e2e mode: throwaway Postgres schema in CI + the full lead lifecycle (ingest → assign → convert → commission) as one e2e flow | Testability, Data Consistency | M | `test-app.ts` is already structured for the override swap. |
| 8 | ✅ **Done** — global exception filter; envelope = `{ statusCode, message, requestId, path, timestamp }`, additive (preserves success-path envelopes). | Reliability, Observability | S | all-exceptions.filter.ts + error-envelope.e2e. |

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
