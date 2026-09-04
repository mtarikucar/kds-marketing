# Hibrit medya sağlayıcı: fal.ai + Runware — tasarım

Tarih: 2026-09-04
Durum: onaylı yön ("hibrite çevir, sonra canlıya al"), otonom uygulama

## 1. Amaç

Jeeta'nın tüm AI medya üretimi tek sağlayıcı (fal.ai) üzerinden akıyor. 2026-09-04 fiyat
çalışması ([[fal-pricing-study-2026-09]]) şunu gösterdi: fal partner modellerde üretici
fiyatıyla birebir, ama birkaç modelde belirgin marj taşıyor. Aynı modeli Runware'den
almak katalogdaki beş serviste maliyeti %38–%97 düşürüyor; kalan modellerde ya fark yok
ya da Runware'de karşılığı yok.

Hedef: **model bazlı yönlendirme.** Katalogdaki her model varsayılan olarak fal'da kalır;
bir Runware bağlaması (`runware`) taşıyan model, Runware yapılandırılmışsa oradan
üretilir. Runware anahtarı yoksa her şey bugünkü gibi fal'dan gider ("ships dark").

Aynı değişiklik iki fal katalog sürüklenmesini de kapatır:

- Platform varsayılanı video modeli `fal-ai/bytedance/seedance/v1/lite/text-to-video`
  fal tarafından kaldırıldı; istekler sessizce Seedance 1.0 Pro Fast'e yönlendiriliyor
  ve o uç nokta 1080p'de varsayılan. Katalog çözünürlük göndermediği için her varsayılan
  video ~$0.0486/s'ye mal olurken müşteriye 3 kredi/s ($0.025 tabanı) kesiliyor.
- `fal-ai/veo3/fast` fal'da "deprecated"; Google Veo 3'ü 2026-06-30'da kapattı.

## 2. Kapsam

### 2.1 Runware'e yönlendirilen modeller (v1)

| Katalog id (fal) | Runware modeli | fal | Runware | Görev tipi |
|---|---|---|---|---|
| `bytedance/seedance-2.5/text-to-video` | `bytedance:seedance@2.5` | $0.473/s 720p | $0.2304/s | videoInference |
| `bytedance/seedance-2.5/image-to-video` | `bytedance:seedance@2.5` | $0.473/s 720p | $0.2304/s | videoInference + frameImages |
| `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video` (yeni varsayılan) | `bytedance:2@2` | $0.0216/s 720p | $0.01336/s | videoInference |
| `fal-ai/qwen-image` | `runware:108@1` | $0.02 | ~$0.0058 (20 adım) | imageInference |
| `fal-ai/birefnet/v2` | `runware:112@5` (General) | $0.02 | ~$0.0006 | imageBackgroundRemoval |

Seedance 2.5 katmanları Runware'de: 480p $0.1025/s, 1080p $0.61354/s. Pro Fast: 480p
$0.00629/s, 1080p $0.03177/s. Runware'in "from" fiyatları (Qwen, BiRefNet) hesaplama
süresine göre değişir; gerçek tutar her istekte `includeCost: true` ile okunur.

### 2.2 Bilinçli olarak dışarıda kalanlar

- `bytedance/seedance-2.5/reference-to-video`: Runware'de referans-görselden-video
  görevi yok (yalnız t2v/i2v/v2v). fal'da kalır.
- Seedream 5 Pro (t2i + edit) ve Nano Banana Pro edit: %8–%29 tasarruf, ama 2K boyut
  tuzağı ve referans-görsel eşlemesi ayrı doğrulama ister. Takip işi.
- Kling avatar, Topaz upscale, Qwen inpaint, LatentSync: zaten `withheld` (satışa
  kapalı); yönlendirmenin anlamı yok.
- ElevenLabs ailesi, VEED avatar, MMAudio, Bria product-shot, Wan FLF2V, PixVerse
  extend: Runware'de yok ya da fal daha ucuz.

### 2.3 Müşteri fiyatı (varsayım A)

Müşteriye kesilen kredi tablosu **değişmez.** Katalogdaki `credits*` alanları fal
liste fiyatından türetilmiş halde kalır; Runware farkı marja yazılır. Fiyatı düşürmek
ticari bir karardır ve tek satırlık bir katalog değişikliğidir (`creditsPerSec`), bu
tasarım onu vermez.

## 3. Mimari

### 3.1 Yönlendirici sağlayıcı

`MEDIA_PROVIDER` token'ı bugün doğrudan `FalProvider`'a bağlı. Yeni:

```
MEDIA_PROVIDER → RoutingMediaProvider
                   ├─ FalProvider      (taban; her model buradan gidebilir)
                   └─ RunwareProvider  (yalnız `runware` bağlaması olan modeller)
```

`RoutingMediaProvider implements MediaProvider`:

- `name = 'router'` (satıra hiç yazılmaz, aşağıya bak).
- `isConfigured()` = `fal.isConfigured()`. fal taban sağlayıcıdır; Runware tek başına
  yapılandırılmışsa ürün yine "yapılandırılmamış" sayılır, çünkü kataloğun büyük kısmı
  fal'sız üretilemez.
- `resolveName(model)`: `runware.isConfigured() && getMediaModel(model)?.runware`
  ise `'runware'`, aksi halde `'fal'`. Servis `GeneratedAsset.provider` sütununa
  **bunu** yazar; satır oluşturulduğu anda gerçek sağlayıcı bellidir.
- `submit(opts)`: `resolveName` ile seçer. Runware'den dönen istek kimliğini
  `runware:<taskUUID>` biçiminde önekler; fal kimliği çıplak kalır. Böylece mevcut
  satırlar ve fal webhook'u (`finalizeByRequestId(request_id)`) hiç değişmez.
- `getResult(requestId, model)`: önek varsa Runware'e (önek soyularak), yoksa fal'a.
  Yönlendirme **istek kimliğine** göre yapılır, modele göre değil: anahtar sonradan
  eklendiğinde uçuştaki fal işleri fal'da sorulmaya devam eder.

`MediaProvider` arayüzüne tek ekleme: `resolveName?(model: string): string`. Servis
`this.provider.resolveName?.(model) ?? this.provider.name` kullanır; mevcut test
sahteleri (`{ name: 'fal', ... }`) değişmeden çalışır.

### 3.2 RunwareProvider

- Kimlik: `RUNWARE_API_KEY` env; yoksa `isConfigured() = false`.
- Taşıma: tek uç nokta `POST https://api.runware.ai/v1`, gövde görev dizisi, `Authorization: Bearer`.
  Zaman aşımı `RUNWARE_TIMEOUT_MS` (varsayılan 30 s), fal'daki gibi.
- Her görev `deliveryMethod: 'async'`, `outputType: 'URL'`, `includeCost: true`,
  istemci tarafında üretilen `taskUUID` (uuid v4) ile gönderilir. Dönen `taskUUID`
  istek kimliğidir.
- `getResult`: `getResponse` görevi; işleniyorsa `IN_PROGRESS`, hata dönerse
  `FAILED`/`BLOCKED`, bitti ise çıktı URL'si + `cost` ile `COMPLETED`.
- Gövde, fal'daki gibi **model sözleşmesinden** üretilir (`buildRunwareTask`): en-boy
  → çözünürlük katmanına göre `width`/`height` tablosu, süre → `duration`, kaynaklar →
  `frameImages` / `inputImage`, ses → `providerSettings`. Bilinmeyen parametre
  gönderilmez; tam alan adları uygulama sırasında Runware belgelerinden doğrulanır ve
  `runware.provider.contract.spec.ts` ile ağa çıkmadan sabitlenir.
- Moderasyon: hata mesajı `BLOCK_RE` ile eşleşirse ya da yanıt NSFW işaretliyse
  `BLOCKED` (iade); diğer hatalar `FAILED`.
- v1 **yalnız poll.** Mevcut poll döngüsü (20 s + 30 s tekrar, 1 saat tavan) yeterli;
  Runware webhook'u ayrı bir takip işi.

`MediaGenResult`'a isteğe bağlı `costUsd?: number` eklenir: sağlayıcının bildirdiği
gerçek satıcı maliyeti. fal bunu doldurmaz.

### 3.3 Katalog

`MediaModel`'e iki alan:

```ts
/** Bu model Runware'den de alınabilir. Fiyat alanları Runware'in liste fiyatı. */
runware?: { model: string } & MediaRate & { tiers?: Record<string, MediaRate> };
/** Bu id fal'da kaldırıldı; istek `replacedBy` hedefine gider. */
replacedBy?: string;
```

Yeni yardımcılar:

- `resolveMediaModelId(id)`: `replacedBy` zincirini (sınırlı) izler.
- `listMediaModels` (menü): `withheld` gibi `replacedBy` taşıyanları da düşürür.
- `assertCataloguedModel` (yazma kapısı): `replacedBy` taşıyan id'yi **reddeder**;
  seçenek listesinde göstermez. `isCataloguedModel` (okuma/doğrulama) aliased id için
  `true` kalır, saklanmış tercihler çalışmaya devam eder.
- `estimateVendorUsd(model, opts, provider)`: `provider === 'runware'` ise `runware`
  fiyat alanlarıyla, değilse modelin kendi alanlarıyla hesaplar. Kredi tahmini
  değişmez.

Varsayılan değişikliği:

- `DEFAULT_VIDEO_MODEL = 'fal-ai/bytedance/seedance/v1/pro/fast/text-to-video'`.
  Sözleşme: `resolution {480p,720p,1080p} default 720p` (her zaman açıkça gönderilir),
  `duration` rakam-string enum 2–12, en-boy `21:9,16:9,4:3,1:1,3:4,9:16`. Fiyat:
  720p $0.0216/s → 3 kredi/s; katmanlar 480p $0.0097/s → 1, 1080p $0.0486/s → 5.
- Eski Lite girdisi kalır, `replacedBy` yeni varsayılanı gösterir; fiyat sabitleri
  (3 kredi/s) eski satırlar için korunur.
- `fal-ai/veo3/fast` kalır, `replacedBy: 'fal-ai/veo3.1/fast'`.

`requestGeneration` model kimliğini (açık ya da varsayılan) çözer, alias uygulanmışsa
uyarı loglar ve satıra **çözülmüş** id'yi yazar. `MediaModelDefaultsService.project`
aliased saklı tercih için `effective*` olarak hedefi döndürür (`retired*` boş kalır:
tercih hâlâ çalışıyor).

### 3.4 Maliyet defteri

- `GeneratedAsset.costUsd`: oluştururken fal tahmini (temkinli; motor cüzdan ön
  borcu da bunu kullanır). Finalize'de Runware satırları için sağlayıcının bildirdiği
  gerçek USD (yoksa `estimateVendorUsd(..., 'runware')`) yazılır; motor cüzdanı ise **katalog fiyatından** mutabakat yapılır (`reconcileEngineWallet` `estimateMediaUsd` ile): müşteriye dönük ücret her iki sayaçta da kataloğun ücretidir, satıcı farkı marjdır (§2.3). Satıcı USD'si yalnız defter kaydıdır.
- `MediaSpendService.settle(ws, { assetId, credits, vendor, vendorUsd })`:
  `vendor === 'runware'` ise `CONTENT / RUNWARE_CENT` tarifesi, miktar `vendorUsd × 100` **kesirli cent** (4 hane; BiRefNet $0.0006 = 0.06 cent, tam cente yuvarlansa ya düşer ya 17 kat yazılırdı); aksi halde bugünkü `FAL_CREDIT` yolu.
- Tarife tohumu: `20260904120000_seed_runware_cent_tariff` — platform satırı
  `('CONTENT','runware','RUNWARE_CENT', 0.4000 TRY)`; `FAL_CREDIT` ile aynı kur
  varsayımı. `migration.sql` + `down.sql` (yalnız o platform satırını siler).
- `TariffUnitType`'a `'RUNWARE_CENT'`; `VENDOR_UNITS`'e Runware satırı, rapor iki
  satıcıyı ayrı gösterir.

### 3.5 Ortam ve dağıtım

- `RUNWARE_API_KEY` (isteğe bağlı; boş = tüm trafik fal), `RUNWARE_TIMEOUT_MS`.
- `deploy.yml`: `FAL_KEY` ile aynı iki noktaya (secrets geçişi + `.env` satırı).
- GitHub secret **kullanıcı tarafından** eklenir; kod anahtarsız dağıtılır ve fal ile
  bugünkü gibi çalışır. Anahtar eklenip yeniden dağıtıldığında yönlendirme açılır.

## 4. Hata ve kenar durumları

- Runware poll'u geçici hata verirse (429/5xx, adressiz `rateLimit`/`timeout` kodu)
  iş uçuşta kalır (`IN_PROGRESS`); Runware render'ı bitirip faturalıyor, satırı
  FAILED yapıp iade etmek hem müşteriyi hem defteri yanıltırdı. Yaş tavanı sınırlar.
- Runware `submit` başarısız → mevcut `catch` yolu: satır FAILED, kredi iadesi. fal'a
  otomatik geri düşüş **yok** (çift ücret riski, farklı fiyat); operatör anahtarı
  kaldırarak tüm trafiği fal'a döndürür.
- Runware sonuç URL'si 7 gün geçerli; finalize zaten R2'ye kopyalıyor.
- Yarış: webhook yalnız fal'da var; Runware yalnız poll → tek finalize yolu.
- Alias hedefi de aliased ise zincir en fazla 3 adım izlenir; döngü tespitinde orijinal
  id kullanılır ve loglanır.

## 5. Test

- `media-models.config.spec`: alias çözümü, menü dışlaması, yazma kapısı reddi, yeni
  varsayılan sözleşmesi (720p açık, rakam-string süre, 4:5 yok), kredi/USD katman
  sabitleri, beş `runware` bağlaması.
- `routing.provider.spec`: sağlayıcı seçimi (anahtar var/yok), önek kodlama/çözme,
  `resolveName`, `isConfigured` = fal.
- `runware.provider.contract.spec`: model başına gövde şekli (ağsız), yanıt eşleme
  (URL, cost, NSFW → BLOCKED, hata → FAILED), `getResponse` durumları.
- `media-gen.service.*.spec`: alias uygulanmış model satıra yazılır; `provider`
  sütunu `resolveName`'den gelir; Runware satırında finalize `costUsd`'yi gerçek
  maliyetle günceller ve `settle`'ı `vendor:'runware'` ile çağırır.
- `media-spend.service.spec`: `RUNWARE_CENT` yolu ve miktar yuvarlama.
- `media-model-defaults.service.spec`: aliased saklı tercih → effective hedef.
- Migration: up → down → up tur atlatılır.
- Mevcut 12 spec'teki `fal-ai/veo3/fast` "komşu model" kullanımları
  `fal-ai/veo3.1/fast`'e taşınır (yazma kapısı artık reddediyor).

## 6. Yayın

1. PR → CI yeşil → main'e merge → etiket → deploy (anahtarsız, davranış değişikliği
   yalnız varsayılan video modelinin 720p'ye sabitlenmesi ve iki alias).
2. Kullanıcı Runware hesabı açar, `RUNWARE_API_KEY` secret'ını ekler, yeniden deploy.
3. İlk canlı Seedance 2.5 üretimi sonrası satıcı raporu ve `costUsd` kontrol edilir.
