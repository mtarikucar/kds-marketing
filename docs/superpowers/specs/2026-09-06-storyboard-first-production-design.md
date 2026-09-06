# Storyboard-first üretim: önce kare, sonra video — tasarım

Tarih: 2026-09-06
Durum: kullanıcı isteği ("video üretmeden önce storyboard üretsin, metinden uzun video saçmalıyor"), otonom uygulama

## 1. Sorun

İçerik hattı bugün bir konsepti N beat'e bölüyor ve her beat'i **bağımsız bir metinden-video
klibi** olarak satın alıyor (`ConceptPromotionService.produce`, beat başına bir
`requestGeneration({type:'VIDEO', prompt})`), sonra klipleri ffmpeg ile birleştiriyor. Her klip
sahneyi kendi başına icat ediyor: kişi, mekân, ışık, ürün beat'ten beat'e değişiyor; uzun bir
metin prompt'u tek kareden çok şey isteyince model "saçmalıyor". Tek görsel süreklilik aracı
persona referansları (referans-görselden-video, 48 kredi/s) — onu da yalnız persona'lı planlar
kullanıyor.

## 2. Hedef

Her konsept videosu **storyboard'dan** üretilir:

1. Beat başına **bir anahtar kare** (görsel) üretilir — prompt yalnız o karenin ne gösterdiğini
   söyler; aynı plan içinde sabit bir seed ve aynı stil öneki ile.
2. Her beat, kendi anahtar karesinden **image-to-video** ile canlandırılır (model kareyi ilk kare
   alır, prompt hareketi tarif eder).
3. Kareler onaydan **önce** istenebilir, tek tek yeniden üretilebilir ve hub'da görülebilir;
   istenmemişse üretim aşamasında otomatik üretilir. **İnsan kapısı tek kalır** (konsept onayı).

Fiyat tasarımı: varsayılan canlandırma modeli **Seedance 1.0 Pro Fast image-to-video**
(`fal-ai/bytedance/seedance/v1/pro/fast/image-to-video`, $1/M token → 720p'de $0.0216/s → 3
kredi/s; Runware'de `bytedance:2@2` + `frameImages`). Bugünkü varsayılan metinden-video ile
aynı saniye fiyatı. Kare başına Seedream v4 3 kredi. 3 × 5 s'lik konsept: 45 → 54 kredi.
Persona'lı konsept: kimlik kareye gömülür (Nano Banana Pro edit, 15 kredi/kare, ≤14 referans),
canlandırma yine 3 kredi/s → 720 kredi yerine 90.

## 3. Kapsam

**İçinde:** katalog girdisi ve yardımcılar; plan şekli (description, keyframePrompt, keyframe,
storyboard); kotasyon (kare + canlandırma); model çözümü (`storyboard` dalı + t2v→i2v kardeş
eşlemesi); `StoryboardService` (iste / tek kare yeniden üret / senkron), `content.concept.storyboard`
işi; `produce` iki faz (kareler READY → canlandır); REST + MCP uçları; hub'da (BatchDetail) kareler,
kotasyon ve aksiyonlar; MCP açıklamaları; testler; e2e güncellemesi.

**Dışında:** hub'a konsept onay/ret düğmesi (onay MCP'de kalır — ayrı ürün kararı); ilk+son kare
geçişi (`end_image_url`, VIDEO_TRANSITION) — v2; kare metnini (prompt) düzenleme UI'ı; klip
thumbnail'ının kareden doldurulması (kolay takip işi); TTS/voiceover.

## 4. Varsayımlar (kullanıcı ulaşılamaz olduğu için açıkça)

- **A1** Yeni planlanan her konsept storyboard yolunu kullanır; eski (kare planı olmayan)
  planlar bugünkü gibi metinden-video ile üretilir. Storyboard eski plan için istenemez
  ("yeniden planla" der).
- **A2** Kare inceleme isteğe bağlıdır; onaylanan ama kareleri olmayan konseptin kareleri
  üretim işinde otomatik yapılır. İkinci bir insan kapısı yok.
- **A3** Kampanya/çalışma alanı bir metinden-video modeli seçmişse canlandırma için o ailenin
  image-to-video kardeşi kullanılır (Seedance 2.5 → 2.5 i2v; Veo 3.1 → 3.1 i2v); kardeşi
  olmayan (Pro Fast t2v, Veo 3.1 Fast, retired id'ler) varsayılan canlandırma modeline düşer ve
  bu `production.modelSource = 'storyboard'` + `replacedModel` olarak plana yazılır.
- **A4** Persona kimliği kareye gömülür (referanslı kare modeli); referans-görselden-video yalnız
  eski planlar için kalır.
- **A5** Kare üretimi kredi harcar (kare başına 3 ya da 15); MCP aracı `plan_content_concepts`
  gibi WRITE/onaysızdır, `requestedById` imzalı kullanıcı ya da servis ilkesidir.

## 5. Mimari

### 5.1 Katalog (`media-models.config.ts`)

- Yeni girdi `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video`: `VIDEO_ANIMATE`, 3 kredi/s
  720p (katmanlar 480p 1, 1080p 5), sözleşme: `prompt`, `image_url` (firstImage, zorunlu),
  `resolution` {480p,720p,1080p} default 720p (fal varsayılanı 1080p!), `duration` rakam-string
  2–12, `aspect_ratio` {21:9,16:9,4:3,1:1,3:4,9:16} (fal'ın `auto`su gönderilmez; plan oranı
  gönderilir), `seed` var, negatif prompt yok; `runware: { model: 'bytedance:2@2', ... }`.
- Sabitler: `DEFAULT_VIDEO_ANIMATE_MODEL` (yukarıdaki), `DEFAULT_KEYFRAME_MODEL =
  DEFAULT_IMAGE_MODEL`, `DEFAULT_KEYFRAME_REFERENCE_MODEL = 'fal-ai/nano-banana-pro/edit'`.
- `MediaModel.animateSibling?: string` — t2v girdisinin image-to-video kardeşi
  (Seedance 2.5 t2v → i2v; Veo 3.1 → i2v). `animateModelFor(id)`: id firstImage alıyorsa
  kendisi; kardeşi varsa o; yoksa `DEFAULT_VIDEO_ANIMATE_MODEL`.
- `mediaModelAcceptsFirstImage(id)`: `sources.some(slot==='firstImage')`.

### 5.2 Plan şekli (`video-pipeline.service.ts`)

```ts
Shot {
  ...mevcut,
  /** Karede ne var — LLM'in description'ı, ham. Yeni planlarda var. */
  description?: string;
  /** Kare üretim prompt'u: kimlik cümlesi + description + kamera notu + "single still frame, <yön> <oran>, photorealistic, sharp". Video son eki YOK. */
  keyframePrompt?: string;
  keyframe?: { assetId: string; status: 'QUEUED'|'GENERATING'|'READY'|'FAILED'|'BLOCKED'; url?: string; model: string; seed?: number; attempts: number; error?: string };
}
ShotPlan { ...mevcut, storyboard?: { imageModel: string; seed: number; requestedAt?: string; requestedById?: string } }
ShotProduction {
  ...mevcut,
  modelSource: 'campaign'|'workspace'|'platform'|'persona'|'storyboard',
  /** Kare satın alımı; toplam credits/usd buna dahil. */
  keyframes?: { model: string; perFrameCredits: number; credits: number; usd: number },
}
```

`planShots` yeni planlarda `description`, `keyframePrompt` ve plan düzeyinde `storyboard.seed`
(persona.lockedSeed ?? rastgele 31-bit) yazar. `Shot.prompt` canlandırma prompt'u olarak
kalır (hareket + stil).

### 5.3 Model çözümü ve kotasyon

- `resolveVideoModel(ws, campaignModel, { wantsReference, storyboard })`:
  `storyboard` ise `animateModelFor(chosen ?? workspaceDefault)`; kendisi değilse
  `modelSource:'storyboard', replacedModel`. `storyboard` ve `wantsReference` birlikte → kimlik
  karede, canlandırma dalı yine `storyboard` (referans-görselden-video yok). Eski davranış
  (`storyboard: false`) aynen.
- `quoteProduction(plan, choice, keyframeModel?)`: beat başına `billedBeatSec(animateModel)` +
  kare: `estimateMediaCredits(keyframeModel, {})` × beat. `keyframes` bloğu ve toplamlar.
- `assertQuoteHolds`: canlandırma modeli **ve** kare modeli aynı olmalı.

### 5.4 `StoryboardService` (`content-concepts/storyboard.service.ts`)

- `request(ws, conceptId, requestedById)`: konsept PROPOSED ya da (APPROVED ve henüz üretilmemiş)
  olmalı; plan storyboard destekliyor olmalı (yoksa 400 "yeniden planla"). `storyboard.requestedAt`
  yazar, `content.concept.storyboard` işini kuyruklar (dedup `content-concept-storyboard-<id>`).
  Kare zaten READY/QUEUED olan beat'lere dokunmaz.
- `regenerateFrame(ws, conceptId, ord, requestedById)`: o beat'in `keyframe`'ini temizler
  (yeni seed = plan seed + attempts), işi kuyruklar.
- `run(conceptId, ws, waits)` (iş): (1) `keyframe`i olmayan her beat için
  `requestGeneration({type:'IMAGE', model: storyboard.imageModel, prompt: keyframePrompt,
  aspectRatio: plan.aspectRatio, seed, referenceImageUrls: persona refs (yalnız kare modeli
  `images` alıyorsa), socialCampaignId: concept.socialCampaignId ?? undefined, createdById})` →
  plana `{assetId, status:'QUEUED', attempts+1}` yaz (kare başına yaz). Kuyruk dolu → 30 s
  sonra tekrar (PRODUCE_MAX_WAITS ile sınırlı). (2) Tüm kareler terminal değilse 30 s sonra
  tekrar; her turda asset satırlarını okuyup `status/url/error`i plana yaz. FAILED/BLOCKED kare
  `attempts < 2` ise otomatik bir kez daha istenir. (3) Konsept DISCARDED olduysa iş durur.
- Plan yazımı: `updateMany where {id, workspaceId}` ile taze okunan planın üstüne; yalnız
  `shots[i].keyframe` ve `storyboard` alanlarına dokunur.

### 5.5 `produce` iki faz (`concept-promotion.service.ts`)

Plan storyboard'lu ise (`plan.storyboard` var):

- **Faz A — kareler:** `keyframe`i olmayan beat'lere `StoryboardService.submitFrames`
  (aynı kod; `campaignItemId: item.id` ile → motor cüzdanı ön borcu). Herhangi bir kare
  QUEUED/GENERATING ise `reschedule` (30 s). FAILED/BLOCKED ve attempts<2 → yeniden iste;
  aksi halde `fail(item, "frame i/N could not be generated: …")`. Hepsi READY → Faz B.
- **Faz B — canlandırma:** mevcut döngü, farkla: `referenceImageUrls: [shots[i].keyframe.url]`
  (firstImage), `model: production.model` (animate), `seed` plan seed'i, persona referansları
  gönderilmez. `generatedAssetIds` yalnız klipleri taşır (kare id'leri plandadır) —
  `confirmItem`/montaj değişmez.

Plan storyboard'suz (eski) ise bugünkü tek fazlı yol.

### 5.6 API

- REST (`marketing-content-line.controller.ts`, `campaigns.write`, audit):
  `POST /marketing/content-line/concepts/:id/storyboard`,
  `POST /marketing/content-line/concepts/:id/storyboard/:ord/regenerate`. Yanıt: güncel konsept
  satırı (plan içinde kareler).
- MCP: `jeeta.storyboard_content_concept { conceptId, regenerateShot? }` (WRITE, deferred,
  `campaigns.write`). `list_content_concepts` zaten tam planı (kare URL'leri dahil) döndürür.
- MCP açıklamaları güncellenir: plan/submit ("her beat için bir anahtar kare + o kareden
  canlandırma; kotasyonda kare satırı"), review ("onay kareleri (yoksa) ve klipleri satın alır").

### 5.7 Hub (`BatchDetail.tsx`)

Her konsept kartına: kotasyon satırı (`production.credits`, `usd`, model etiketi, kare modeli);
beat şeridi — her beat için kare (thumb) ya da durum yer tutucusu, `scene`, `durationSec`,
`onScreenText`; "Storyboard oluştur" (hiç kare yokken, PROPOSED/APPROVED-üretilmemiş) ve
kare başına "Yeniden üret". Kareler bekliyorken 10 s'de bir yenile. Tipler
`contentLine.service.ts`'e eklenir (`ShotPlan` alt kümesi). i18n: tr + en anahtarları.

## 6. Hata ve kenar durumları

- Kare üretimi kalıcı başarısız → onaydan önce ise kart uyarır (yeniden üret düğmesi); üretimde
  ise item FAILED, beat numarasıyla; metinden-video'ya sessiz geri düşüş **yok**.
- Onay sırasında kareler uçuşta → produce Faz A bekler (30 s tur, `PRODUCE_MAX_WAITS`).
- Kare asset'leri kapsamsız konseptte `socialCampaignId` null → 30 gün sonra sweep'e tabi;
  promote sırasında kare asset'lerinin `socialCampaignId`si kampanyaya güncellenir.
- `MAX_INFLIGHT=4`: 4+ beat'li konseptte kareler sıraya girer; iş kuyruk-dolu turunu tekrar eder.
- Storyboard işi ile produce aynı plana yazabilir; ikisi de taze okuyup dar alana yazar,
  storyboard işi konsept APPROVED+üretimde ise sonlanır.
- Eski planlar: `storyboard` yok → değişmeyen yol; `POST storyboard` 400.

## 7. Test

- Katalog: yeni girdi sözleşmesi/fiyat pin'leri, `animateModelFor` kardeş eşlemesi,
  `mediaModelAcceptsFirstImage`, Runware bağlaması + recipe.
- `planShots`: description/keyframePrompt/storyboard.seed; keyframePrompt'ta video son eki yok.
- `quoteProduction`: kare satırı + toplamlar; `resolveVideoModel` storyboard dalı (default,
  kardeş, persona).
- `StoryboardService`: submit (kuyruk dolu tekrar), sync (READY/FAILED/BLOCKED), regenerate,
  DISCARDED'da durma, eski plan reddi.
- `produce`: Faz A bekleme/başarısızlık/yeniden deneme, Faz B `referenceImageUrls=[url]`,
  `generatedAssetIds` yalnız klipler; eski plan yolu değişmez.
- Controller + MCP aracı; `assertQuoteHolds` kare modeli.
- Frontend: BatchDetail kare şeridi/aksiyonlar (vitest); Playwright e2e mevcut hub testi.
- Gerçek-DB e2e `concept-promotion.realdb`: storyboard akışı (kareler → klipler).
