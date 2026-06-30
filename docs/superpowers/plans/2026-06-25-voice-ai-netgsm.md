# Voice AI (NetGSM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every Voice-AI capability that needs NO paid activation/purchase — all shipped inert behind env + capability flags, so it activates the moment the user buys the NetGSM add-ons (SIP Trunk / Yapay Zeka / Görüşme Kaydı / Özel API) and sets the keys.

**Architecture:** Provider-agnostic STT abstraction feeds two surfaces: (1) **post-call analysis** (recording → STT → Claude structured analysis, persisted + surfaced) and (2) a **live agent copilot** (webphone WebRTC audio → WS → streaming STT → Claude suggestions). For real-time spoken AI, a NetGSM-blessed path: an **OpenAI-compatible custom-LLM bridge** that VAPI/Retell/ElevenLabs call so the "brain" stays our Claude + knowledge base, plus a **NetGSM Özel-API inbound IVR** that uses NetGSM's built-in TTS robot (Claude writes the text). Everything reuses existing `AnthropicService`, `KnowledgeService`, `AiCreditsService`, `VoiceCall`/`VoiceTranscript`, and the env-gating convention.

**Tech Stack:** NestJS 11, Prisma 6, TypeScript (strictNullChecks:false), Jest; `@anthropic-ai/sdk`; `safeFetch` (SSRF-safe); `@nestjs/schedule` cron + advisory locks; React 18 + Vite + vitest frontend.

**Reference spec:** `docs/superpowers/specs/2026-06-25-voice-ai-netgsm-research.md`.

**Conventions (from codebase exploration — match exactly):**
- Env gate functions: `is<Feature>Configured(): boolean` (see `ads/ads.types.ts`).
- Claude: `anthropic.complete({ system, messages, maxTokens?, tier?, cacheSystem? }): Promise<{text, toolUses, stopReason, usage}>`; tiers `'default'|'light'|'conversation'`.
- Knowledge: `knowledge.search(workspaceId, query, docIds?, limit?): Promise<{id,title,snippet,rank}[]>`.
- Credits: `credits.reserve(workspaceId, cost)` / `credits.refund(workspaceId, cost)`; costs in `ai/ai-credit-costs.ts`.
- Migrations: `prisma/migrations/YYYYMMDDhhmmss_snake_case/migration.sql`.
- Register services in `marketing.module.ts` providers/controllers arrays.
- HTTP out: `safeFetch(url, { timeoutMs?, ... }): Promise<Response>`.

---

## File Structure

**Phase 0 — config + STT (foundation)**
- Create `backend/src/modules/marketing/voice-ai/voice-ai.config.ts` — env gates + capability resolver.
- Create `backend/src/modules/marketing/voice-ai/stt.service.ts` — provider-agnostic STT (`transcribeUrl`).
- Tests: `voice-ai.config.spec.ts`, `stt.service.spec.ts`.

**Phase 1 — post-call analysis (#4)**
- Migration `..._call_analysis` — `call_analyses` table.
- Create `backend/src/modules/marketing/voice-ai/call-analysis.service.ts` — recording→STT→Claude→persist.
- Create `backend/src/modules/marketing/voice-ai/call-analysis.cron.ts` — sweep SalesCalls w/ recordingUrl & no analysis.
- Modify `controllers/sales-call.controller.ts` — `GET /calls/:id/analysis`.
- Tests: `call-analysis.service.spec.ts`.
- Frontend: analysis panel on call/lead timeline + i18n.

**Phase 2 — custom-LLM bridge (#1b/#2 brain = Claude)**
- Create `backend/src/modules/marketing/voice-ai/voice-ai-bridge.controller.ts` — OpenAI-compatible `chat/completions`.
- Create `backend/src/modules/marketing/voice-ai/voice-ai-bridge.service.ts` — OpenAI↔Claude mapping + KB + transcript record.
- Tests: `voice-ai-bridge.service.spec.ts`, `voice-ai-bridge.controller.spec.ts`.

**Phase 3 — NetGSM Özel-API inbound IVR (#1 lite, TTS robot)**
- Create `backend/src/modules/marketing/voice-ai/netgsm-ivr.controller.ts` — public webhook.
- Create `backend/src/modules/marketing/voice-ai/netgsm-ivr.service.ts` — build `{status,result,data}` reply.
- Tests: `netgsm-ivr.service.spec.ts`, `netgsm-ivr.controller.spec.ts`.

**Phase 4 — live copilot (#3)**
- Create `backend/src/modules/marketing/voice-ai/copilot.gateway.ts` — WS audio→STT→Claude suggestions.
- Create `backend/src/modules/marketing/voice-ai/copilot.service.ts`.
- Tests: `copilot.service.spec.ts`.
- Frontend: `webphone` copilot panel hook (capture MediaStream → WS).

**Phase 5 — frontend settings + wiring**
- Frontend "Sesli AI" settings surface (provider/flag status, bridge URL, NetGSM IVR URL) + i18n (tr/en).

**Cross-cutting wiring checklist (do as each phase lands):**
- Register every new controller/service/gateway in `marketing.module.ts`.
- Add new env vars to `backend/.env.example`.
- Add credit-cost entries to `ai/ai-credit-costs.ts` for `voice.analysis` and `voice.copilot`.

---

## Phase 0 — Config + STT foundation

### Task 0.1: Voice-AI env gates + capability resolver

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/voice-ai.config.ts`
- Test: `backend/src/modules/marketing/voice-ai/voice-ai.config.spec.ts`

- [ ] **Step 1: Write the failing test**
```typescript
import { isSttConfigured, isVoiceBridgeConfigured, isNetgsmIvrConfigured, voiceAiPublicStatus } from './voice-ai.config';

describe('voice-ai.config', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterAll(() => { process.env = OLD; });

  it('isSttConfigured true only with provider + key', () => {
    delete process.env.STT_PROVIDER; delete process.env.STT_API_KEY;
    expect(isSttConfigured()).toBe(false);
    process.env.STT_PROVIDER = 'deepgram'; process.env.STT_API_KEY = 'k';
    expect(isSttConfigured()).toBe(true);
  });

  it('isVoiceBridgeConfigured gates on shared secret', () => {
    delete process.env.VOICE_AI_BRIDGE_SECRET;
    expect(isVoiceBridgeConfigured()).toBe(false);
    process.env.VOICE_AI_BRIDGE_SECRET = 's';
    expect(isVoiceBridgeConfigured()).toBe(true);
  });

  it('isNetgsmIvrConfigured gates on token', () => {
    delete process.env.NETGSM_IVR_TOKEN;
    expect(isNetgsmIvrConfigured()).toBe(false);
    process.env.NETGSM_IVR_TOKEN = 't';
    expect(isNetgsmIvrConfigured()).toBe(true);
  });

  it('voiceAiPublicStatus reflects flags', () => {
    process.env.STT_PROVIDER = 'deepgram'; process.env.STT_API_KEY = 'k';
    process.env.VOICE_AI_BRIDGE_SECRET = 's'; delete process.env.NETGSM_IVR_TOKEN;
    const s = voiceAiPublicStatus();
    expect(s).toEqual({ stt: true, bridge: true, netgsmIvr: false, copilot: true });
  });
});
```

- [ ] **Step 2: Run test, verify FAIL** — `cd backend && npx jest voice-ai.config -t "voice-ai.config"` → fail (module missing).

- [ ] **Step 3: Implement**
```typescript
// backend/src/modules/marketing/voice-ai/voice-ai.config.ts
/** Voice-AI feature gates. Everything inert until the operator sets the env. */
export function isSttConfigured(): boolean {
  return !!process.env.STT_PROVIDER?.trim() && !!process.env.STT_API_KEY?.trim();
}
/** Custom-LLM bridge (VAPI/Retell/ElevenLabs → our Claude). */
export function isVoiceBridgeConfigured(): boolean {
  return !!process.env.VOICE_AI_BRIDGE_SECRET?.trim();
}
/** NetGSM Özel-API inbound IVR webhook. */
export function isNetgsmIvrConfigured(): boolean {
  return !!process.env.NETGSM_IVR_TOKEN?.trim();
}
/** Copilot only needs STT (browser provides audio); no extra purchase. */
export function isCopilotConfigured(): boolean {
  return isSttConfigured();
}
export interface VoiceAiPublicStatus { stt: boolean; bridge: boolean; netgsmIvr: boolean; copilot: boolean; }
export function voiceAiPublicStatus(): VoiceAiPublicStatus {
  return { stt: isSttConfigured(), bridge: isVoiceBridgeConfigured(), netgsmIvr: isNetgsmIvrConfigured(), copilot: isCopilotConfigured() };
}
```

- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(voice-ai): env gates + capability resolver"`

### Task 0.2: STT provider-agnostic service (Deepgram + OpenAI prerecorded)

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/stt.service.ts`
- Test: `backend/src/modules/marketing/voice-ai/stt.service.spec.ts`

Design: one method `transcribeUrl(audioUrl, opts?)` returning `{ text, provider, language? }`. Provider chosen by `STT_PROVIDER` (`deepgram` | `openai`). Deepgram: `POST https://api.deepgram.com/v1/listen?url=...` (Bearer key). OpenAI: not URL-native → fetch the audio via safeFetch then `POST https://api.openai.com/v1/audio/transcriptions` (multipart). Use `safeFetch` for all calls. Returns `null` text-safe on failure (never throws to caller-cron).

- [ ] **Step 1: Write the failing test** (mock global fetch / safeFetch)
```typescript
import { SttService } from './stt.service';

describe('SttService', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, STT_PROVIDER: 'deepgram', STT_API_KEY: 'k' }; });
  afterAll(() => { process.env = OLD; });

  it('deepgram: parses transcript from response', async () => {
    const svc = new SttService();
    jest.spyOn<any, any>(svc as any, 'fetchJson').mockResolvedValue({
      results: { channels: [{ alternatives: [{ transcript: 'merhaba dünya' }] }] },
    });
    const r = await svc.transcribeUrl('https://x/rec.mp3');
    expect(r?.text).toBe('merhaba dünya');
    expect(r?.provider).toBe('deepgram');
  });

  it('returns null when not configured', async () => {
    delete process.env.STT_PROVIDER;
    const svc = new SttService();
    expect(await svc.transcribeUrl('https://x/rec.mp3')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL.**
- [ ] **Step 3: Implement** (Deepgram URL path + OpenAI multipart path; `fetchJson` private wraps `safeFetch`; `isSttConfigured()` guard returns null). Keep ≤120 lines, one responsibility.
- [ ] **Step 4: Run test, verify PASS.**
- [ ] **Step 5: Commit** — `feat(voice-ai): provider-agnostic STT service (deepgram/openai)`

---

## Phase 1 — Post-call analysis (#4)

### Task 1.1: `call_analyses` migration + model

**Files:**
- Create: `backend/prisma/migrations/20260625120000_call_analysis/migration.sql`
- Modify: `backend/prisma/schema.prisma` (add model + relation-free, indexed by salesCallId)

- [ ] **Step 1: Add model to schema.prisma**
```prisma
model CallAnalysis {
  id           String   @id @default(uuid())
  workspaceId  String
  salesCallId  String   @unique
  transcript   String   @db.Text
  language     String?
  summary      String   @db.Text
  sentiment    String?  // POSITIVE | NEUTRAL | NEGATIVE
  score        Int?     // 0-100 call-quality/intent score
  actionItems  Json?    // string[]
  topics       Json?    // string[]
  sttProvider  String?
  createdAt    DateTime @default(now())
  @@index([workspaceId, createdAt])
  @@map("call_analyses")
}
```
- [ ] **Step 2: Write migration SQL** (CREATE TABLE call_analyses + unique salesCallId + index). Mirror column types (TEXT, JSONB, INTEGER).
- [ ] **Step 3: Verify parity** — `cd backend && npx prisma generate` then build. (Real-DB parity check runs in CI.)
- [ ] **Step 4: Commit** — `feat(voice-ai): call_analyses model + migration`

### Task 1.2: CallAnalysisService (recording → STT → Claude → persist)

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/call-analysis.service.ts`
- Test: `backend/src/modules/marketing/voice-ai/call-analysis.service.spec.ts`

Method: `analyzeSalesCall(salesCallId): Promise<{ status: 'OK'|'SKIPPED'|'FAILED'; reason?: string }>`.
Flow: load SalesCall (must have recordingUrl, workspaceId); if already has CallAnalysis → SKIPPED; `stt.transcribeUrl(recordingUrl)`; if no text → FAILED; `credits.reserve(workspaceId, creditCost('voice.analysis'))`; call `anthropic.complete` with a system prompt asking for STRICT JSON `{summary, sentiment, score, actionItems[], topics[]}` (tier 'default', maxTokens 600); parse JSON tolerant; upsert CallAnalysis; on Claude/parse error → `credits.refund` + FAILED.

- [ ] **Step 1: Write failing test** — mock prisma, stt, anthropic, credits; assert upsert payload + SKIPPED when analysis exists + FAILED when no transcript + refund on Claude throw.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Tolerant JSON parse (strip ```json fences; fall back to `{summary:text}`).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `feat(voice-ai): post-call analysis service`

### Task 1.3: Analysis cron sweep

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/call-analysis.cron.ts`
- Test: `backend/src/modules/marketing/voice-ai/call-analysis.cron.spec.ts`

`@Cron(CronExpression.EVERY_30_MINUTES, { name: 'call-analysis-sweep' })` wrapped in `withAdvisoryLock(prisma, 'voice:call-analysis', ...)`. Inert-guard: `if (!isSttConfigured() || !anthropic.isEnabled()) return;`. Query SalesCalls with `recordingUrl != null`, `status='CONNECTED'`, no CallAnalysis (left-join / NOT IN subquery), `endedAt` last 7 days, cap 25/run; call `analyzeSalesCall` each, swallow per-row errors.

- [ ] Steps 1-5 (test the inert-guard + that it calls analyze per due row; commit `feat(voice-ai): analysis cron sweep`).

### Task 1.4: `GET /marketing/calls/:id/analysis`

**Files:**
- Modify: `backend/src/modules/marketing/controllers/sales-call.controller.ts`
- Test: extend existing sales-call controller spec (or new `call-analysis.controller.spec.ts`)

Workspace-scoped read: returns CallAnalysis for the SalesCall or `{ status: 'NONE' }`. Add a `POST /calls/:id/analysis/run` (MANAGER + settings.manage) to trigger `analyzeSalesCall` on demand (diagnostic/manual).

- [ ] Steps 1-5 (commit `feat(voice-ai): call analysis read + manual-run endpoints`).

### Task 1.5: Frontend — analysis panel + i18n

**Files:**
- Modify: the call/lead timeline component that shows SalesCall (locate via `recordingUrl` usage in `frontend/src`).
- Create: `frontend/src/pages/marketing/.../CallAnalysisPanel.tsx`
- Modify: `frontend/src/i18n/locales/{tr,en}/marketing.json`

Render summary, sentiment chip, score, action items, topics; "Analiz et" button calling the run endpoint; hide entirely when status NONE and feature off. tsc + vitest green.

- [ ] Steps 1-5 (commit `feat(voice-ai): call analysis UI`).

---

## Phase 2 — Custom-LLM bridge (brain = Claude) (#1b/#2)

### Task 2.1: VoiceAiBridgeService — OpenAI↔Claude

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/voice-ai-bridge.service.ts`
- Test: `voice-ai-bridge.service.spec.ts`

Method: `complete(channel, openAiBody): Promise<OpenAiChatCompletion>`. Map OpenAI `messages[]` → Claude (system from AgentProfile persona+guardrails+language + KB snippets from the last user message via `knowledge.search`; user/assistant turns mapped). Call `anthropic.complete({system, messages, maxTokens:160, tier:'conversation'})`. Wrap reply in OpenAI response shape `{ id, object:'chat.completion', choices:[{message:{role:'assistant',content}}], usage }`. Record VoiceCall (by a call-id header if provided) + VoiceTranscript turns. Reserve/refund `voice.turn` credit.

- [ ] Steps 1-5 — test the mapping (system contains persona + KB; output OpenAI-shaped). Commit `feat(voice-ai): OpenAI-compatible Claude bridge service`.

### Task 2.2: VoiceAiBridgeController — public endpoint + auth + streaming

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/voice-ai-bridge.controller.ts`
- Test: `voice-ai-bridge.controller.spec.ts`

`@Controller('public/voice-ai')`. `POST /llm/:channelId/chat/completions`. Auth: `Authorization: Bearer <VOICE_AI_BRIDGE_SECRET>` (timing-safe compare; 401 otherwise) — gate with `isVoiceBridgeConfigured()` (404/inert if unset). Resolve channel by id (type VOICE). Non-stream JSON now; if body.stream true → SSE chunks (`data: {...}\n\n` + `data: [DONE]`) using `anthropic.streamText`. Throttle.

- [ ] Steps 1-5 — test 401 on bad bearer, 200 + OpenAI shape on good. Commit `feat(voice-ai): custom-LLM bridge endpoint (VAPI/Retell/ElevenLabs)`.

---

## Phase 3 — NetGSM Özel-API inbound IVR (#1 lite, TTS robot)

### Task 3.1: NetgsmIvrService — build `{status,result,data}`

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/netgsm-ivr.service.ts`
- Test: `netgsm-ivr.service.spec.ts`

Input: `{ arayan_no, santral_no, aranan_no, arama_id, tus_bilgisi? }`. Resolve VOICE channel by `aranan_no`/`santral_no` (externalId). Load AgentProfile. Build a short reply via Claude (the customer turn = a synthetic prompt since NetGSM gives DTMF only, not speech): on first hit (no `tus_bilgisi`) → greeting `data` + a small DTMF menu (`result` codes); on a digit → Claude-generated info text or `result:'dynamic'` + `redirect` for human handoff. Record VoiceCall/VoiceTranscript keyed on `arama_id`. Reserve `voice.turn`. Return `{ status:'success', result, data }`.

- [ ] Steps 1-5 — test greeting on first hit, dynamic-redirect on handoff digit. Commit `feat(voice-ai): NetGSM Özel-API IVR service (TTS robot)`.

### Task 3.2: NetgsmIvrController — public webhook + token

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/netgsm-ivr.controller.ts`
- Test: `netgsm-ivr.controller.spec.ts`

`@Controller('public/telephony/netgsm-ivr')`. `POST /:token` — compare `:token` timing-safe to `NETGSM_IVR_TOKEN`; inert (404) when `!isNetgsmIvrConfigured()`. Accept GET-style query OR JSON/form body (NetGSM supports GET/POST/JSON/XML — handle `@Body()` + `@Query()` merge). Return the service's JSON. Throttle.

- [ ] Steps 1-5 — test token reject (403) + happy path JSON. Commit `feat(voice-ai): NetGSM IVR public webhook`.

---

## Phase 4 — Live copilot (#3)

### Task 4.1: add `ws` dep + CopilotService

**Files:**
- Modify: `backend/package.json` (add `ws` + `@types/ws`; `@nestjs/websockets` + `@nestjs/platform-ws` if not present).
- Create: `backend/src/modules/marketing/voice-ai/copilot.service.ts`
- Test: `copilot.service.spec.ts`

CopilotService: stateless helpers — `suggest(workspaceId, agent, transcriptSoFar): Promise<{suggestions:string[]; summary?:string}>` via Claude (tier 'conversation', maxTokens 200, KB grounded). Reserve `voice.copilot` credit per suggestion batch.

- [ ] Steps 1-5 — test suggest returns parsed suggestions. Commit `feat(voice-ai): copilot suggestion service`.

### Task 4.2: CopilotGateway — WS audio→STT→suggest

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/copilot.gateway.ts`
- Test: `copilot.gateway.spec.ts` (unit-test message handlers, not socket transport)

`@WebSocketGateway({ path: '/ws/voice-copilot' })`, inert if `!isCopilotConfigured()`. Auth handshake: first message `{ type:'auth', jwt }` → verify workspace (reuse the app JWT verify util). Client sends `{type:'transcript', text}` chunks (browser does interim STT via Web Speech API OR sends audio → we STT). Server batches transcript, calls `copilot.suggest`, emits `{type:'suggestion', suggestions, summary}`. Keep transport thin; logic in service.

- [ ] Steps 1-5 — test the handler dispatch + auth gate. Commit `feat(voice-ai): live copilot WS gateway`.

### Task 4.3: Frontend copilot panel

**Files:**
- Create: `frontend/src/features/marketing/webphone/CopilotPanel.tsx`
- Modify: webphone host to mount panel during an active call; use browser `webkitSpeechRecognition` (interim transcript) → WS; render suggestions.
- i18n tr/en.

- [ ] Steps 1-5 — tsc + vitest green. Commit `feat(voice-ai): copilot panel UI`.

---

## Phase 5 — Frontend settings + wiring

### Task 5.1: "Sesli AI" settings surface + status endpoint

**Files:**
- Create: `backend/src/modules/marketing/voice-ai/voice-ai-status.controller.ts` — `GET /marketing/voice-ai/status` → `voiceAiPublicStatus()` + the bridge URL template + NetGSM IVR URL template (no secrets).
- Create: `frontend/src/pages/marketing/settings/VoiceAiSettings.tsx` — shows each capability flag (on/off), copy-able bridge URL (`${PUBLIC_BASE_URL}/api/public/voice-ai/llm/{channelId}/chat/completions`) + NetGSM IVR URL, and a short "what to buy to enable" note per row.
- i18n tr/en. Tests: controller spec + vitest.

- [ ] Steps 1-5. Commit `feat(voice-ai): settings surface + status endpoint`.

### Task 5.2: Module registration + .env.example + credit costs

**Files:**
- Modify: `backend/src/modules/marketing/marketing.module.ts` — register all new controllers (VoiceAiBridge, NetgsmIvr, VoiceAiStatus, call-analysis read) + providers (Stt, CallAnalysis, CallAnalysisCron, VoiceAiBridge, NetgsmIvr, Copilot, CopilotGateway).
- Modify: `backend/.env.example` — `STT_PROVIDER`, `STT_API_KEY`, `VOICE_AI_BRIDGE_SECRET`, `NETGSM_IVR_TOKEN` (+ comments: which NetGSM add-on each needs).
- Modify: `backend/src/modules/marketing/ai/ai-credit-costs.ts` — add `'voice.analysis': {credits:3, tier:'default'}`, `'voice.copilot': {credits:1, tier:'conversation'}`.

- [ ] Step: After registration, `cd backend && npx tsc --noEmit && npm run build` green; run full targeted jest for `voice-ai`. Commit `feat(voice-ai): register module + env.example + credit costs`.

---

## Self-Review Notes
- **Spec coverage:** #4 post-call → Phase 1; #1 inbound (lite) → Phase 3; #1b/#2 brain → Phase 2; #3 copilot → Phase 4; settings/inert-ness → Phase 0+5. ✓
- **No purchase needed to ship:** every entrypoint inert via `is*Configured()` (STT key, bridge secret, IVR token) — matches user's "satın almaları sonra yaparım". ✓
- **Type consistency:** `analyzeSalesCall` / `transcribeUrl` / `voiceAiPublicStatus` names reused verbatim across tasks. ✓
- **Recordings caveat:** Phase 1 only produces output once recordings exist (needs NetGSM Görüşme Kaydı + `NETGSM_RECORDING_BASE_URL`); code + tests complete now with mocks. Documented.
