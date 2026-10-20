# Görsel üretimi Codex'e: codex-media yan servisi, CodexMediaProvider, katalog, fal/Runware sökümü, video kararı

Tarih: 2026-10-21 · Yazan: Kerem (Teknik Lider) · Uygulayan: Selin (iki parça, paralel) · İnceleyen: Kerem
Taban: `origin/main` @ `a08d21a9` (tüm `dosya:satır` referansları bu commit'e göredir)
Sahibin kararı (20 Eki 2026): *Jeeta'da görsel üretimi yalnız Codex (ChatGPT aboneliği) üzerinden; fal.ai kullanılmayacak,
Jeeta o bağımlılıktan tamamen kurtarılacak.*

Kısaltmalar: `B` = `backend/src/modules/marketing`, `S` = `backend/prisma/schema.prisma`,
`P` = `B/ai/providers`, `M` = `B/ai/media`, `CC` = `D:\HDD\projects\control-center\apps\office-server\src\codex`.

---

## 0. Yerel deneme (kanıt) ve öğrenilenler

Codex CLI `0.162.1`, ChatGPT hesabı (`planType: prolite`), `codex app-server --listen stdio://`, JSON-RPC.
Deneme betikleri: `C:\Users\tarik\.control-center\desks\kerem\codex-trial\{trial.mjs,trial2.mjs,limits.mjs}`.

| # | Girdi | Sonuç | Süre | Dosya |
|---|---|---|---|---|
| 1 | Metin: "square 1:1 product photo, 15 cm hand-painted resin figurine…" | `imageGeneration` `completed`, 1254×1254 PNG, 1.37 MB | ilk turdan 16 s (süreç açılışı dahil 33 s) | `codex-trial/trial-1.png` |
| 2 | `localImage` (deneme 1'in çıktısı) + metin "keep the same figurine… vertical 9:16" | `completed`, 941×1672 PNG (oran 0.563 ≈ 9:16), figür korunmuş | 18 s (toplam 34 s) | `codex-trial/trial-2-edit-9x16.png` |
| 3 | `account/rateLimits/read` | `limitId: codex`, haftalık pencere (`windowDurationMins: 10080`), iki denemeden sonra `usedPercent: 1` | — | `limits.mjs` çıktısı |

Protokolden öğrenilenler (`codex app-server generate-ts` ile üretilen tiplerle doğrulandı):
- Akış: `initialize` → `initialized` → `account/read` → `thread/start {cwd, approvalPolicy, sandbox, ephemeral:true, config:{'features.image_generation':true}, developerInstructions}` → `turn/start {threadId, input:[…]}` → bildirimler → `turn/completed`.
- Girdi: `UserInput = {type:'text', text, text_elements:[]} | {type:'localImage', path} | {type:'image', url}`.
- Çıktı: `item/completed` içinde `ImageGenerationItem = { id, status, revisedPrompt, result /* base64, ~2.7 MB metin */, transparentBackground?, failure, savedPath? }`.
  `savedPath` = `~/.codex/generated_images/<threadId>/<itemId>.png` (2. denemede döndü). `result` base64 her zaman dolu → dosya yolu yoksa da çıkarılabilir.
- **Aspect parametresi yok**: oran yalnız istemle söyleniyor, model yaklaşık uyuyor (941×1672). Kesin oranı yan servis kırparak sağlar (§1.5).
- Thread açılışı kullanıcının `config.toml`'undaki MCP sunucularını/eklentilerini de başlatıyor (denemede `mcpServer/startupStatus` bildirimleri) → yan serviste hepsi kapatılmalı (§1.6).
- Kotalar: görseller ofisteki Codex çalışanlarıyla **aynı haftalık Codex kotasından** düşüyor (§7).

---

## 1. `codex-media` yan servisi

### 1.1 Yer ve çalışma biçimi

- Kod: kds-marketing reposunda yeni klasör **`codex-media/`** (kök; `local-inference/` gibi). Node 22, TypeScript, bağımlılıklar:
  `@aws-sdk/client-s3` (R2), `sharp` (kırpma). Express yok; `node:http` yeterli.
- Çalıştırma: Contabo'da **ayrı konteyner** `codex-media`, backend ile aynı docker ağında, **host'a port yayınlanmaz**
  (20 Eki güvenlik duvarı kararıyla uyumlu: dışarıdan yalnız 22/80). Backend `http://codex-media:7311` ile konuşur.
  Docker dışı (host'ta systemd) seçilirse dinleme adresi docker köprüsü (`172.17.0.1:7311`) olur ve iptables'ta yalnız backend konteynerine açılır —
  konteyner tercih edilir.
- Codex kimliği: kalıcı birim `codex-home:/home/codex/.codex` (`CODEX_HOME`); `auth.json` burada. Süreç ayrı, yetkisiz kullanıcı (`codex`, uid 10001) ile çalışır;
  `cwd` boş, salt-okunur bir geçici dizindir (`/work`, tmpfs).
- Tek uzun ömürlü `codex app-server --listen stdio://` süreci; her iş **ayrı ephemeral thread**. Süreç ölürse yeniden başlatılır
  (üstel bekleme 1 s → 60 s), o anda koşan işler `FAILED/CODEX_PROCESS_EXITED` olur.
- Kalıp: `CC/rpc.ts` (stdio JSON-RPC, istek zaman aşımı, süreç kapanınca bekleyenleri reddetme) ve `CC/normalize.ts:22-31`
  (`imageGeneration` öğesini okuma; base64'ü loga/olaya koymama). `CC/process.ts`'in oturum dosyası, MCP ve kapı mantığı **alınmaz**.

### 1.2 HTTP API

Tüm isteklerde `Authorization: Bearer <CODEX_MEDIA_SECRET>` (≥32 bayt rastgele; `crypto.timingSafeEqual` ile karşılaştırılır). Eksik/yanlış → `401 UNAUTHORIZED`.
Gövde JSON, ≤ 64 KB.

**`POST /generate`**
```http
POST /generate HTTP/1.1
Host: codex-media:7311
Authorization: Bearer 5f0c…(64 hex)
Content-Type: application/json

{
  "prompt": "Ahşap masada, hediye kutusunun yanında duran el boyaması 15 cm reçine figür; yumuşak gün ışığı.",
  "aspectRatio": "9:16",
  "referenceImages": ["https://media.jeetagrowth.com/social/ws-123/7a1e….png"],
  "workspaceId": "ws-123",
  "clientRef": "asset-5d2c…"
}
```
| Alan | Tip | Kural |
|---|---|---|
| `prompt` | string | 1..4000 karakter |
| `aspectRatio` | string? | `1:1` (varsayılan) `4:5` `3:4` `4:3` `9:16` `16:9` |
| `referenceImages` | string[]? | ≤ 4 URL, yalnız `https`, host `R2_PUBLIC_BASE_URL` host'u ya da `CODEX_MEDIA_REF_HOSTS` listesi; her biri ≤ 20 MB, `image/png|jpeg|webp` |
| `workspaceId` | string? | yalnız log ve R2 anahtar öneki için |
| `clientRef` | string? | ≤ 100; aynı `clientRef` ile 10 dk içinde ikinci istek **aynı `jobId`'yi** döner (idempotent) |

Yanıt `202`:
```json
{ "jobId": "cm_01J9ZK3V7Q8W2N4R6T", "status": "QUEUED", "position": 1 }
```

**`GET /jobs/:id`**
```json
{ "jobId": "cm_01J9ZK3V7Q8W2N4R6T", "status": "RUNNING", "startedAt": "2026-10-21T10:02:11.120Z" }
```
```json
{ "jobId": "cm_01J9ZK3V7Q8W2N4R6T", "status": "COMPLETED",
  "url": "https://media.jeetagrowth.com/codex-media/ws-123/cm_01J9ZK3V7Q8W2N4R6T.png",
  "mime": "image/png", "width": 1080, "height": 1920,
  "revisedPrompt": "A vertical 9:16 photograph of…", "durationMs": 18432 }
```
```json
{ "jobId": "cm_01J9ZK3V7Q8W2N4R6T", "status": "FAILED", "code": "CONTENT_BLOCKED", "message": "Codex refused the request: policy." }
```
`status`: `QUEUED | RUNNING | COMPLETED | FAILED`. İş kaydı bellekte tutulur, bitişten **1 saat** sonra silinir (backend'in yaşam sınırı `MEDIA_GEN_MAX_AGE_MS` = 1 sa, `M/media-gen.service.ts:671-677`).

**`GET /health`** (sır gerektirmez, yalnız iç ağ): `{ "ok": true, "codex": "ready" | "starting" | "auth_required" | "down", "queue": 0, "running": 1, "weeklyUsedPercent": 1 }`.

### 1.3 Hata kodları

| HTTP / `code` | Ne zaman | Backend eşlemesi (§2.3) |
|---|---|---|
| `401 UNAUTHORIZED` | sır yok/yanlış | `FAILED` + log (yapılandırma hatası) |
| `400 VALIDATION_FAILED` (`details[]`) | gövde kuralları | `FAILED` |
| `400 REFERENCE_FETCH_FAILED` | referans indirilemedi / boyut / tür / izinsiz host | `FAILED` |
| `404 JOB_NOT_FOUND` | bilinmeyen ya da süresi geçmiş iş (servis yeniden başladıysa da) | `FAILED` (iade) |
| `429 QUEUE_FULL` | kuyruk `CODEX_MEDIA_MAX_QUEUE` dolu | submit hatası → rezervasyon iadesi |
| `503 CODEX_AUTH_REQUIRED` | `account/read` → `requiresOpenaiAuth && !account` (ChatGPT oturumu düştü) | `isConfigured()` false değil, **submit 503** → `MEDIA_GEN_NOT_CONFIGURED` yolu |
| `503 CODEX_UNAVAILABLE` | app-server başlatılamıyor/çöktü | aynı |
| `503 CODEX_QUOTA_EXHAUSTED` | `error` bildirimi `usage limit` ya da `rateLimits.rateLimitReachedType` dolu; yanıtta `resetsAt` | aynı, mesajda sıfırlanma zamanı |
| iş `FAILED` / `CONTENT_BLOCKED` | `imageGeneration.failure` dolu ya da `status != completed` politika nedeniyle | `BLOCKED` |
| iş `FAILED` / `NO_IMAGE` | tur bitti ama hiç `imageGeneration` öğesi yok | `FAILED` |
| iş `FAILED` / `TIMEOUT` | `CODEX_MEDIA_JOB_TIMEOUT_MS` (180 000) aşıldı → `turn/interrupt` | `FAILED` |
| iş `FAILED` / `CODEX_PROCESS_EXITED` | iş sürerken süreç kapandı | `FAILED` |
| iş `FAILED` / `UPLOAD_FAILED` | R2 yüklemesi başarısız (3 deneme) | `FAILED` |

### 1.4 Eşzamanlılık, kuyruk, zaman aşımı

- `CODEX_MEDIA_CONCURRENCY` = **2** eşzamanlı thread; `CODEX_MEDIA_MAX_QUEUE` = **20**; FIFO.
- İş zaman aşımı 180 s; JSON-RPC istek zaman aşımı 60 s (`CC/rpc.ts:65` kalıbı).
- Backend tarafında da üst sınır var: `MEDIA_GEN_MAX_INFLIGHT` = 4 çalışma alanı başına (`M/media-gen.service.ts:480-485`).
- Ölçülen süre ~16-18 s/görsel → 2 paralel ile ~6-7 görsel/dk tavan.

### 1.5 İş akışı (tek iş)

1. Referansları indir (`https`, host izni, ≤ 20 MB, tür kontrolü) → `/work/<jobId>/ref-N.<ext>`.
2. `thread/start` (§1.6 ayarlarıyla) → `turn/start` girdisi: her referans için `{type:'localImage', path}` + `{type:'text', text: <şablon>}`.
   Şablon: `"<prompt>\n\nOutput: exactly one image, aspect ratio <aspectRatio> (<W>x<H> framing). " + (ref ? "Use the attached reference image(s) as the subject; keep it recognisable." : "")`.
3. `item/completed` + `type: 'imageGeneration'`: `failure` → `CONTENT_BLOCKED`; yoksa `savedPath` dosyasını, o yoksa `result` base64'ü oku.
   Birden çok görsel gelirse ilki alınır.
4. `sharp` ile **orta kırpma** hedef orana (sapma > %1 ise), uzun kenar ≤ 2048; PNG olarak bırak. (9:16 → 1080×1920'ye ölçekle.)
5. R2'ye yükle: anahtar `codex-media/<workspaceId|_>/<jobId>.png`, `ContentType: image/png`, `CacheControl: public, max-age=86400`.
   Ortam: mevcut `R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL` (aynı adlar, `backend/src/common/storage/r2-storage.service.ts:66-80`).
   Bu geçici kopyadır: backend `finalizeAsset` dosyayı çalışma alanı anahtarına yeniden yükler (`M/media-gen.service.ts:696-698`). Yan servis
   `codex-media/` önekindeki 24 saatten eski nesneleri saatlik siler (ya da R2 yaşam döngüsü kuralı — koordinatör seçer).
6. `savedPath` dosyasını ve `/work/<jobId>`'yi sil (ChatGPT tarafında saklanan kopya bizim kontrolümüzde değil, §7).

### 1.6 Codex thread ayarları (güvenlik)

İstem metni müşteriden/yapay zekâdan gelir → Codex ajanının komut çalıştırması, dosya okuması ya da dış araç kullanması **engellenir**:
```ts
thread/start {
  cwd: '/work/<jobId>', ephemeral: true,
  approvalPolicy: 'untrusted',          // her komut onay ister …
  sandbox: 'read-only',
  config: {
    'features.image_generation': true,
    'features.apps': false, 'features.multi_agent': false, 'features.plugins': false, 'features.memories': false,
    'web_search': 'disabled',
    // + config/read ile okunan her mcp_servers.<ad>.enabled=false, plugins.<ad>.enabled=false (CC/process.ts:99-103 kalıbı)
  },
  developerInstructions: 'You are an image generation backend. Call the image generation tool exactly once. Never run commands, read files or browse. Reply only with DONE.'
}
```
- Sunucudan gelen her istek (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `mcpServer/elicitation/request`, `item/tool/requestUserInput`) **reddedilir** (`decline` / boş izin) — `CC/process.ts:220-233` kalıbı, kapı yok.
- Bir turda `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch` öğesi **başlarsa** iş `FAILED/POLICY_VIOLATION` yapılır, `turn/interrupt` gönderilir ve sayaç loglanır.
- `revisedPrompt` ve ajan metni yalnız yanıtta döner; loga yalnız ilk 200 karakter.

### 1.7 Ortam değişkenleri (yan servis)

| Değişken | Varsayılan | Not |
|---|---|---|
| `CODEX_MEDIA_SECRET` | — (zorunlu) | backend ile paylaşılan sır |
| `CODEX_MEDIA_PORT` | `7311` | |
| `CODEX_MEDIA_CONCURRENCY` | `2` | |
| `CODEX_MEDIA_MAX_QUEUE` | `20` | |
| `CODEX_MEDIA_JOB_TIMEOUT_MS` | `180000` | |
| `CODEX_MEDIA_REF_HOSTS` | `R2_PUBLIC_BASE_URL` host'u | virgüllü ek izinli host |
| `CODEX_MEDIA_MODEL` | boş (hesabın varsayılanı) | denemede `gpt-6.1-sol` |
| `CODEX_HOME` | `/home/codex/.codex` | `auth.json` burada |
| `R2_*` | backend ile aynı | |

### 1.8 ChatGPT girişi (device-auth)

Sunucuda tarayıcı yok: `docker compose run --rm codex-media codex login --device-auth` → çıkan kodu sahibi kendi tarayıcısında onaylar.
`codex login status` ile doğrulanır. Bu adım **sahibinin hesabıyla** yapılır (koordinatör yürütür, sahibi onaylar). Oturum düşünce
`/health` → `auth_required`, istekler `503 CODEX_AUTH_REQUIRED`; backend bunu admin bildirimi olarak yüzeye çıkarır (§2.3).

---

## 2. `CodexMediaProvider`

### 2.1 Dosya ve arayüz

- Yeni: `P/codex.provider.ts`, `MediaProvider` arayüzünü uygular (`P/media-provider.interface.ts:59-67`):
  ```ts
  @Injectable()
  export class CodexMediaProvider implements MediaProvider {
    readonly name = 'codex';
    isConfigured(): boolean            // CODEX_MEDIA_URL && CODEX_MEDIA_SECRET dolu
    submit(o: MediaGenSubmit)          // POST /generate → { providerRequestId: `codex:${jobId}` }
    getResult(requestId, model)        // GET /jobs/:id → MediaGenResult
  }
  export const CODEX_REQUEST_PREFIX = 'codex:';
  ```
- `submit` eşlemesi: `prompt` ← `o.prompt` (+ `o.negativePrompt` varsa `"\n\nAvoid: …"`), `aspectRatio` ← `o.aspectRatio ?? '1:1'`,
  `referenceImages` ← `o.sources?.images ?? []` (≤ 4; fazlası 400), `workspaceId`, `clientRef` = asset id (`MediaGenSubmit`'e
  `clientRef?: string` eklenir; `M/media-gen.service.ts` asset id'yi geçer). `type !== 'IMAGE'` → `BadRequestException` (savunma; katalog zaten engeller).
  `webhookUrl` yok sayılır (yalnız yoklama).
- Zaman aşımı: `CODEX_MEDIA_HTTP_TIMEOUT_MS` = 15 000 (yalnız HTTP; iş süresi yoklamayla izlenir).
- `costUsd` dönmez (abonelik; §3).

### 2.2 Yönlendirme

- `P/routing.provider.ts`, `P/fal.provider.ts`, `P/runware.provider.ts` **silinir**. `B/marketing.module.ts:484-487` importları ve `:1358-1364`:
  ```ts
  CodexMediaProvider,
  { provide: MEDIA_PROVIDER, useExisting: CodexMediaProvider },
  MediaGenService,
  ```
- `resolveName` tanımlanmaz → `M/media-gen.service.ts:582` `provider.name` = `'codex'` yazar.
- Yayın anında uçuşta kalan eski işler: `getResult` öneki `codex:` olmayan id için `{ status: 'FAILED', error: 'Önceki görsel sağlayıcısı kaldırıldı; kredi iade edildi.' }` döner
  → mevcut `failTerminal` + iade yolu (`M/media-gen.service.ts:770-783`).
- `M/media-gen.service.ts:720` (`vendor = asset.provider==='runware' ? 'runware' : 'fal'`) ve `B/budget/media-spend.service.ts:49-67`:
  `provider === 'codex'` → **vendor ledger'a satır yazılmaz** (`MediaSpendService.settle` erken döner; maliyet sabit abonelik).

### 2.3 Durum eşlemesi

| codex-media | `MediaGenResult` |
|---|---|
| `QUEUED` | `IN_QUEUE` |
| `RUNNING` | `IN_PROGRESS` |
| `COMPLETED` | `COMPLETED`, `outputs: [{ url, mime, width, height }]` |
| `FAILED` + `CONTENT_BLOCKED` / `POLICY_VIOLATION` | `BLOCKED`, `error: message` |
| `FAILED` diğer | `FAILED`, `error: "<code>: <message>"` |
| HTTP `404 JOB_NOT_FOUND` | `FAILED` |
| HTTP 5xx / ağ hatası (yoklama) | `IN_PROGRESS` (geçici; backend 1 sa yaş sınırıyla keser) |
| submit HTTP `503 CODEX_*` | `ServiceUnavailableException({ code: 'MEDIA_GEN_NOT_CONFIGURED', reason: <code>, resetsAt? })` → rezervasyon iadesi; `CODEX_AUTH_REQUIRED` ise platform yöneticisine bildirim (`notifyCommerce` değil, mevcut admin-alert yolu) |
| submit `429 QUEUE_FULL` | `ServiceUnavailableException({ code: 'MEDIA_GEN_BUSY' })` |

`finalizeAsset`'in indirme koruması (`M/media-gen.service.ts:890-932`, yalnız https + engelli host listesi) R2 genel URL'sine izin verir — değişiklik gerekmez.

### 2.4 Ortam değişkenleri (backend)

`CODEX_MEDIA_URL=http://codex-media:7311`, `CODEX_MEDIA_SECRET=…`, `CODEX_MEDIA_HTTP_TIMEOUT_MS` (isteğe bağlı).
`backend/.env.example:463-469` fal/Runware bloğu bunlarla değiştirilir; `.github/workflows/deploy.yml` aynı satırlarda (§5).
`B/ai/ai-job-settings.service.ts:47-48`: `media.*` için `api = !!(process.env.CODEX_MEDIA_URL && process.env.CODEX_MEDIA_SECRET)`.

---

## 3. Katalog ve kredi

### 3.1 Tek görsel modeli: `codex:image`

`M/media-models.config.ts` `MEDIA_MODELS` (`:440`) yeniden yazılır; **yalnız**:
```ts
'codex:image': {
  id: 'codex:image',
  technique: 'IMAGE_CREATE',
  type: 'IMAGE',
  label: 'Codex Görsel (ChatGPT)',
  priceUsd: 0,
  credits: 2,
  contract: {
    promptParam: 'prompt',
    negativePrompt: true,                      // provider istem sonuna "Avoid:" ekler
    aspect: { param: 'aspect_ratio', values: { '1:1': '1:1', '4:5': '4:5', '3:4': '3:4', '4:3': '4:3', '9:16': '9:16', '16:9': '16:9' } },
    sources: [{ slot: 'images', param: 'referenceImages', arity: 'array', required: false, maxCount: 4 }],
  },
  note: 'ChatGPT aboneliği üzerinden Codex; görsel başına satıcı maliyeti yok. Kredi kötüye kullanımı ve kotayı dengelemek için sabit 2.',
},
```
- **Oluşturma + düzenleme tek modelde**: `sources.images` isteğe bağlı. `listMediaModels('IMAGE_EDIT')` (`M/media-models.config.ts:1514-1517`)
  referans kabul eden modelleri de döndürecek şekilde genişletilir (`mediaModelAcceptsReferenceImages`, `:1405`) → stüdyonun Düzenle kartı da `codex:image`'ı görür.
- Sabitler (`:304-318`, `:1448`): `DEFAULT_IMAGE_MODEL = DEFAULT_KEYFRAME_MODEL = DEFAULT_KEYFRAME_REFERENCE_MODEL = 'codex:image'`.
  `DEFAULT_VIDEO_MODEL`, `DEFAULT_VIDEO_ANIMATE_MODEL`, `DEFAULT_AUDIO_MODEL`, `DEFAULT_VIDEO_REFERENCE_MODEL`, `RETIRED_SEEDANCE_LITE_MODEL` **silinir**;
  `defaultModelFor('VIDEO'|'AUDIO')` (`:1502`) `null` döner (imza `string | null`).
- `MediaVendor`, `RunwareBinding`, `runware?`, `estimateVendorUsd` (`:248-259`, `:287`, `:1592-1615`) ve `SEEDANCE_25_RUNWARE` (`:361-363`) silinir.
  `MediaModel.id` belgesi (`:262`) "katalog kimliği; sağlayıcı `codex`" olur.
- Kredi: `estimateMediaCredits('codex:image')` = 2; `estimateMediaUsd` = 0. `B/ai/ai-credit-costs.ts:80` `'media.image.generate'` taban kredisi **3 → 2**.
  Tek kredi ≈ $0.01 kuralı (`creditsForUsd`, `:1254`) codex için devre dışı: sabit kredi. `FALLBACK_IMAGE_CREDITS` (`:1159`) 2.

### 3.2 Eski kimlikler (saklı değerler)

`workspaces.defaultImageModel/defaultVideoModel` (`S:163-164`) ve `social_campaigns.defaultImageModel/defaultVideoModel` (`S:4045-4046`),
`generated_assets.model/provider` eski fal kimliklerini taşır. fal girdilerini katalogda tutmak yerine:
- `M/media-models.config.ts`'e `LEGACY_IMAGE_MODEL_IDS: ReadonlySet<string>` (34 eski kimlikten IMAGE olanlar, yorum: "fal'dan kalan; okunduğunda codex:image'a çözülür").
  `resolveMediaModelId` (`:1311`) bu kümedeki kimliği `'codex:image'`'a çözer. VIDEO/AUDIO eski kimlikleri bilinmeyen kimlik gibi davranır → §4'teki 422.
- Veri göçü **`20261021120000_codex_media_defaults`** (geri alınabilir):
  ```sql
  -- up
  CREATE SCHEMA IF NOT EXISTS "codex_media_backup";   -- public dışında: prisma migrate diff yalnız public'i karşılaştırır
  CREATE TABLE IF NOT EXISTS "codex_media_backup"."defaults" (tbl text, id text, "defaultImageModel" text, "defaultVideoModel" text);
  INSERT INTO "codex_media_backup"."defaults" SELECT 'workspaces', id, "defaultImageModel", "defaultVideoModel" FROM "workspaces"
    WHERE "defaultImageModel" IS NOT NULL OR "defaultVideoModel" IS NOT NULL;
  INSERT INTO "codex_media_backup"."defaults" SELECT 'social_campaigns', id, "defaultImageModel", "defaultVideoModel" FROM "social_campaigns"
    WHERE "defaultImageModel" IS NOT NULL OR "defaultVideoModel" IS NOT NULL;
  UPDATE "workspaces" SET "defaultImageModel" = NULL, "defaultVideoModel" = NULL WHERE "defaultImageModel" IS NOT NULL OR "defaultVideoModel" IS NOT NULL;
  UPDATE "social_campaigns" SET "defaultImageModel" = NULL, "defaultVideoModel" = NULL WHERE "defaultImageModel" IS NOT NULL OR "defaultVideoModel" IS NOT NULL;
  -- tarife satırları (seed göçleri 20260827120000 / 20260904120000) silinmez, pasifleşir:
  UPDATE "channel_tariffs" SET "active" = false WHERE "provider" IN ('fal','runware');
  ```
  `down.sql`: `codex_media_backup.defaults`'tan iki tabloyu geri yazar, `channel_tariffs` satırlarını `active = true` yapar
  (`ChannelTariff.active` var: `S:5006`), `DROP SCHEMA "codex_media_backup" CASCADE`. Yedek `public` dışında olduğu için `migrate diff` sapma görmez.
  Gidiş-dönüş: `migrate deploy` → `psql -f down.sql` → kayıt silme → `migrate deploy` → `migrate diff --exit-code`.
- `GeneratedAsset.provider` geçmiş satırlarda `'fal'`/`'runware'` kalır (geçmiş kayıt; dokunulmaz). `S:3965` yorumu `// "codex" (eski satırlar: "fal" | "runware")` olur.

---

## 4. Video, TTS, avatar: **kapalı** (karar)

Codex yalnız görsel üretir. Karar: video (CREATE/ANIMATE/REFERENCE/TRANSITION/EXTEND/UPSCALE), avatar, lipsync, ses efekti, müzik ve TTS
**kapatılır**; satıcı aranmaz (sahibin kararı "fal yok"). Yeni satıcı ancak sahibinin ayrı kararıyla gelir.

- **Tek hata**: `MediaGenService.requestGeneration` (`M/media-gen.service.ts:398-411` aralığı, kredi rezervasyonundan **önce**):
  `type !== 'IMAGE'` → `UnprocessableEntityException({ code: 'MEDIA_KIND_UNAVAILABLE', type, message })`.
  Mesaj (TR, kullanıcıya): **"Video, ses ve avatar üretimi şu an kapalı: Jeeta görselleri ChatGPT (Codex) ile üretiyor ve Codex video ya da ses üretemiyor.
  Görsel üretimi çalışıyor."** (EN çevirisi locale dosyasında.)
- **Sosyal kampanyalar** (`B/social-campaigns/social-campaigns.service.ts:665-690`): `kinds` içinde IMAGE dışı tür **atlanır** (uyarı logu), öğe
  durmaz; yalnız VIDEO istenmişse öğe görselle üretilir ve `notes`'a "video kapalı; görsel kullanıldı" yazılır. `:682-687` FAL_KEY log metni
  "codex-media yapılandırılmamış (CODEX_MEDIA_URL)" olur. Yeni yazımda kampanya oluşturma/düzenleme DTO'su (`B/social-campaigns/social-campaigns.controller.ts:42, :60`, bugün `@IsIn(['IMAGE','VIDEO'])`)
  yalnız `IMAGE` kabul eder (400, aynı mesaj); daha önce VIDEO kaydedilmiş kampanyalar yukarıdaki atlama kuralıyla çalışır.
- **İçerik konseptleri / storyboard**: `B/content-concepts/concept-promotion.service.ts` `promote()` (`:345`) klip gerektiren konsepti
  (video biçimi) teklif (`assertQuoteHolds`, `:530`) **öncesinde** `MEDIA_KIND_UNAVAILABLE` ile reddeder. Storyboard **anahtar kareleri** (IMAGE,
  `B/content-concepts/storyboard-frames.ts:391-454`) çalışmaya devam eder ve `codex:image` ile üretilir — konsept onaylanabilir, kareler
  görsel olarak (karusel) yayınlanabilir. `resolveVideoModel` (`:663-697`) ve `animateModelFor` (`M/media-models.config.ts:1432`) kaldırılır ya da
  `MEDIA_KIND_UNAVAILABLE` atar. `B/content-concepts/shot-production.ts:110,130` ve `B/content-programme/slot-producer.service.ts:82-86` klip teklif etmez
  (video slotu → görsel slotu).
- `M/video-assembly.service.ts` (ffmpeg birleştirme) koda dokunulmaz; klip gelmediği için çağrılmaz. **İleride**: Codex anahtar karelerinden ffmpeg ile
  hareketli görsel (Ken Burns) video satıcısız mümkündür — ayrı görev, sahibin isteğine bağlı.
- **MCP**: `jeeta.generate_video` (`B/mcp/tools/content.tools.ts:204-278`) silinir ya da `MEDIA_KIND_UNAVAILABLE` döner — **silinir** (deferred araç; katalog
  sayısı 163 → 162, `tool-catalogue.spec.ts:685` ve isim listesi güncellenir, `docs/marketing/mcp-connector.md`'den çıkarılır). `jeeta.list_generated_media`
  (`:280-312`) VIDEO filtresini geçmiş varlıklar için korur.
- **Frontend**: `frontend/src/pages/marketing/social/mediaTechniques.tsx:44-94` IMAGE dışı teknik kartları **gizlenir değil, devre dışı** gösterilir
  (aynı mesaj, tek satır) — kullanıcı neden olmadığını görür. `AiModelsPage` (`/settings/ai-models`) video varsayılanı seçimini kaldırır; görsel seçimi tek seçenekli olur.

---

## 5. Söküm listesi

Karşılaştırma komutu (21 Eki, `origin/main` @ `a08d21a9`; çıktı `codex-trial/fal-grep.txt`, **813 satır**):
```bash
FAL='\b[Ff]al\b|\bFAL\b|[Ff]al\.ai|\bfal_|\bFAL_|fal-ai|queue\.fal|\bFal[A-Z]|\bfal[A-Z]|[a-z]Fal\b|[a-z]Fal[A-Z]'
grep -rnE "$FAL" backend/src frontend/src .github backend/prisma/schema.prisma backend/.env.example
grep -rniE "runware" backend/src frontend/src .github backend/prisma/schema.prisma backend/.env.example
```
(`grep -ri fal` "false/fallback" ile ~10 bin yanlış eşleşme verir; yukarıdaki desen `FAL_KEY`, `FalProvider`, `buildFalInput` gibi biçimleri yakalar.
npm bağımlılığı **yok**: iki sağlayıcı da ham `fetch` kullanıyor.) Test dışı her dosya aşağıda; satır sayısı = grep eşleşmesi.

### 5.1 Sağlayıcılar ve bağlantı — **sil / değiştir**
| Dosya:satır | İş |
|---|---|
| `P/fal.provider.ts` (tümü, 28) | sil |
| `P/runware.provider.ts` (tümü, 48) | sil |
| `P/routing.provider.ts` (tümü, 26) | sil (yerine `codex.provider.ts`) |
| `P/media-provider.interface.ts:54-55, :62` | `costUsd` yorumu; `resolveName` belgesi "isteğe bağlı" kalır, fal/runware adı çıkar; `MediaGenSubmit`'e `clientRef?` |
| `B/marketing.module.ts:478, :484-487, :855, :1358-1364` | importlar; webhook controller kaydı (`:855`) silinir; provider bloğu §2.2 |
| `B/controllers/marketing-media-webhook.controller.ts` (tümü, 9) | sil (`POST /api/marketing/ai/media/webhook`, `FAL_WEBHOOK_SECRET`) |
| `M/media-gen.service.ts:582, :720, :1068-1081` (+ yorumlar `:59, :408, :453, :705, :711, :717-718, :747, :997, :1003, :1025`) | `webhookUrl()` ve `finalizeByRequestId` silinir; vendor seçimi `'codex'`; yorumlar |
| `B/content-concepts/shot-production.ts:52, :57`; `B/content-concepts/concept-promotion.service.ts:655` | yorumlar + §4 değişikliği |

### 5.2 Ortam ve dağıtım
| Dosya:satır | İş |
|---|---|
| `backend/.env.example:463-469` | `FAL_KEY`, `FAL_WEBHOOK_SECRET`, `RUNWARE_API_KEY`, `RUNWARE_TIMEOUT_MS` → `CODEX_MEDIA_URL`, `CODEX_MEDIA_SECRET` |
| `.github/workflows/deploy.yml:182-187` | `FAL_KEY`, `FAL_WEBHOOK_SECRET` secrets → `CODEX_MEDIA_SECRET` |
| `.github/workflows/deploy.yml:266-269` | `RUNWARE_API_KEY` sil |
| `.github/workflows/deploy.yml:414-416` | `.env` yazımı `FAL_*` → `CODEX_MEDIA_URL=http://codex-media:7311`, `CODEX_MEDIA_SECRET=${CODEX_MEDIA_SECRET}` |
| `.github/workflows/deploy.yml:454-455` | `RUNWARE_API_KEY` sil |
| `docker-compose.prod*.yml` (yeni servis) | `codex-media` servisi, `codex-home` birimi, port yayını yok — **koordinatör/sunucu işi**, bu dalda yalnız örnek dosya `codex-media/docker-compose.example.yml` |
| `B/ai/ai-job-settings.service.ts:47-48` | §2.4 |
| `B/social-campaigns/social-campaigns.service.ts:682, :687` | log/yorum metni |
| GitHub secrets `FAL_KEY`, `FAL_WEBHOOK_SECRET`, `RUNWARE_API_KEY` | birleştirme+deploy **sonrası** silinir (sahibi/koordinatör) |

### 5.3 Katalog
| Dosya:satır | İş |
|---|---|
| `M/media-models.config.ts` (116 eşleşme): `:30-33, :248-259, :262, :287, :296-298, :304-318, :361-363, :426-436`, girdiler `:440-1157`, `:1198, :1307, :1344, :1448, :1572, :1587-1615` | §3.1'e göre yeniden yaz |
| `M/media-model-defaults.service.ts:28, :157` | yorum; yalnız IMAGE varsayılanı |
| `M/media-asset.constants.ts:4` | yorum |
| `B/controllers/marketing-workspaces.controller.ts:223, :230` | belge yorumu ("fal.ai model" → katalog modeli) |
| `B/video/video-pipeline.service.ts:134, :244` | yorum |
| `S:148` (yorum), `S:3958, :3965` (GeneratedAsset yorumları) | yorum (göç gerektirmez) |

### 5.4 Harcama, tarife, onay
| Dosya:satır | İş |
|---|---|
| `B/budget/media-spend.service.ts:8-16, :41, :49-50, :55-59, :65-67, :77` (18) | `vendor` birliği ve `FAL_CREDIT`/`RUNWARE_CENT` dalı silinir; `codex` → ledger yok |
| `B/wallet/channel-tariff.service.ts:12-13, :31` | `'FAL_CREDIT' | 'RUNWARE_CENT'` birlikten çıkar |
| `B/wallet/vendor-spend-report.service.ts:27-28` | iki satır silinir (geçmiş rapor için: "Eski görsel satıcısı (fal/Runware)" tek satır olarak tutulursa geçmiş harcama görünmeye devam eder — **tutulur**, etiket değişir) |
| `S:4995, :5000-5001` | `provider`/`unitType` yorumları |
| göç `20260827120000_seed_fal_credit_tariff`, `20260904120000_seed_runware_cent_tariff` | **dokunulmaz**; §3.2 göçü pasifleştirir |
| `B/ai/ai-spend-policy.ts:52` | kullanıcı metni: "Görsel ve video ayrıca fal.ai kredisi harcar." → "Görsel üretimi AI kredisi harcar (görsel başına 2)." |
| `B/ai/ai-credit-costs.ts:9` (yorum), `:80` (3 → 2) | |
| `B/controllers/marketing-ai.controller.ts:339` | yorum |
| `B/agents/approval-request.service.ts:47-53, :72` | `MEDIA_SPEND` türü **kalır** (satıcıdan bağımsız); yorumlar "fal.ai" → "görsel üretimi" |
| `backend/prisma/seed-packages.ts:46, :155` | yorum |

### 5.5 MCP ve belgeler
| Dosya:satır | İş |
|---|---|
| `B/mcp/tools/content.tools.ts:135` | `generate_image` açıklaması: "Generate an image with AI (fal.ai)" → "Generate an image with AI (ChatGPT image generation via Codex)…"; referans ≤ 4, oran listesi `codex:image`'dan |
| `B/mcp/tools/content.tools.ts:204-278` (`:207` açıklama) | `generate_video` silinir (§4) |
| `B/mcp/tools/content.tools.ts:34-39` | aspect enum'ları varsayılan görsel modelden; video enum'u kalkar |
| `B/mcp/tools/analytics.tools.ts:74` | `get_vendor_spend` açıklamasından "fal.ai media" çıkar |
| `B/mcp/tools/commerce.tools.ts:247` | yorum |
| `docs/marketing/mcp-connector.md:294, :349, :463-464, :570, :1121` | metin + `generate_video` satırı |
| `docs/ops/ai-execution.md` (1) | metin |
| Eski tasarım/plan belgeleri (`docs/superpowers/**` 13 dosya) | **dokunulmaz** (tarihsel); `2026-09-04-hybrid-media-provider-runware-design.md` başına "Yerine geçti: 2026-10-21-codex-media.md" notu |

### 5.6 Frontend
| Dosya:satır | İş |
|---|---|
| `frontend/src/i18n/locales/en/marketing.json:585`, `tr/marketing.json:810` (`aiModels.actions.mediaHint`) | "fal and media services charge…" → Codex metni; + `MEDIA_KIND_UNAVAILABLE` mesajı (5 dil) |
| `frontend/src/pages/marketing/settings/aiModels/AiExecutionPolicyCard.tsx:227` | satır içi varsayılan metin |
| `frontend/src/pages/marketing/social/mediaTechniques.tsx:44-94` | IMAGE dışı kartlar devre dışı (§4) |
| `frontend/src/features/marketing/api/media.service.ts:244` (yorum), `:252, :283` (yerel `meteredUnits`/`estimateMediaCredits` kopyası — codex için sabit 2) | |
| `frontend/src/App.tsx:325`, `frontend/src/features/marketing/navigation.ts:568` | yorum |
| `backend/src/modules/marketing/research/providers/firecrawl.provider.ts:9` | yorum "mirrors FalProvider" → "mirrors CodexMediaProvider" |

### 5.7 Testler (44 dosya; ayrıntı satırları `codex-trial/fal-grep.txt`)
| Dosya | İş |
|---|---|
| `P/fal.provider.spec.ts`, `P/fal.provider.contract.spec.ts`, `P/runware.provider.spec.ts`, `P/runware.provider.contract.spec.ts`, `P/routing.provider.spec.ts` | sil |
| `B/controllers/marketing-media-webhook.controller.spec.ts` | sil |
| `M/media-models.catalogue.spec.ts` (canlı fal yoklaması `FAL_CATALOGUE_PROBE`) | sil; yerine `codex.catalogue.spec.ts` (§6) |
| `M/media-models.config.spec.ts` (81), `M/media-models.metering.spec.ts` (11), `M/model-choice-doors.spec.ts` (4), `M/media-model-defaults.service.spec.ts` (22) | `codex:image` + legacy çözümleme + VIDEO/AUDIO kapalı olarak yeniden yazılır |
| `M/media-gen.service.{contract,engine,finalize,lifecycle,model-resolution,request}.spec.ts` (39/12/18/3/13/11) | fal kimlik fikstürleri `codex:image`; webhook testleri silinir; `MEDIA_KIND_UNAVAILABLE` testi eklenir |
| `B/budget/media-spend.service.spec.ts` (12), `B/ai/ai-usage-dashboard.service.spec.ts:66` | codex → ledger yok |
| `B/content-concepts/concept-promotion.service.spec.ts` (20), `content-concepts.service.spec.ts` (6), `B/content-programme/{programme-planner,slot-producer}.service.spec.ts` | klip yolu → `MEDIA_KIND_UNAVAILABLE`; kare yolu `codex:image` |
| `B/controllers/{marketing-media,marketing-workspaces}.controller.spec.ts` (15/5) | fikstürler |
| `B/mcp/tools/{content,commerce}.tools.spec.ts`, `B/mcp/tools/tool-catalogue.spec.ts` | açıklama, `generate_video` yok, sayı 162 |
| `B/social-campaigns/social-campaigns.{service,planner}.spec.ts` (8/1), `B/video/video-pipeline.service.spec.ts:264` | VIDEO atlama testi |
| `backend/test/e2e/{ai-usage-dashboard,channel-tariff,concept-promotion,content-concepts,content-programme,media-model-defaults,media-spend}.realdb.e2e-spec.ts` | fikstürler; `channel-tariff`: FAL_CREDIT satırı pasif |
| `frontend/src/features/marketing/api/media.service.test.ts`, `settings/aiModels/{AiExecutionPolicy,AiModelsPage}.test.tsx`, `social/{AiStudioPage,PostComposerDialog}.test.tsx`, `studio/BatchDetail.test.tsx` | fikstürler; devre dışı kart testi |

**Bitiş kontrolü:** iş bitince aynı grep komutu `backend/src frontend/src .github backend/.env.example` üzerinde **0 satır** vermeli
(izinli istisnalar: `S` yorumlarında "eski satırlar: fal|runware", `vendor-spend-report.service.ts` geçmiş etiketi, legacy kimlik kümesi
`LEGACY_IMAGE_MODEL_IDS` — bunlar `// legacy-fal` işaretli satırlar olur ve kontrol `grep -v legacy-fal` ile koşar).

---

## 6. Kabul ölçütleri ve test listesi

Komutlar: backend `cd backend && npx jest <yol>` / `npm test`; frontend `cd frontend && npx vitest run <yol>`; yan servis `cd codex-media && npm test` (node:test ya da vitest — Selin seçer, `package.json`'a yazar).

### A. codex-media yan servisi (Parça 1)
| # | Ölçüt | Doğrulama |
|---|---|---|
| A1 | Sır yok/yanlış → 401; `/health` sırsız | `codex-media/test/http.test.ts` |
| A2 | Gövde doğrulama: prompt boş/uzun, oran listede değil, >4 referans, http referans, izinsiz host → 400 + `details` | aynı |
| A3 | Sahte app-server (stdio'da JSON-RPC konuşan test betiği) ile: `imageGeneration completed` → R2 sahte istemcisine PNG yüklenir, `GET /jobs/:id` `COMPLETED` + url/width/height | `codex-media/test/job.test.ts` (`test/fake-app-server.mjs`) |
| A4 | `failure` dolu → `CONTENT_BLOCKED`; görsel yok → `NO_IMAGE`; `commandExecution` öğesi → `POLICY_VIOLATION` + `turn/interrupt`; 180 s → `TIMEOUT` (sahte saat) | aynı |
| A5 | Sunucu istekleri (`*/requestApproval`, elicitation) reddedilir; thread/start parametreleri §1.6'daki gibi (MCP/plugin kapalı, `untrusted`, `read-only`) | aynı (sahte sunucu gelen parametreyi kaydeder) |
| A6 | Eşzamanlılık 2, kuyruk 20 → 21. istek 429; aynı `clientRef` aynı `jobId` | aynı |
| A7 | `account/read` hesap yok → `/health` `auth_required`, `POST /generate` 503 `CODEX_AUTH_REQUIRED`; kota hatası → 503 `CODEX_QUOTA_EXHAUSTED` + `resetsAt` | aynı |
| A8 | Kırpma: 941×1672 girdi, `9:16` → 1080×1920; 1254×1254, `4:5` → 4:5 orta kırpma | `codex-media/test/crop.test.ts` |
| A9 | **Gerçek** Codex ile yerelde bir üretim (sahibin hesabı, kota harcar — tek istek): | `CODEX_MEDIA_SECRET=dev node dist/server.js` + `curl -s -X POST localhost:7311/generate -H "Authorization: Bearer dev" -H 'Content-Type: application/json' -d '{"prompt":"red apple on white","aspectRatio":"1:1"}'` → `jobId`; `curl -s localhost:7311/jobs/<id> -H "Authorization: Bearer dev"` → `COMPLETED` ve R2 (ya da `CODEX_MEDIA_R2_DRYRUN=1` ile yerel dosya) yolu; çıktı teslimde |

### B. Backend: provider, katalog, söküm (Parça 2)
| # | Ölçüt | Doğrulama |
|---|---|---|
| B1 | `CodexMediaProvider.submit` gövde eşlemesi (prompt+negatif, oran, referanslar ≤4, clientRef) ve `codex:` öneki; IMAGE dışı tür reddi | `P/codex.provider.spec.ts` (fetch mock) |
| B2 | `getResult` §2.3 tablosunun her satırı | aynı |
| B3 | `MEDIA_PROVIDER` → `CodexMediaProvider`; önek `codex:` olmayan eski iş → `FAILED` + iade | `M/media-gen.service.lifecycle.spec.ts` |
| B4 | Katalog: `listMediaModels()` yalnız `codex:image`; `listMediaModels('IMAGE_EDIT')` da onu döndürür; kredi 2, USD 0; legacy görsel kimliği → `codex:image`; VIDEO/AUDIO varsayılanı yok | `M/media-models.config.spec.ts`, `M/codex.catalogue.spec.ts` |
| B5 | `requestGeneration` VIDEO/AUDIO → 422 `MEDIA_KIND_UNAVAILABLE`, **kredi rezerve edilmez** | `M/media-gen.service.request.spec.ts` |
| B6 | Sosyal kampanya `mediaKinds:['IMAGE','VIDEO']` → görsel üretilir, video atlanır, öğe başarısız olmaz | `B/social-campaigns/social-campaigns.service.spec.ts` |
| B7 | Konsept promote klip gerektiren konsepti teklif öncesi reddeder; kareler `codex:image` ile üretilir | `B/content-concepts/concept-promotion.service.spec.ts`, `storyboard-frames` spec'i |
| B8 | `MediaSpendService.settle` codex varlığı için ledger yazmaz | `B/budget/media-spend.service.spec.ts` |
| B9 | MCP: `generate_image` açıklamasında "fal" yok, `generate_video` yok, katalog 162 | `B/mcp/tools/content.tools.spec.ts`, `tool-catalogue.spec.ts` |
| B10 | Veri göçü gidiş-dönüş: varsayılanlar yedeklenip null olur, down geri yazar | §3.2 komutları + `backend/test/e2e/media-model-defaults.realdb.e2e-spec.ts` |
| B11 | Söküm bitişi: §5 grep komutu `grep -v legacy-fal` ile **0 satır** | komut çıktısı |
| B12 | Tüm takım: `npm test` yeşil, `tsc --noEmit` 0; frontend `vitest run` yeşil, `tsc` 0 | komut son satırları |
| B13 | Uçtan uca (yerel, gerçek yan servis): backend `.env` `CODEX_MEDIA_URL=http://localhost:7311` → stüdyodan ya da `jeeta.generate_image` ile bir görsel → `GeneratedAsset` `READY`, `provider='codex'`, `costCredits=2` | ekran/komut çıktısı + `psql` satırı |

### Ön koşul (canlıya alma)
| # | Ölçüt | Doğrulama |
|---|---|---|
| G1 | **Canlıya alma, sahibinin §7'deki ChatGPT kullanım şartları riskini okuyup verdiği yazılı onaya bağlıdır** (kişisel abonelik + ortak kota kabulü). Onay olmadan yan servis sunucuda başlatılmaz ve `CODEX_MEDIA_URL` canlı `.env`'e yazılmaz; dallar birleşebilir, yayın bekler | ofis onay kaydı (approval id) teslimde |

### C. Frontend
| # | Ölçüt | Doğrulama |
|---|---|---|
| C1 | Stüdyoda IMAGE dışı kartlar devre dışı ve mesajlı; Düzenle kartı `codex:image` | `social/AiStudioPage.test.tsx` |
| C2 | Ayarlar > AI modelleri: video varsayılanı yok, görsel tek seçenek; ipucu metninde "fal" yok | `settings/aiModels/AiModelsPage.test.tsx`, `AiExecutionPolicy.test.tsx` |

---

## 7. Riskler

| Risk | Etki | Azaltma / karar sahibi |
|---|---|---|
| **ChatGPT kullanım şartları**: kişisel/abonelik ChatGPT hesabını çok kiracılı bir SaaS'ın arka ucu olarak kullanmak OpenAI şartlarına aykırı sayılabilir | hesabın kısıtlanması/kapanması → tüm görsel üretimi durur; sahibin kişisel hesabı risk altında | **Sahibe açıkça bildirilir.** Yan servis arayüzü sağlayıcıdan bağımsızdır: aynı `/generate` sözleşmesi ileride OpenAI Images API (ücretli, API anahtarı) ile doldurulabilir — backend değişmez. Karar sahibinde |
| **İçerik politikası**: istemler müşteriden/yapay zekâdan gelir; politika ihlali tekrarları hesabı işaretler | hesap uyarısı/kısıtlama | `CONTENT_BLOCKED` sayacı çalışma alanı başına; günde > 5 ise o çalışma alanı 24 saat kapanır (yan serviste basit sayaç) ve admin uyarısı |
| **Ortak kota**: görseller ofisteki Codex çalışanlarıyla aynı haftalık Codex kotasından düşer (deneme: 2 görsel ≈ %1) | yoğun görsel üretimi ofis çalışanlarını durdurabilir ya da tersi | `/health.weeklyUsedPercent` izlenir; `CODEX_MEDIA_QUOTA_CEILING` (varsayılan %60) üstünde yan servis 503 `CODEX_QUOTA_EXHAUSTED` döner — ofis için pay bırakır. Ayrı ChatGPT hesabı (ayrı abonelik) sahibin kararı (**satın alma**) |
| **Device-auth girişi / oturum süresi**: sunucuda oturum düşebilir (token yenileme hatası, şifre değişimi, hesap çıkışı) | görsel üretimi 503; içerik akışı görselsiz kalır | `/health` `auth_required` → admin bildirimi; yeniden giriş koordinatör + sahibi (§1.8). Sosyal kampanya zaten görselsiz devam eder (`social-campaigns.service.ts:682-690`) |
| **Codex CLI/protokol değişikliği** (`app-server` "experimental") | yan servis kırılır | CLI sürümü konteynerde **sabitlenir** (`@openai/codex@0.162.1`); yükseltme ayrı PR + A3-A9 testleri |
| **Kalite/oran**: aspect parametresi yok, oran istemle | yanlış kadraj | §1.5 kırpma; A8 testi |
| **Gizlilik**: referans görseller (müşteri fotoğrafları) ChatGPT'ye gider ve orada saklanabilir | KVKK açısından yurtdışı aktarım | Figurunica müşteri fotoğrafları **gönderilmez** (yalnız marka/ürün görselleri); aydınlatma metni sahibine (hukuk) |
| **Video/TTS kaybı** | video içerik ve seslendirme yok | §4: açık mesaj, görselle devam; ileride ffmpeg hareketli görsel ya da yeni satıcı — sahibin kararı |
| Ölçek: ~6-7 görsel/dk, kota sınırlı | büyük kampanyada gecikme | kuyruk + backend inflight sınırı; kampanya planlayıcısı zaten zamana yayıyor |

---

## Paylaşım (paralel geliştirme)

| Parça | Sahibi | Dal (origin/main'den) | Dosyalar | Bağımlılık |
|---|---|---|---|---|
| 1 — codex-media yan servisi | Selin | `feat/codex-media-sidecar` | yalnız `codex-media/**` | yok |
| 2 — CodexMediaProvider + katalog + söküm + video kapatma + göç | Selin | `feat/codex-media-provider` | `backend/**`, `frontend/**`, `.github/workflows/deploy.yml`, `backend/.env.example`, `docs/marketing/mcp-connector.md` | Parça 1'in **HTTP sözleşmesi** (§1.2-1.3); testlerde fetch mock'u. B13 için Parça 1 yerelde çalışır olmalı |

- Paylaşılan kaynaklar: göç adı `20261021120000_codex_media_defaults` (ticaret göçleri `2026102110{0,1,2}000` ile çakışmaz); yan servis portu `7311`;
  istek öneki `codex:`; iş kimliği öneki `cm_`; R2 öneki `codex-media/`.
- MCP araç adları: `jeeta.generate_image` (açıklama değişir), `jeeta.generate_video` (silinir). Yeni araç yok.
- Sıra: iki parça paralel; Parça 2 birleşmeden önce Parça 1 birleşmiş ve sunucuda koşuyor olmalı (yoksa görsel üretimi tamamen durur).
  **Yayın sırası (koordinatör, sahibin onayıyla):** (1) yan servis konteyneri + device-auth girişi + `/health` ready, (2) backend deploy + göç, (3) GitHub'dan `FAL_*`/`RUNWARE_*` sırlarının silinmesi.
- İnceleme: her parça ayrı PR; inceleyen Kerem, testleri kendisi koşar. Birleştirme, deploy ve sırların silinmesi **sahibinin kararı**.

## Kapsam dışı

- Video/TTS/avatar için yeni satıcı; ffmpeg hareketli görsel videosu (ayrı görev).
- OpenAI Images API (ücretli) yedeği — yalnız arayüz uyumu bırakılır.
- Eski `GeneratedAsset` satırlarının ya da R2 nesnelerinin taşınması (dokunulmaz).
