# MCP Faz 3 — OAuth 2.1 Authorization Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jeeta'yı MCP için bir OAuth 2.1 authorization server'ı hâline getirmek; böylece Claude.ai / Claude Desktop connector'ü (kullanıcı-bağlı, PKCE'li, scope-onaylı) açılır ve API-key yolundaki "kullanıcı principal'ı yok" açığı kapanır.

**Architecture:** Yeni `backend/src/modules/mcp-oauth/` modülü authorization server'ı (metadata + authorize + token + CIMD) barındırır. MCP transport'u DEĞİŞMEZ; tek dikiş `McpTokenVerifierService`'tir — token `mk_live_` ile başlıyorsa API-key yolu, aksi hâlde OAuth yolu. Broker'a hiç dokunulmaz (politika orada kalır). Consent ekranı mevcut login/JWT üstüne binen bir React sayfasıdır.

**Tech Stack:** NestJS + Prisma (Postgres) + jest (deep-mocked PrismaService) · React + Vite + vitest · `@modelcontextprotocol/server` v2 · RFC 9728 / 8414 / 8707 / 9207 / 7636 (PKCE) + CIMD.

---

## Kaynak

Tasarım: `docs/superpowers/specs/2026-07-28-mcp-connector-design.md` §5 (auth), §9 (hata yönetimi), §10 (test), §11 (fazlama).
Faz 1–2.5 (tamamlandı): `docs/superpowers/plans/2026-07-28-mcp-connector-faz1-2.md`, `docs/superpowers/plans/2026-07-29-mcp-write-surface-activation.md`.

## Faz 1–2'den devredilen (bu planda kapanır)

1. **Servis principal'ı** — `mcp/tools/leads.tools.ts:24` yorumu: API-key oturumunun kullanıcısı yok, satır-seviyesi görünürlük için sabit bir principal kullanılıyor. OAuth **kullanıcı-bağlı** olduğu için gerçek çağıran ile değiştirilecek (Task 8).
2. **Granüler scope'lar** — `mcp-scopes.ts` yalnızca eski `read`/`write` genişletmesini biliyor; OAuth token'ları scope'u consent'ten alacak.

## ⚠️ Uygulamadan ÖNCE doğrulanacak tuzaklar

1. **Global prefix.** `app.config.ts:101` `app.setGlobalPrefix('api')` — **istisnasız**. RFC 9728/8414 metadata'sı **kökte** yayınlanmalı (`https://host/.well-known/...`), `/api/.well-known/...` değil. `setGlobalPrefix('api', { exclude: [...] })` ile well-known route'ları hariç tut ve bunu bir testle kilitle.
2. **Canonical resource URI = `https://<host>/api/mcp`** (MCP endpoint'i global prefix'in altında — Faz 1-2 planı bunu açıkça düzeltti). RFC 9728 metadata yolu buna göre türetilir; uydurma.
3. **CIMD fetch'i `safeFetch` ile** (`backend/src/common/util/safe-fetch.ts`) — `client_id` bir dış URL, düz `fetch` SSRF açar.
4. **Token'lar hash'li saklanır** — `ApiKeysService`'in mevcut hash desenini birebir izle; ham token DB'ye yazılmaz.
5. **SDK imzaları kurulu pakete karşı doğrulanır** (`@modelcontextprotocol/server` v2), dokümandan tahmin edilmez.

---

## Task 1: Veri modeli + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260729120000_mcp_oauth/migration.sql` + `down.sql`

- [ ] **Step 1: Şemaya üç modeli ekle (additive)**

`McpOAuthClient` — CIMD cache: `id`, `clientId` (@unique, HTTPS URL), `clientName`, `redirectUris` (Json), `metadata` (Json?), `fetchedAt`, `expiresAt` (HTTP cache header'ından), timestamps. `@@map("mcp_oauth_clients")`.

`McpOAuthCode` — authorization code (tek kullanımlık, kısa ömürlü): `id`, `codeHash` (@unique), `clientId`, `workspaceId`, `userId`, `redirectUri`, `scopes` (String[]), `resource` (audience), `codeChallenge`, `codeChallengeMethod` (yalnız `S256`), `expiresAt`, `consumedAt` (DateTime?), `createdAt`. `@@index([workspaceId])`.

`McpOAuthToken` — access + refresh: `id`, `tokenHash` (@unique), `type` (`ACCESS`|`REFRESH`), `clientId`, `workspaceId`, `userId`, `scopes` (String[]), `resource`, `expiresAt`, `revokedAt` (DateTime?), `parentId` (String?, refresh rotasyonu için), `createdAt`. `@@index([workspaceId, type])`.

- [ ] **Step 2: Migration'ı elle yaz (up idempotent `IF NOT EXISTS`, down yalnız eklenen tabloları düşürür)** — proje konvansiyonu (§7: round-trip up→down→up doğrulanır).
- [ ] **Step 3: `npx prisma generate`; `npx tsc --noEmit` → 0 hata.**
- [ ] **Step 4: Commit** — `feat(mcp-oauth): data model for the OAuth authorization server`

## Task 2: Metadata endpoint'leri (RFC 9728 + RFC 8414)

**Files:**
- Create: `backend/src/modules/mcp-oauth/mcp-oauth-metadata.controller.ts` (+ `.spec.ts`)
- Modify: `backend/src/app.config.ts` (globalPrefix exclude)

- [ ] **Step 1: Testi önce yaz** — (a) protected-resource metadata `resource` alanı `https://<host>/api/mcp` döner, `authorization_servers` bizi gösterir, `scopes_supported` granüler listedir; (b) authorization-server metadata `issuer`, `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported: ['S256']`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true` içerir; (c) her iki yol da **kökte** servis edilir (`/api/` önekiyle DEĞİL).
- [ ] **Step 2: Controller'ı yaz** — `/.well-known/oauth-protected-resource/api/mcp` ve `/.well-known/oauth-authorization-server`. Host'u `PUBLIC_BASE_URL`'den türet (repo deseni).
- [ ] **Step 3: `setGlobalPrefix('api', { exclude: [...] })`** ile well-known route'larını hariç tut; mevcut route'ların bozulmadığını doğrula.
- [ ] **Step 4: Test yeşil + commit** — `feat(mcp-oauth): RFC 9728/8414 metadata endpoints at the root`

## Task 3: CIMD — Client ID Metadata Documents

**Files:** Create `backend/src/modules/mcp-oauth/cimd-client.service.ts` (+ `.spec.ts`)

- [ ] **Step 1: Test önce** — (a) `client_id` HTTPS URL değilse red; (b) çekilen dokümandaki `client_id` istenen URL ile **birebir** eşleşmiyorsa red; (c) `redirect_uris` içermiyorsa red; (d) başarılı çekim cache'lenir, `expiresAt` dolmadan tekrar fetch yapılmaz; (e) fetch `safeFetch` ile yapılır (mock'la doğrula) — SSRF korumalı.
- [ ] **Step 2: `resolveClient(clientId)` implementasyonu** — cache oku → yoksa/expired ise `safeFetch` → doğrula → `McpOAuthClient` upsert. HTTP cache header'larına (`Cache-Control: max-age`) saygı göster, yoksa makul varsayılan (örn. 1 saat).
- [ ] **Step 3: Test yeşil + commit** — `feat(mcp-oauth): CIMD client resolution with SSRF-safe fetch + cache`

## Task 4: `/oauth/authorize` — PKCE + consent

**Files:** Create `backend/src/modules/mcp-oauth/mcp-oauth-authorize.controller.ts`, `mcp-oauth-code.service.ts` (+ spec'ler)

- [ ] **Step 1: Test önce** — (a) `code_challenge` yoksa veya `code_challenge_method != S256` ise **red** (PKCE zorunlu); (b) `redirect_uri` CIMD'deki listede yoksa red; (c) `resource` parametresi bizim canonical URI'ye işaret etmiyorsa red (RFC 8707); (d) geçerli istek consent için gereken bilgiyi döner (client adı, scope listesi, workspace seçenekleri); (e) onaylanan istek tek kullanımlık code üretir, **hash'li** saklar, redirect'e `code` + `state` + **`iss`** (RFC 9207) ekler.
- [ ] **Step 2: Implementasyon** — GET `/api/mcp-oauth/authorize` (giriş yapılmamışsa mevcut login'e yönlendirir, dönüşte devam eder) → consent verisi; POST `/api/mcp-oauth/authorize/consent` (JWT korumalı) → code üretir. Kullanıcının o workspace'e üyeliği + scope'ları verme yetkisi **doğrulanır** (yetkisi olmayan scope verilemez).
- [ ] **Step 3: Test yeşil + commit** — `feat(mcp-oauth): authorize endpoint with mandatory PKCE + consent`

## Task 5: `/oauth/token` — code + refresh grant

**Files:** Create `backend/src/modules/mcp-oauth/mcp-oauth-token.controller.ts`, `mcp-oauth-token.service.ts` (+ spec'ler)

- [ ] **Step 1: Test önce** — (a) `code_verifier` challenge ile eşleşmiyorsa red; (b) code **tek kullanımlık** (ikinci kullanım red + o code'dan türeyen token'lar iptal); (c) süresi geçmiş code red; (d) `redirect_uri` code'daki ile eşleşmeli; (e) başarılı değişim access + refresh döner, ikisi de hash'li saklanır, `resource` (audience) token'a bağlanır; (f) refresh grant **rotasyonlu** (eski refresh iptal, `parentId` zinciri); (g) iptal edilmiş refresh'in yeniden kullanımı tüm zinciri iptal eder.
- [ ] **Step 2: Implementasyon** — POST `/api/mcp-oauth/token`, `grant_type` ∈ `authorization_code` | `refresh_token`. Access TTL kısa (örn. 1 saat), refresh uzun (örn. 30 gün).
- [ ] **Step 3: Test yeşil + commit** — `feat(mcp-oauth): token endpoint (authorization_code + rotating refresh)`

## Task 6: Token doğrulama + MCP transport entegrasyonu

**Files:** Modify `backend/src/modules/marketing/mcp/mcp-token-verifier.service.ts` (+ spec), `mcp.controller.ts` (+ spec)

- [ ] **Step 1: Test önce** — (a) `mk_live_…` → mevcut API-key yolu (regresyon: eski davranış bozulmaz); (b) OAuth access token → `AuthInfo`'ya çözülür, `extra` içinde **`userId`** taşır; (c) süresi geçmiş/iptal edilmiş token 401; (d) **audience uyuşmazlığı** (token'ın `resource`'u bize işaret etmiyor) 401; (e) 401 yanıtı `WWW-Authenticate: Bearer resource_metadata="…"` challenge'ı taşır; (f) yetersiz scope 403 + `error="insufficient_scope"`.
- [ ] **Step 2: Implementasyon** — verifier'da iki yol; controller'da RFC 6750 challenge'ları. **Broker'a dokunma.**
- [ ] **Step 3: Test yeşil + commit** — `feat(mcp-oauth): accept OAuth tokens on the MCP transport with audience + scope challenges`

## Task 7: Consent ekranı (frontend)

**Files:** Create `frontend/src/pages/marketing/oauth/McpConsentPage.tsx` (+ test), route kaydı `App.tsx`, i18n `en`+`tr`

- [ ] **Step 1: Test önce** — sayfa client adını, istenen scope'ları ve workspace seçicisini gösterir; "İzin ver" consent POST'unu doğru gövdeyle çağırır; "Reddet" redirect'e `error=access_denied` ile döner.
- [ ] **Step 2: Implementasyon** — mevcut auth guard'ının arkasında; scope'ları insan-okur etiketlerle listeler (örn. `leads.read` → "Lead'lerini okuma"). Repo'nun i18n + UI kit desenini izle.
- [ ] **Step 3: Test yeşil + commit** — `feat(mcp-oauth): consent screen`

## Task 8: Gerçek kullanıcı principal'ı (devredilen borç)

**Files:** Modify `backend/src/modules/marketing/mcp/tools/leads.tools.ts` (+ spec), gerekiyorsa `mcp-server.factory.ts` (context'e `userId` taşı)

- [ ] **Step 1: Test önce** — OAuth oturumunda `findAll` **gerçek** `userId`/rol ile çağrılır (satır-seviyesi görünürlük uygulanır); API-key oturumunda mevcut açıkça-adlandırılmış servis principal'ı korunur (regresyon).
- [ ] **Step 2: Implementasyon** — `McpToolContext`'e `userId` ekle; leads tool'u varsa gerçek kullanıcıyı kullansın. Yorumu güncelle (artık "Faz 3 çözecek" değil, "Faz 3 çözdü").
- [ ] **Step 3: Test yeşil + commit** — `fix(mcp): use the real OAuth user for row-level lead visibility`

## Task 9: Modül kaydı, e2e ve dokümantasyon

- [ ] **Step 1:** `McpOAuthModule`'ü `app.module.ts`'e bağla (Faz 1-2'de MCP marketing modülüne **flat** kayıtlıydı — DI kırılmasın diye o deseni doğrula).
- [ ] **Step 2: e2e testi** — metadata şekli, PKCE zorunluluğu, yanlış audience reddi, CIMD `client_id ≠ URL` reddi (tasarım §10).
- [ ] **Step 3:** `npx jest mcp` tamamı yeşil; `npx tsc --noEmit` 0; `npx jest authz.e2e` (DI boot) yeşil.
- [ ] **Step 4: Dokümantasyon** — `docs/` altına connector kurulum notu: Claude.ai/Desktop'a `https://jeetagrowth.com/api/mcp` eklerken akışın nasıl işlediği + smoke-test komutları.
- [ ] **Step 5: Commit** — `docs(mcp-oauth): Faz 3 wiring, e2e coverage and connector setup guide`

---

## Kapsam dışı (tasarım §12 ile aynı)

DCR (RFC 7591) yazılmaz — CIMD yeterli · MCP resources/prompts primitifleri · Faz 4 yönetim UI'ı (bağlı istemciler / oturum-denetim görünümü / mod toggle'ı) ayrı planlanır.

## Tamamlanma kriteri

- Claude.ai / Desktop, `https://jeetagrowth.com/api/mcp` adresini connector olarak ekleyip OAuth ile bağlanabiliyor; consent ekranında workspace + scope onaylanıyor.
- Mevcut `mk_live_…` API-key yolu **bozulmadan** çalışmaya devam ediyor (regresyon testli).
- Her tool çağrısı denetim izli (Faz 1'in `AgentRun` kuralı korunur).
- OAuth oturumlarında lead görünürlüğü gerçek kullanıcıya göre uygulanıyor.
