# Epic B — Public API + integration ecosystem — design

**Date:** 2026-06-15
**Status:** approved-direction (user) — decisions controller-made
**Program:** GoHighLevel feature-parity, Epic B (builds on Epic A's data model)

## Goal

Open kds-marketing to external integrations the way GoHighLevel does: programmatic
**API keys**, **outbound webhooks**, and a **versioned public REST API**. Together
these make Zapier/Make-style automation possible (call the REST API + subscribe to
webhooks) without bespoke per-tool code. Specific connectors (Slack, 2-way Google
Calendar) sit on top and are a later sub-epic.

## Units (delivered backend-first, one PR each)

### B1 — API keys + `ApiKeyGuard` (foundation)
- `ApiKey { workspaceId, name, keyHash (sha256), prefix, scopes Json, status, lastUsedAt, createdById, revokedAt }`.
- Key format `mk_live_<32 url-safe bytes>`; the raw key is returned **once** on
  create, then only the prefix is ever shown. Stored as a SHA-256 hash.
- `ApiKeyGuard` authenticates `Authorization: Bearer mk_live_...` (or `X-Api-Key`),
  resolves the workspace, enforces `scopes` (`read`/`write`), stamps `lastUsedAt`.
- Management CRUD in the workspace (JWT) realm: create (returns raw once), list
  (prefix + lastUsed), revoke.

### B2 — Outbound webhooks
- `WebhookEndpoint { workspaceId, url, events Json (subscribed types), secretSealed, status, lastDeliveryAt, failureCount }`.
- On marketing domain events (lead.created/updated/merged, tag.added, conversation.message, etc.)
  a subscriber enqueues a delivery `ScheduledJob` (`kind:'webhook.deliver'`) per
  matching endpoint. Delivery POSTs the event JSON with an `X-Signature:
  sha256=<hmac>` header; non-2xx → retry with backoff (ScheduledJob attempts),
  `failureCount`++ and auto-disable after N.
- `WebhookDelivery` log row (endpointId, eventType, status, responseCode, attempts).
- Endpoint CRUD (workspace realm) + a "send test event" action.

### B3 — Public REST API v1 (`/api/v1`, API-key auth)
- Versioned controllers under `/api/v1`, guarded by `ApiKeyGuard`:
  - `GET/POST/PATCH/DELETE /v1/leads` (+ `/:id`), filtering by the Epic-A segment
    DSL; `customFields` + `tags` in payloads.
  - `GET/POST /v1/tags`, `GET /v1/custom-fields`.
  - `GET /v1/segments/:id/members`.
- Stable response envelopes + pagination; reuses Epic-A services (no logic fork).
- OpenAPI doc surface for the v1 namespace.

### B4 — Connectors (later sub-epic, not this epic's PRs)
- Slack incoming-webhook notify on selected events (a thin `WebhookEndpoint` preset).
- Google Calendar 2-way sync for `Booking` (OAuth, push/pull). Heavier; separate spec.

## Decisions (controller-made)
- API keys are **workspace-scoped**, hashed at rest, prefix-identified, scope-gated.
- Webhook secrets sealed with `secret-box` (like channel creds); deliveries signed
  HMAC-SHA256; retries + auto-disable reuse the `ScheduledJob` runner.
- Public API is **versioned** (`/api/v1`) and reuses Epic-A services — the public
  surface is a thin auth+shape layer, never a second copy of business logic.
- Everything stays workspace-isolated (arch-fitness test must keep passing).

## Non-goals (v1)
- OAuth2 authorization-code app platform / marketplace (API keys only for now).
- GraphQL. Per-endpoint rate plans (global throttle stays).
- Slack/Google connectors (B4 — separate spec).

## Testing
- Unit: key hashing/verify + guard (valid/invalid/revoked/scope), webhook subscriber
  fan-out + signature, delivery worker retry/disable, v1 controllers shape.
- E2E: create key → call `/api/v1/leads` with it (200) / bad key (401); create
  webhook → event enqueues a signed delivery; v1 leads CRUD round-trip.
- Arch-fitness + full existing suite stay green.

## Delivery sequence
B1 (API keys + guard) → B2 (webhooks) → B3 (public REST v1). B4 connectors follow
as their own spec. Each unit = schema → service (TDD) → controller/guard → e2e →
green regression → commit.
