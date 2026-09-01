# İçerik üretim hattı: fikirden yayına, dağıtımıyla

Tarih: 2026-09-01
Durum: tasarım — sahip iki kararı doğrudan verdi (giriş noktası, dağıtımın sınırı)

## Sahibin talimatı

Bir kampanya fikri okuyup "bu güzelmiş" dediğinde sistem onu baştan aşağı
planlasın: tek fikirden birden çok video konsepti çıkarsın, her biri çekim çekim
(sahibin kendi örneği: `0–2 sn Strandbeest yürüyor / ekranda "Bunun motoru yok"`).
Onaylananların videoları hazırlansın, yayın takvimine düşsün, saati gelince
yayınlansın. Hangi modelin kullanılacağı ayarlardan seçilebilsin. Ve yayın için
kapsayıcı bir growth stratejisi çıksın — kiminle iletişime geçilecek, ne
etiketlenecek, diğer platformlarda nasıl yönlendirme yapılacak.

## Ölçüm — zincirin gövdesi zaten var

| Var olan | Nerede |
|---|---|
| Kampanya + öğe modeli, brief, kadans, hedef hesaplar | `SocialCampaign` / `SocialCampaignItem` |
| **Tam yaşam döngüsü** | `PLANNED → GENERATING → NEEDS_APPROVAL → APPROVED → SCHEDULED → PUBLISHED` (+ FAILED, SKIPPED) |
| Çekim planlayıcı — sahne, seslendirme, prompt, süre, kamera notu | `video/video-pipeline.service.ts`, `ShotPlan`/`Shot` |
| Persona kilidi (karakter tutarlılığı) | `video/video-persona.service.ts` |
| Gerçek video üretimi (fal.ai), varlık yoklama | `jeeta.generate_video`, `ai/media/media-gen.service` |
| Fiyatlı model kataloğu | `ai/media/media-models.config.ts`, `MEDIA_MODELS` |
| Kampanya başına model seçimi | `SocialCampaign.defaultImageModel` / `defaultVideoModel` |
| Kaynak içerikten yapı çıkarma | `trends/trend-remix.service.ts` |

**Bu iş büyük ölçüde inşa değil, bağlama** — bu oturumun üçüncü kez karşılaştığı
şekil.

## Ölçülen üç boşluk

1. **Çekim planı kampanyaya bağlı değil.** `grep ShotPlan social-campaigns/`
   hiçbir şey döndürmüyor; `VideoPipelineService`'in tek çağıranı persona
   controller'ı. Bir kampanya öğesi bugün yalnızca bir `topic` dizesi taşıyor —
   sahibin yazdığı çekim çekim kurgu hiçbir yerde saklanmıyor.
2. **"Tek fikirden N farklı açı" adımı yok.** `brief.topics[]` var ama aynı
   fikri beş ayrı kurguya açan bir şey yok.
3. **Dağıtım stratejisi hiç yok.** Outreach, etiketleme, çapraz platform
   yönlendirmesi — hiçbiri aranınca çıkmıyor.

Ve workspace düzeyinde model varsayılanı yok: yalnızca kampanya başına alan ve
kodda iki sabit (`DEFAULT_IMAGE_MODEL`, `DEFAULT_VIDEO_MODEL`).

## Kararlar

### 1 · Giriş noktası: sohbet (sahibin kararı)

Fikri ana ekrandaki sohbete yapıştırırsın. `CommandAiService`
(`POST /marketing/ai/command`) zaten Anthropic'e bağlı ve tüm MCP kataloğuna
erişiyor — yeni bir yüzey öğrenmek gerekmiyor.

Sistem tek fikirden **N ayrı konsept** çıkarır. Her konsept gerçek bir
`ShotPlan` taşır: saniye aralıkları, ekran metni, seslendirme, kamera notu.
Konseptler bir listeye düşer; onayladıkların üretime girer.

**Konseptler birbirinden gerçekten farklı olmalı.** Sahibin örneği bunu
gösteriyor: aynı Strandbeest fikri "motoru yok" (merak), "tekerleği bacağa
çevir" (mühendislik), "işlemcisiz yürüyebilir mi" (kavram), "oranları bilgisayar
seçti" (hikâye) ve konuşmasız satisfying kurgu olarak beş ayrı içerik. Aynı
metnin beş varyasyonu değil, **beş ayrı açı**.

### 2 · Dağıtım: plan üretilir, gönderimi insan yapar (sahibin kararı)

Her onaylanan video için bir dağıtım planı çıkar:
- kimlerle iletişime geçilecek (CRM kişileri + sosyal hesaplar)
- ne etiketlenecek
- hangi platformda ne zaman çapraz paylaşım/yönlendirme

**Mesaj taslakları hazırlanır ama gönderilmez.** Gönderme, kalem kalem insan
onayıyla olur.

Bu bir güvenlik kararı, üşengeçlik değil: tanımadığı hesaplara otomatik toplu
mesaj, platformların spam tespitine ve hesap kısıtlamasına açık bir davranıştır.
Sahip bunu bilerek seçti; ileride ölçüp gevşetmek ayrı bir karardır.

### 3 · Model seçimi ayarlara

Workspace düzeyinde varsayılan görsel ve video modeli eklenir; kampanya başına
mevcut alanlar **override** olarak kalır. Katalog dışı bir kimlik reddedilir —
fiyatı bilinmeyen model çalıştırılmaz (`generate_video` bu kuralı zaten
uyguluyor).

Ayarlar kartı her modelin **fiyatını** gösterir; bu üründe video en pahalı
eylem ve seçim maliyet kararıdır.

## Aşamalar

Tek seferde sevk edilmez.

1. **Fikir → konseptler**, her biri `ShotPlan` taşıyan. `video-pipeline` bağlanır;
   ikinci bir planlayıcı yazılmaz.
2. **Onay → üretim**: onaylanan konsept `SocialCampaignItem` olur, mevcut yaşam
   döngüsüne girer, `generate_video` ile klipler üretilir.
3. **Ayarlarda model seçimi** (workspace varsayılanı + fiyat).
4. **Dağıtım planı** — taslaklar, gönderim insanda.

## Bilinen kısıt: harcama kapısı

`generate_video` `SPEND` + `requiresApproval` (`MEDIA_SPEND`). Bu workspace
`APPROVAL` modunda, yani üretim her seferinde onaya düşer. v2.286.0'da ölçüldü:
onay yürütücüsü sonucu **onaylayanın HTTP cevabına** döndürüyor, ajanın turuna
değil — yani bir *veri çekme* aracı onayda kullanılamaz hâle geliyor.

`generate_video` bundan farklı: sonucu bir `assetId` ve iş asenkron; onaydan
sonra varlık `list_generated_media` ile yoklanıyor. Yani bu araç onay altında
**çalışır**. Uygulayan bunu doğrulamalı, varsaymamalı.

## Hata davranışı

Değişmez: hata ile boşluk ayrı. Bir konsept üretilemezse "fikir zayıf" gibi
görünmez; üretim başarısızsa öğe `FAILED` olur ve **sebebi yazılır**; dağıtım
planı çıkarılamazsa "dağıtım gerekmiyor" denmez.

## Test

- **Birim:** N konseptin gerçekten farklı olması (aynı metnin varyasyonu değil);
  `ShotPlan`'ın öğede saklanması; onay geçişleri; katalog dışı modelin reddi
- **Gerçek-DB e2e:** konsept → öğe → varlık zinciri ve **kiracı izolasyonu** —
  her `workspaceId` yüklemi kendi iddiasını düşürmeli
- **Dağıtım:** hiçbir mesajın onaysız gitmediğini iddia eden test — mutasyonla
  doğrulanır (otomatik gönderim eklenirse test düşmeli)
- jsdom Tailwind uygulamıyor: görünürlüğe bağlı her şeyin tanığı tarayıcıda,
  sınırın **içindeki** içeriğe bakan bir iddia olmalı

## Kapsam dışı

- Klip birleştirme/montaj (bugün yok; her çekim ayrı varlık)
- Yeni sosyal ağ entegrasyonu
- `mcpWriteMode`'un kendisi
