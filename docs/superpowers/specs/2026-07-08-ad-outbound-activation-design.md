# Ad "Outbound Activation" — Design Spec

**Date:** 2026-07-08
**Branch:** `feat/ad-outbound-activation`
**Author:** t00517

## Problem

Two audits of the advertising subsystem found the engine is mature (CRM-revenue budget
autopilot, bandit allocation, Meta write client, full inbound click-id capture) but the
system is **one-directional**: it reads everything in (fbclid, ctwa_clid, gclid, conversion
events all sit in the DB) and sends **nothing** back out. The highest-leverage ad gaps are
all "outbound" or "surface" pipelines whose raw material is already collected:

1. **Meta Lead Ads / Instant Forms (`leadgen`) never reach the CRM** — the Meta webhook only
   subscribes messaging fields; an in-app instant-form submission is silently dropped.
2. **Captured ad attribution + closed-loop ROAS are invisible** — stored per lead / per
   AdMetric row but never returned by the API or rendered.
3. **No server-side conversion feedback (Meta CAPI)** — Meta never learns which click became a
   paying customer, so the ad algorithm can't optimize on real outcomes.
4. **No CRM→ad-platform audience sync** — CRM segments can't become Meta Custom/Lookalike
   audiences for retargeting, exclusion, or prospecting seeds.

## Scope

Four phases, each independently shippable, ordered by effort/leverage. Every phase follows the
existing "ships dark" rule (inert until the operator sets Meta app creds / connects an account)
and the reversible up/down migration rule.

### Phase 1 — Meta Lead Ads (`leadgen`) webhook ingestion  *(no migration)*

**Goal:** a person who submits a Meta Instant Form becomes a CRM lead, attributed to the ad.

- New `MetaLeadgenIngestService` (marketing module) that mirrors `FormsService.submit` internals
  but resolves the workspace from `channel.workspaceId` (no `FormDef`), sets `source: 'ADS'`, and
  dedups idempotently on `Lead.externalRef = 'fbleadgen:<leadgen_id>'` (Meta redelivers webhooks).
- It fetches the full submission via `metaGraphFetch('/<leadgen_id>', { accessToken:
  config.secrets.pageAccessToken, query:{ fields:'field_data,form_id,ad_id,campaign_id,...' } })`,
  flattens `field_data` (`email`/`phone_number`/`full_name` → email/phone/name), creates the lead
  in a `$transaction` (dedup on normalized email/phone, auto-assign owner, SYSTEM-sentinel NOTE,
  `LeadCreated` outbox event, `leadAttribution.capture(..., { sourceAdCampaignId: campaign_id ??
  ad_id })`).
- `MetaWebhookController.process()` gains a `leadgen` branch inside the existing per-entry loop
  (reusing the already-resolved `channel` + `config`), best-effort `.catch`.
- `social-oauth.service.ts` adds `leadgen` to `subscribed_fields` on page subscription (covers
  Messenger + IG; WhatsApp WABA path unaffected).

**Idempotency:** `Lead.externalRef` unique per `[workspaceId, externalRef]`; catch Prisma P2002 as
a no-op. A redelivery must not create a second lead nor re-emit `LeadCreated`.

**Inert gate:** works only where a MESSENGER/INSTAGRAM channel exists (that's where the sealed
`pageAccessToken` lives). Fetch + subscribe require `leads_retrieval`/`pages_manage_ads` on the
Meta app (App-Review, operator-level) — the subscribe stays best-effort/logged, never fatal.

### Phase 2 — Surface ad attribution + closed-loop ROAS in the UI  *(no migration)*

**Goal:** expose already-persisted data. No schema, no new provider calls.

- **Backend a:** add the `attribution` relation (scalar `select`, dropping the forensic `raw`
  blob) to `MarketingLeadsService.findOne()`'s Prisma `include`. `GET /leads/:id` returns it
  verbatim.
- **Backend b:** in `AdAccountService.getMetrics()` accumulate `revenueCents` (integer, mirroring
  `spendCents`) and project `revenue = revenueCents/100` + **recomputed** `roas = revenueCents/
  spendCents` (never sum the stored per-row `roas`). Propagates to totals/byProvider/byDay through
  `bucket()`. Update `empty()` to keep the shape.
- **Frontend:** extend `AdMetricBucket` (+ the local `Bucket` in `AdReportingPage`) with `revenue`
  + `roas`; add Revenue/ROAS StatCards + table columns; add a nullable `attribution` to
  `DetailLead` + a new `LeadAttribution` interface; render an Attribution card in `ContactInfo`
  (gated on `lead.attribution &&`).

**Risks:** ROAS recomputed from aggregates, not summed. Attribution stays on `DetailLead` only
(not the shared list `Lead`). Decimals wrapped with `Number()`. ROAS renders a dash when revenue
is 0 (TikTok/LinkedIn report no purchase value).

### Phase 3 — Meta Conversions API (CAPI) conversion feedback  *(migration: AdAccount.pixelId + capiToken)*

**Goal:** when a deal is WON / an invoice is PAID, POST a server-side event to Meta with the
matched click-id + hashed PII so the algorithm learns.

- **Migration (up/down):** add `pixelId String?` (non-secret) + `capiToken String? @db.Text`
  (sealed, optional — falls back to the existing sealed `accessToken`) to `ad_accounts`.
- New `MetaCapiConsumer` (mirrors `SettlementCommissionConsumer`): subscribes to `InvoicePaid`
  (→ `Purchase`, the richer signal: carries currency + total in **minor units** → /100) and
  `OpportunityWon` (→ `Purchase`/`Lead`, value in major units, no currency → read from Opportunity
  or default workspace currency). Per event: resolve the workspace's META `AdAccount` + `pixelId`;
  read the lead's `LeadAttribution` (`clickId` where `clickIdType='FBCLID'`, `ctwaClid`) + `Lead`
  (`emailNormalized`, `phoneNormalized`, `city`); build `user_data` = SHA-256(em/ph) + `fbc =
  fb.1.<attribution.createdAt.ms>.<fbclid>` + `ctwa_clid`; POST `/<pixelId>/events` with
  `event_id = event.id` (the outbox UUIDv7 — Meta dedups on it). Best-effort try/catch; skip +
  warn when no META account / pixelId (inert rule). At-least-once bus → dedupe via `event_id`.
- New client fn `sendConversionEvent(token, pixelId, event)` on a small `meta-capi.client.ts`.
- Capability/config gate `isMetaAdsConfigured()` + pixelId presence.
- Endpoint: extend the ad-account connect/update to accept `pixelId` (+ optional `capiToken`).

**Risks:** phone must be E.164 with country code before hashing; value-unit mismatch (invoice
minor vs opportunity major); `leadId` may be null (send value-only or skip); appsecret_proof auto-
added → the CAPI token must belong to the same Meta app.

### Phase 4 — CRM segment → Meta Custom Audience sync  *(migration: SegmentAudienceSync table)*

**Goal:** push a CRM segment to Meta as a Custom Audience (create + hashed session upload) and
optionally seed a Lookalike.

- **Migration (up/down):** `SegmentAudienceSync { id, workspaceId, segmentId, adAccountId,
  provider, externalAudienceId, lookalikeAudienceId?, lastSyncedAt?, lastCount?, status,
  lastError? @@unique([segmentId, adAccountId]) @@index([workspaceId]) }`. Add the delegate to
  `OWNED_DELEGATES` in `workspace-scoping.arch.spec.ts`.
- Meta client: `createCustomAudience`, `addAudienceUsers` (session SHA-256 upload, ≤10k/batch,
  `session_id` constant, `batch_seq`, `last_batch_flag`), `createLookalikeAudience`.
- New `AudienceSyncService`: resolve+decrypt the META ad-account token (mirror
  `ad-management.service.ts` metaAccount + onResult), page the segment's members, exclude opt-outs
  (`emailOptOut`/`smsOptOut`/`emailVerifiedStatus='INVALID'`), normalize (phone → E.164 + country
  code) then hash, drive the session upload, persist `externalAudienceId` per `(segmentId,
  adAccountId)` for idempotent re-sync.
- Endpoint `POST marketing/segments/:id/sync/:accountId` (guarded `@MarketingRoles('MANAGER')` +
  `@RequirePermission('settings.manage')` + `@Audit`). Capability gate `canSyncAudience(provider)`.
- Frontend: a "Sync to Meta" action on the segment (optional stretch; API is the deliverable).

**Risks:** multi-tenant — resolve ad account by `{id, workspaceId}`; phone country-code correctness
(TR `05…` must become `905…`); consent/KVKK (exclude opt-outs); lookalike needs a populated seed
(sequence, don't chain synchronously); idempotency via the sync table.

## Cross-cutting conventions (from the integration map)

- **Secrets:** per-workspace tokens sealed via `sealSecret`/`openSecret` (AES-256-GCM, env
  `MARKETING_SECRET_KEY`); never echoed in list selects. Non-secret config (pixelId) is a plain
  column.
- **Tenancy:** every write inlines `workspaceId`; id-keyed reads use `findFirst({ where: { id,
  workspaceId } })`; new owned Prisma delegates must be added to `OWNED_DELEGATES`.
- **Migrations:** reversible up/down pair (copy `20260703110000_budget_cost_ledger`); verify
  up→down→up.
- **Ships dark:** gate on `isMetaAdsConfigured()` + presence of the per-workspace token/pixelId;
  subscribe/POST failures are logged, never fatal.
- **Commits:** one per phase, plain conventional-commit messages, no AI trailer.

## Testing

Each phase ships unit tests mirroring the existing spec style (`*.spec.ts`, `jest`): Phase 1 —
field_data mapping + dedup/idempotency + attribution wiring (mock `metaGraphFetch` + Prisma);
Phase 2 — revenue accumulation + recomputed ROAS + empty-state shape; Phase 3 — consumer builds
the correct event (hashing, fbc format, value units, skip-on-no-config, dedup event_id); Phase 4 —
member enumeration + opt-out exclusion + phone E.164 hashing + session batching + idempotent
re-sync. Verify with per-file `npx jest <path>` (run `npx prisma generate` first for phases that
touch the schema).

## Out of scope (deferred — need external setup, tracked separately)

Ad-creative → paid-ad publish builder, full multi-platform campaign management (TikTok/LinkedIn
write, Google Ads), placement/creative/demographic reporting breakdowns. These are L-effort and
blocked on external OAuth apps / dev tokens; noted in the ad-side audit memory.
