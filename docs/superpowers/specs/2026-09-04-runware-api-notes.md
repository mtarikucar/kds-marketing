# Runware HTTP API — uygulama notları (2026-09-04'te doğrulandı)

Kaynak: https://runware.ai/docs/platform/* ve https://runware.ai/docs/models/<slug>
(her model sayfasının `.md` ve `/schema.json` ikizi var; `https://runware.ai/docs/llms.txt`
tüm sayfaları listeler). Bu not, `RunwareProvider`'ın dayandığı alan adlarını kaydeder;
şüphede kalınca model sayfasının `schema.json`'u kazanır.

## Taşıma

- `POST https://api.runware.ai/v1`, `Content-Type: application/json`,
  `Authorization: Bearer <RUNWARE_API_KEY>`.
- Gövde **görev dizisi**: her görev `taskType`, `taskUUID` (istemci üretir, UUID v4),
  `model` (AIR kimliği `creator:family@version`) + görev alanları.
- Başarı: `{ "data": [ { "taskType", "taskUUID", ... } ] }`. Hata: `{ "errors": [ { "code",
  "message", "parameter"?, "taskUUID"?, "status": "error" } ] }`. **İkisi aynı yanıtta
  olabilir** (görev başına hata).
- HTTP: 400/401/402 (bakiye)/403/404/429/500/503/504. 429/503/504 geçici; 4xx doğrulama
  hataları isteği değiştirmeden tekrar denenmez. Başarısız istek ücretlendirilmez.

## Async, poll, maliyet, URL ömrü

- `deliveryMethod: "async"` görev başına. **Video görevlerinde async tek seçenek.**
  Görsel görevleri de async gönderilebilir (tek poll hattı için).
- Async ilk yanıt: yalnız onay; `errors` boşsa `taskUUID` ile poll'a geç.
- Poll: `[{ "taskType": "getResponse", "taskUUID": "<uuid>" }]`. Yanıt `data[]` içinde
  `status: "processing" | "success" | "error"`, işlenirken `progress` (0–100). Başarısız
  görev `errors[]`'a taşınır **ya da** öğe içinde `error { code, message }` gelir; ikisini de
  ele al.
- `includeCost: true` → her sonuç öğesinde `cost` (USD, float).
- `outputType: "URL"`; çıktı URL'si varsayılan **7 gün**, `ttl` (saniye, ≥60) ile değişir.
  Video için `outputType` yalnız `URL`.
- `webhookURL` görev başına; POST gövdesi sonuç öğesinin kendisi (düz, `data` sarmalı yok);
  2xx bekler; 250 ms'den başlayıp 8 s'ye kadar katlanan tekrar; imza başlığı yok
  (kimlik yalnız query-string). v1'de kullanılmıyor.

## Görev tipleri

### `imageInference` (Qwen-Image `runware:108@1`)

`positivePrompt`, `negativePrompt` (Qwen'de var), `width`/`height` (Qwen: 256–2048,
adım 8; örnekler 1024×1024), `steps` (Qwen varsayılan 20), `seed` (int), `numberResults`
(1–20), `outputType`, `outputFormat` (`JPG`|`PNG`|`WEBP`), `outputQuality`,
`safety: { checkContent }`, `inputs.seedImage`/`inputs.maskImage`/`inputs.referenceImages`.
Yanıt: `imageUUID`, `imageURL`, `seed`, `NSFWContent`, `cost`. `width`/`height` yanıtta
güvenilir değil.

### `videoInference` (Seedance 2.5 `bytedance:seedance@2.5`, Seedance 1.0 Pro Fast `bytedance:2@2`)

- Ortak: `positivePrompt`, `resolution` (`480p|720p|1080p`) **veya** `width`/`height`
  (ikisi birlikte değil), `duration`, `numberResults` (1–4), `outputFormat` (`MP4`),
  `safety: { checkContent, mode }`. `fps` ve `negativePrompt` bu modellerde yok.
- `inputs.frameImages`: `[{ "image": "<url|uuid|dataURI>", "frame": "first"|"last" }]`.
  frameImages ile `width`/`height` **birleştirilemez**; `resolution` kullanılır. Tek
  başına `last` reddedilir.
- Seedance 2.5: `duration` tam sayı 4–30 (veya `"auto"`), varsayılan 5; `settings.audio`
  boolean **varsayılan true**; istekte `seed` yok (yanıtta var); frameImages 1–2;
  `inputs.referenceImages` (1–30), `inputs.referenceVideos`, `inputs.referenceAudios`,
  `inputs.video`. Boyut tablosu — 480p: 854×480, 752×560, 640×640, 560×752, 480×854,
  992×432 · 720p: 1280×720, 1112×834, 960×960, 834×1112, 720×1280, 1470×630 · 1080p:
  1920×1080, 1664×1248, 1440×1440, 1248×1664, 1080×1920, 2206×946 (sıra: 16:9, 4:3,
  1:1, 3:4, 9:16, 21:9). Fiyat/s: 480p $0.1025, 720p $0.2304, 1080p $0.61354
  (örnek: 720p 5 s = $1.165).
- Seedance 1.0 Pro Fast: `duration` float 1.2–12, varsayılan 5; `seed` var; ses yok;
  `providerSettings.bytedance.cameraFixed`. frameImages en fazla 1 (`first`). Boyutlar —
  480p: 864×480, 736×544, 640×640, 544×736, 480×864, 960×416 · 720p: 1248×704, 1120×832,
  960×960, 832×1120, 704×1248, 1504×640 · 1080p: 1920×1088, 1664×1248, 1440×1440,
  1248×1664, 1088×1920, 2176×928. Fiyat/s: 480p $0.00629, 720p $0.01336, 1080p $0.03177.
- Yanıt: `videoUUID`, `videoURL` (`https://vm.runware.ai/video/…mp4`), `seed`,
  `NSFWContent`, `cost`; poll sırasında `status`/`progress`. **Süre dönmez.**

### `removeBackground` (BiRefNet General `runware:112@5`, Massive `runware:112@8`)

`inputs.image` (zorunlu), `outputFormat` varsayılan `PNG` (alfa kanalı), `settings`
bloğu yok. Yanıt `taskType` bazen eski ad `imageBackgroundRemoval` ile döner — ikisini
de kabul et. `imageUUID`, `imageURL` (.png), `cost`. ~$0.0006/koşu.

### `upscale` (Topaz Wonder 3.5 `topazlabs:wonder@3.5`) — v1 dışı

`upscaleFactor` 2–6, `inputs.image` ≤64 MP, çıktı ≤256 MP, `settings.enhancementStrength`.
Çıktı MP'ye göre fiyat: ≤8 MP $0.0428 … 100 MP $0.556.

## Moderasyon → BLOCKED eşlemesi

Resmi SDK'nın `safety` grubuna aldığı kodlar: `contentPolicyViolation`,
`providerContentPolicyViolation`, `sensitiveContentDetected`, `unsafeContentDetected`,
`nsfwContentDetected`, `promptBlocked`, `imageBlocked`, `moderationFailed`. Ayrıca yanıtta
`NSFWContent: true`. Diğer gruplar: `quota` (402), `rateLimit`, `timeout`, `provider`,
`serverError`, `validation`.

## Bulunamayanlar

Async ilk onay gövdesi; webhook imzası/tekrar üst sınırı; yanıtta görsel `width`/`height`;
`fps`; Seedance/Kling isteklerinde `seed`; Kling Avatar azami ses süresi; Seedream 1.5K/2K
piksel eşiği; Qwen-Image önerilen boyut tablosu; `runware:112@10`.
