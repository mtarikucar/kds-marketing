# AI Social Content Studio — Design Spec

**Date:** 2026-06-30
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** One spec, three implementation milestones. Adds automatic AI photo/video generation to the social-media area, an asset library, a Social Campaign / content-calendar engine that auto-progresses content with selectable automation + planning modes, and cross-linkage to existing email/SMS campaigns and Meta ad campaigns.

---

## 1. Goals

1. **Automatic photo & video generation** in the marketing → social section, both inside the post composer and in a dedicated "AI Content Studio" section with an asset library.
2. **A Social Campaign / content-calendar engine**: a campaign carries a goal, theme, brand inputs and a cadence; AI produces a sequence of posts (copy + media) and **auto-progresses** them through the calendar.
3. **Selectable modes** on two axes:
   - **Automation mode** (publishing): `APPROVAL`, `SEMI_AUTO`, `FULL_AUTO`.
   - **Planning mode** (what to post): `AI_PROPOSE` (AI proposes, user edits), `AI_FULL` (AI decides everything), `USER_TOPICS` (user supplies topics, AI fills copy+media).
4. **Better campaign UX**: a detail view for existing email/SMS campaigns, a stepped builder, a content calendar and an approval queue.
5. **Cross-linkage**: connect generated content to existing marketing (email/SMS/WhatsApp) campaigns and feed generated assets to Meta ad campaigns.

## 2. Non-goals

- No new storage layer — reuse Cloudflare R2 (`social-planner/r2-storage.service.ts`).
- No new queue broker — reuse the Postgres-backed `ScheduledJob` queue (no BullMQ).
- No change to the existing per-network publish path (`network-adapters.ts`) — generated media flows into the existing `SocialPost` media model and publishes unchanged.
- No change to the existing email/SMS/WhatsApp `campaign-sender` send logic; the blast channel enum is **not** extended with SOCIAL (linkage is by FK, see §6.3).
- Audio / voiceover generation is out of scope for this spec (the provider abstraction leaves room for it later).
- Self-hosting generation models is out of scope; all generation goes through the provider API.

## 3. Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Generation provider | **fal.ai** behind a `MediaProvider` abstraction (Replicate addable later) |
| Media types (v1) | **Image + video together** |
| Campaign linkage | **All**: new Social Campaign concept + link to existing blast campaigns + feed Meta ads |
| Automation | **Three selectable modes** (`APPROVAL` / `SEMI_AUTO` / `FULL_AUTO`) |
| Planning | **Three selectable modes** (`AI_PROPOSE` / `AI_FULL` / `USER_TOPICS`) |
| Brand consistency | **Brand Kit** (logo, palette, tone, 3–5 reference images) reused across generations |
| Delivery | One spec; UI lives both in composer and a dedicated **AI Content Studio** menu |

### 3.1 Default model picks (fal.ai, swappable per generation)

| Slot | Model | Price (approx, 2026) |
|---|---|---|
| Draft image | `fal-ai/qwen-image` | ~$0.02 / image |
| Final image | `fal-ai/bytedance/seedream/v4` | ~$0.03 / image |
| Cheap short video | `fal-ai/kling-video/v2.1/standard` | ~$0.025 / sec (5s ≈ $0.13) |
| Premium video | `fal-ai/bytedance/seedance/v1/pro` | ~$0.15 / sec (5s ≈ $0.74) |
| Video + synced audio | `fal-ai/veo3/fast` | ~$0.25 / sec (5s ≈ $1.25) |

Exact model IDs are confirmed against fal's catalog at implementation time and stored in a single config map (`media-models.config.ts`). Prices feed the credit cost table (§7).

---

## 4. Architecture overview

```
Frontend (React/Vite)
  ├─ AI Content Studio page  ──┐
  ├─ PostComposer "Generate"  ─┼─► POST /marketing/ai/media/generate ─► MediaGenService
  ├─ Social Campaign builder  ─┘
  └─ Brand Kit settings        ─► /marketing/brand-kit

Backend (NestJS)
  MediaGenService
    ├─ AiCreditsService            (reserve → reconcile → refund)
    ├─ MediaProvider (interface)
    │     └─ FalProvider           (submit / getResult, fal queue API + @fal-ai/client)
    ├─ R2StorageService.upload()   (download fal URL → re-upload to own bucket)
    └─ GeneratedAsset (Prisma)

  ScheduledJob queue (existing)
    ├─ social.media.generate.poll        (poll fal until READY/FAILED, idempotent)
    ├─ social.media.cleanup.orphans      (retention sweep of unattached READY assets, §5.3)
    ├─ social.campaign.plan              (self-rescheduling planner per cadence tick)
    ├─ social.campaign.item.generate     (copy via ContentAiService + media via MediaGenService)
    └─ social.campaign.item.confirm      (SEMI_AUTO pre-publish gate, §6.1)

  Webhook
    └─ POST /marketing/ai/media/webhook  (fal completion fast-path, idempotent on requestId)

  SocialCampaignService                  (CRUD + lifecycle + planner orchestration)
```

Wiring follows the existing `conversation.ai_reply` async-generation precedent: handlers registered in `marketing.module.ts` via `ScheduledJobService.registerHandler()`; jobs scheduled with `schedule({ workspaceId, kind, runAt, payload, dedupKey?, maxAttempts? })`.

### 4.1 Provider abstraction

```ts
// ai/providers/media-provider.interface.ts
interface MediaGenSubmit {
  type: 'IMAGE' | 'VIDEO';
  model: string;            // fal model id
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;     // '1:1' | '9:16' | '16:9' | '4:5'
  durationSec?: number;     // video only
  referenceImageUrls?: string[]; // from Brand Kit
  seed?: number;
  webhookUrl?: string;
}
interface MediaProvider {
  submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }>;
  getResult(requestId: string): Promise<{
    status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
    outputs?: Array<{ url: string; mime: string; width?: number; height?: number; durationSec?: number }>;
    error?: string;
  }>;
}
```

`FalProvider` implements this over the fal queue API. The job/metering/webhook plumbing never references fal directly. A `ReplicateProvider` can be added later without touching the rest.

### 4.2 Generation lifecycle (single asset)

1. Client calls `POST /marketing/ai/media/generate`.
2. `MediaGenService.requestGeneration`:
   - resolve model (explicit, or from quality tier + Brand Kit defaults),
   - estimate cost (image flat; video = price/sec × duration),
   - **reserve credits** via `AiCreditsService` (reject if balance < estimate),
   - create `GeneratedAsset(status=QUEUED)`,
   - `provider.submit(...)` with `webhookUrl`, store `providerRequestId`, set `GENERATING`,
   - schedule `social.media.generate.poll` (runAt +20s, dedupKey `media-gen-<assetId>`, maxAttempts large enough for video).
3. Completion arrives by **webhook (fast)** or **poll (fallback)** — whichever first; both call the same idempotent `MediaGenService.finalizeAsset(assetId, result)`:
   - `COMPLETED`: download each output server-side, `R2StorageService.upload()` → store `url`/`r2Key`/`mime`/dims/duration, set `READY`, **reconcile credits to actual**.
   - `BLOCKED` (moderation): set `BLOCKED` + `error`, **refund the reservation** (do not burn credits).
   - `FAILED`: set `FAILED` + `error`, **refund**.
   - Idempotency: `finalizeAsset` is a no-op if the asset is already terminal (`READY`/`FAILED`/`BLOCKED`); dedupe on `providerRequestId` so webhook + poll never double-finalize or double-charge.
4. Frontend polls `GET /marketing/ai/media/generations/:id` (react-query) until terminal.

### 4.3 Concurrency & rate limits

- A per-workspace **in-flight cap** (config `MEDIA_GEN_MAX_INFLIGHT`, default 4) enforced at submit; over-cap requests are rejected with a clear "too many running generations" error (not queued indefinitely).
- On provider `429`, the poll job backs off using the existing exponential-backoff in `scheduled-job-runner`.

---

## 5. Data model (Prisma)

All additions ship as reversible migrations (up + down). Each `down` drops exactly what its `up` added (tables/columns/enums/indexes) and touches no user data. New columns on existing tables are nullable/defaulted so the up is safe on populated tables and the down is a clean column drop.

### 5.1 New enums

- `GeneratedAssetType { IMAGE, VIDEO }`
- `GeneratedAssetStatus { QUEUED, GENERATING, READY, FAILED, BLOCKED }`
- `SocialCampaignStatus { DRAFT, ACTIVE, PAUSED, COMPLETED, CANCELLED }`
- `SocialCampaignAutomationMode { APPROVAL, SEMI_AUTO, FULL_AUTO }`
- `SocialCampaignPlanningMode { AI_PROPOSE, AI_FULL, USER_TOPICS }`
- `SocialCampaignItemStatus { PLANNED, GENERATING, NEEDS_APPROVAL, APPROVED, SCHEDULED, PUBLISHED, FAILED, SKIPPED }`

### 5.2 `BrandKit` (one per workspace)

| Field | Type | Notes |
|---|---|---|
| id | String @id | |
| workspaceId | String @unique | one kit per workspace |
| logoUrl, logoR2Key | String? | R2 |
| palette | Json? | array of hex colors |
| tone | String? | brand voice/tone text |
| referenceImages | Json | `[{ url, r2Key, mime }]` (3–5) |
| defaultHashtags | String[] | |
| defaultCta | String? | |
| createdAt, updatedAt | DateTime | |

### 5.3 `GeneratedAsset`

| Field | Type | Notes |
|---|---|---|
| id | String @id | |
| workspaceId | String | indexed |
| type | GeneratedAssetType | |
| status | GeneratedAssetStatus | indexed with workspaceId |
| provider | String | e.g. `fal` |
| model | String | fal model id |
| providerRequestId | String? | indexed (idempotency) |
| prompt | String | |
| negativePrompt | String? | |
| params | Json | aspect, resolution, duration, seed, referenceImageUrls |
| url, r2Key, mime | String? | set on READY |
| width, height | Int? | |
| durationSec | Float? | video |
| thumbnailUrl, thumbnailR2Key | String? | video poster |
| costCredits | Int? | reconciled actual |
| costUsd | Decimal? | optional bookkeeping |
| error | String? | failure/moderation reason |
| socialCampaignId | String? | FK, nullable |
| createdById | String | |
| createdAt, updatedAt | DateTime | |

Retention: a `social.media.cleanup`-style sweep removes **READY-but-unattached** assets older than N days (config, default 30) to avoid orphan accumulation in R2 (the existing cleanup only fires post-publish). Attached/published assets are exempt.

### 5.4 `SocialCampaign`

| Field | Type | Notes |
|---|---|---|
| id | String @id | |
| workspaceId | String | indexed |
| name | String | |
| goal | String? | |
| theme | String? | |
| brief | Json | audience, key messages, languages, product refs |
| status | SocialCampaignStatus | default DRAFT |
| automationMode | SocialCampaignAutomationMode | |
| planningMode | SocialCampaignPlanningMode | |
| cadence | Json | `{ perWeek, daysOfWeek[], timeOfDay, timezone }` |
| startDate | DateTime | |
| endDate | DateTime? | open-ended allowed |
| targetAccountIds | String[] | connected SocialAccounts |
| mediaKinds | String[] | `['IMAGE','VIDEO']` |
| defaultImageModel | String? | |
| defaultVideoModel | String? | |
| dailyPublishCap | Int | default 2 (safety, esp. FULL_AUTO) |
| linkedCampaignId | String? | FK → Campaign (blast), §6.3 |
| linkedAdCampaignId | String? | FK → Meta ad campaign, §6.3 |
| stats | Json | generated/approved/published counts |
| createdById | String | |
| createdAt, updatedAt | DateTime | |

### 5.5 `SocialCampaignItem`

| Field | Type | Notes |
|---|---|---|
| id | String @id | |
| socialCampaignId | String | indexed |
| workspaceId | String | |
| sequenceIndex | Int | |
| scheduledFor | DateTime | planned slot |
| status | SocialCampaignItemStatus | default PLANNED |
| topic | String? | AI- or user-decided angle |
| socialPostId | String? | FK → SocialPost draft |
| generatedAssetIds | String[] | the media used |
| error | String? | |
| createdAt, updatedAt | DateTime | |

### 5.6 Additions to existing models

- `SocialPost`: add `socialCampaignId String?` + `campaignItemId String?` (both nullable, indexed). No behavior change for manually-created posts.
- `Campaign` (blast): add `socialCampaignId String?` (nullable) — links a blast to a companion Social Campaign. Channel enum unchanged.
- Meta ad creative linkage handled by storing `linkedAdCampaignId` on `SocialCampaign` plus a push action (§6.3); no schema change to ads required beyond a nullable creative-source reference if the ads model needs it (decided at implementation against the `ads/` model).

---

## 6. Behavior & state machines

### 6.1 Automation modes (publishing)

For each generated `SocialCampaignItem` after copy+media are ready:

- **APPROVAL** → item `NEEDS_APPROVAL`; nothing is scheduled. User approves in the queue → item `APPROVED` → user schedules/publishes via the normal composer/schedule path.
- **SEMI_AUTO** → the underlying `SocialPost` is created and **scheduled** (`SCHEDULED`) for `scheduledFor`; item `SCHEDULED`. A **pre-publish approval gate**: a notification + a hold flag is set; a `social.campaign.item.confirm` check runs shortly before `scheduledFor`. If the user has not rejected, it publishes; if rejected, the post is cancelled and item → `SKIPPED`.
- **FULL_AUTO** → `SocialPost` scheduled and allowed to publish at `scheduledFor` with no human step, **subject to** `dailyPublishCap` and a brand-safety check on the copy. Over-cap items roll to the next available slot.

All three honor the existing `social.publish` job for the actual publish, so per-network adapters are unchanged.

### 6.2 Planning modes (what to post)

`social.campaign.plan` job (self-rescheduling, one tick per cadence interval while `ACTIVE`):

- **AI_FULL** → AI derives the next topics from `brief`+`BrandKit`, creates `SocialCampaignItem`s, and immediately fans out `social.campaign.item.generate` for each.
- **AI_PROPOSE** → AI creates `SocialCampaignItem`s in `PLANNED` with proposed topics but **does not generate** until the user reviews/edits and confirms the plan (or per-item). On confirm, items fan out to generation. (When the campaign is first activated, the planner front-loads a proposed plan for the user to edit.)
- **USER_TOPICS** → items are created from the user-supplied topic list/outline; the planner only schedules generation for slots that have a topic.

The planner reschedules itself for the next cadence tick (dedupKey `social-campaign-plan-<id>`), stops at `endDate` or when `status` leaves `ACTIVE`, and writes progress to `stats`.

### 6.3 Cross-linkage (existing campaigns + Meta ads)

- **Blast campaign → social**: from the campaign detail view, "Create social content for this campaign" provisions a `SocialCampaign` (prefilled from the blast subject/body/audience) and sets `Campaign.socialCampaignId`. The two run independently afterward.
- **Meta ads**: a `GeneratedAsset` (or an approved item's media) can be pushed to a Meta ad campaign as a creative via the existing `ads/` integration; `SocialCampaign.linkedAdCampaignId` records the target. This is an explicit user action, not automatic.

---

## 7. Credits, config, feature flags

- **Credit costs** (`ai/ai-credit-costs.ts`): add `media.image.generate` (flat per image, per model tier) and `media.video.generate` (per second × duration). Reserve estimate at submit, reconcile to actual on `READY`, refund on `FAILED`/`BLOCKED`. Serialized via the existing advisory-lock path in `AiCreditsService`.
- **Budget guardrail**: per-workspace monthly media-gen spend cap (config + checked before reserve); video duration hard cap (config `MEDIA_GEN_MAX_VIDEO_SEC`, default 10).
- **Env**: `FAL_KEY` (required to enable). Absent → feature is inert (mirrors R2 fallback), endpoints return a "media generation not configured" state and the UI hides/disables the generate actions. Respects existing `AI_DISABLED=1` kill switch.
- **Feature flags / RBAC**: `@RequiresFeature('mediaGen')` and `@RequiresFeature('socialCampaigns')` via the existing `FeatureGuard`; writes guarded by `campaigns.send` + MANAGER, matching the social/campaign modules. No new roles.

---

## 8. API surface (new)

Media:
- `POST   /marketing/ai/media/generate` → `{ assetId }`
- `GET    /marketing/ai/media/generations` (library; filters: type, status, campaignId)
- `GET    /marketing/ai/media/generations/:id` (status poll)
- `POST   /marketing/ai/media/generations/:id/regenerate`
- `DELETE /marketing/ai/media/generations/:id`
- `POST   /marketing/ai/media/webhook` (fal; token-guarded, idempotent)

Brand Kit:
- `GET    /marketing/brand-kit`
- `PUT    /marketing/brand-kit`
- `POST   /marketing/brand-kit/reference-image` (multipart → R2)

Social Campaigns:
- `GET/POST /marketing/social-campaigns`
- `GET/PATCH /marketing/social-campaigns/:id`
- `POST   /marketing/social-campaigns/:id/{activate,pause,resume,cancel}`
- `GET    /marketing/social-campaigns/:id/items`
- `POST   /marketing/social-campaigns/:id/plan/confirm` (AI_PROPOSE)
- `POST   /marketing/social-campaigns/items/:itemId/{approve,reject,regenerate}`

DTOs are class-validated, following the inline-DTO convention already used in `social-planner.controller.ts`.

---

## 9. Frontend surfaces

- **AI Content Studio** — new lazy route + left-nav item (`frontend/src/pages/marketing/social/AiStudioPage.tsx`): generation panel (prompt, image/video toggle, quality/model select, aspect ratio, duration, count), live generation cards (react-query polling), asset-library grid with filters and actions ("Add to post", download, regenerate, delete).
- **Composer integration** — `PostComposerDialog.tsx`: an "AI ile Üret" action opening an inline generate panel (Sheet); results drop into the existing media list.
- **Brand Kit settings** — a settings page/section to manage logo, palette, tone, reference images, default hashtags/CTA.
- **Social Campaigns** — list page; a **stepped builder** (new reusable `Stepper`/`Wizard` primitive in `components/ui/`, since none exists): Goal & theme → Brief & Brand Kit → Channels & cadence → Automation mode → Planning mode → Review; a **calendar view** of items; an **approval queue** (items in `NEEDS_APPROVAL`).
- **Campaign UX uplift** — add a detail view (recipients + stats) for existing blast campaigns (the `GET /:id/recipients` endpoint is currently unused), and the "Create social content" cross-link.
- **API**: extend `frontend/src/features/marketing/api/` with typed `media`, `brandKit`, `socialCampaigns` services over the existing axios `marketingApi`. Server state via react-query.

### 9.1 i18n

Add namespaced keys to `src/i18n/locales/en/marketing.json` + `tr/marketing.json`: `aiStudio.*`, `brandKit.*`, `socialCampaign.*`, and extract the existing inline `social.*` defaults. RTL-safe (project already supports `ar`).

---

## 10. Error handling, idempotency, safety

- `finalizeAsset` idempotent and terminal-safe; webhook + poll converge without double-charge (dedupe on `providerRequestId`).
- Moderation (`BLOCKED`) is a first-class outcome, surfaced distinctly in UI, never burns credits.
- Webhook endpoint validates a shared secret (`FAL_WEBHOOK_SECRET` or signature) and ignores unknown/duplicate `requestId`.
- fal result URLs are downloaded and re-hosted in R2 immediately (provider URLs expire); DB stores the R2 key, never the fal URL.
- FULL_AUTO is bounded by `dailyPublishCap` and a brand-safety copy check; planner stops cleanly on `PAUSED`/`CANCELLED`.
- All money/credit movement reserve-before / refund-on-failure, serialized by advisory lock.

## 11. Testing strategy

- **Unit**: `FalProvider` (submit/getResult mapping), `MediaGenService` (reserve→finalize→reconcile, refund on FAILED/BLOCKED, idempotent finalize, webhook+poll convergence), credit estimate math (video per-sec), retention sweep.
- **Planner**: cadence tick math, the three planning modes, the three automation modes (state transitions per item), `dailyPublishCap` rollover, stop-on-pause.
- **R2**: download→upload path with a mocked S3 client.
- **e2e (happy paths)**: Studio generate → add to post → publish; campaign activate → plan → approve → publish (APPROVAL); FULL_AUTO publishes within cap.
- Tests follow existing backend test patterns; provider and R2 are mocked (no live fal/R2 calls in CI).

## 12. Implementation milestones (single spec, sequenced)

1. **Core pipeline**: `MediaProvider`+`FalProvider`, `GeneratedAsset`, async generate+poll job, credit costs, R2 upload, webhook, Brand Kit. (Headless; covered by unit tests.)
2. **AI Content Studio + composer integration**: studio page, asset library, composer "Generate", Brand Kit settings UI, i18n. (Delivers on-demand image+video generation end-to-end.)
3. **Social Campaign engine**: `SocialCampaign`/`SocialCampaignItem`, planner + item-generate jobs, automation & planning modes, stepped builder, calendar, approval queue.
4. **Cross-linkage**: blast-campaign detail view + "create social content" link; Meta ad creative push.

Each milestone is independently shippable and leaves the app working.

## 13. Risks & open items (to confirm during planning)

- **fal model IDs / exact prices** verified against the live catalog at implementation; centralized in `media-models.config.ts`.
- **Meta ads creative push** depends on the current `ads/` integration surface; exact mechanism decided against that module during planning (may be a follow-up if the ads creative API isn't already wired).
- **Webhook reachability** in the deployment (public URL for fal callbacks); poll fallback covers environments where the webhook can't reach us.
- **Brand-safety check** for FULL_AUTO: reuse existing Claude text path to screen copy; threshold/behavior to finalize in planning.
