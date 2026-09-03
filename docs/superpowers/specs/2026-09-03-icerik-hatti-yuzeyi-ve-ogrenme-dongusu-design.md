# İçerik hattının yüzeyi ve öğrenme döngüsü

Tarih: 2026-09-03
Durum: tasarım onaylandı ("ikisini de yap" + "devam et")

## Sorun

Sahibin kendi cümlesi: *"tasarımsal ve akış olarak bir eksik var gibi."* Ölçünce
iki somut karşılığı çıktı.

**1 · Hattın bir evi yok.** `ContentConcept.batchId` ön yüzde **hiç geçmiyor**
(arandı, sıfır sonuç). O alanın tek varlık sebebi "bu beşi şu fikirden çıktı"
demekti; veritabanı bunu biliyor, hiçbir ekran bilmiyor. Bir fikrin başına
gelenler beş ayrı yerde duruyor: konseptler yalnızca MCP'de, üretim sosyal
kampanyalarda, planlanmış gönderi takvimde, etiketleme/iş birliği dağıtım
panelinde, performans raporlarda. Parçalar çalışıyor, bütün hiçbir yerde
görünmüyor.

**2 · Döngü kapalı değil.** `SocialPostMetric`'e dokunan tek şey
`social-planner`'ın içgörü servisleri; `content-concepts` tarafına **hiçbir bağ
yok**. Sistem "mühendislik açısı hikâye açısını üçe bir yendi" diyemiyor. Her
fikir sıfırdan başlıyor — hat çalışıyor ama **birikmiyor**. Bir içerik
hattından beklenen sezgi zamanla iyileşmesidir; bu hat iyileşmiyor.

## Keşif — zincir zaten bağlı

Bu iş büyük ölçüde **inşa değil bağlama**. Doğrulandı:

```
ContentConcept (batchId, angle)
   ↑ SocialCampaignItem.contentConceptId   @unique
   ↑ SocialPost.campaignItemId
   → SocialPostTarget (ağ başına)
   → SocialPostMetric (günlük: reach, impressions, engagements, …)
```

"Açı başına performans" **şema değişikliği olmadan** okunabiliyor.

| Var | Nerede |
|---|---|
| Konsept partileri, açı, çekim planı | `ContentConcept` (`batchId`, `angle`, `shotPlan`) |
| Parti içi ayrıksılık güvencesi | `concept-distinctness.ts` |
| Konsept → kampanya öğesi terfisi | `concept-promotion.service.ts` |
| Klip üretimi (gerçekten çalışıyor) | `MediaGenService`, `fal.provider.ts` |
| Öğe durum makinesi | `SocialCampaignItemStatus` (8 durum) |
| Yayın adaptörleri | `network-adapters.ts` |
| Günlük metrik toplama | `social-post-metric.service.ts` |
| Dağıtım/outreach planı ve taslakları | `marketing-content-distribution.controller.ts` |

**Eksik olan:** konseptlerin REST ucu ve arayüzü yok (yalnızca MCP), parti
kavramının görünür bir karşılığı yok, ve metrikten konsepte geri bağ yok.

## A · Growth Studio ana ekranı hattın kendisi olur

Bugün `/studio` bir araç rafı. Hattın merkezi hâline gelir; **yeni rota
açılmaz** — frozen yol kümesi korunur ve menüde öğe artmaz.

**Düzen:**

- **Üstte** fikir girişi ve o ana kadar öğrenilenler (açı performansı özeti)
- **Altında parti kartları**, yenisi üstte. Her kart bir fikrin tüm hayatı:
  kaynak fikir, kaç konsept, durum sayıları (onay bekleyen / üretimde / planlı /
  yayında), ve yayına çıktıysa erişim
- Mevcut araçlar `?view=tools` altında yerinde kalır

**Kart bir dallanma noktasıdır, ikinci bir uygulama değil.** Konsept → detayı,
öğe → sosyal kampanya, gönderi → takvim, performans → raporlar. Merkez
bilgilendirir; detay sayfaları yerinde kalır ve burada yeniden yazılmaz.

Bu kural bu deponun ödediği bir bedelden geliyor: lead birleşiminde "aynı şeyin
ikinci uygulaması" tuzağına girilmemesi için detay gövdesi kopyalanmamıştı
(`2026-08-29-lead-iletisim-birlesimi-design.md`, "Teslimde sapma"). Aynı
disiplin burada da geçerli.

## B · Öğrenme döngüsü: açı performansı

Yukarıdaki join'den açı başına performans okunur ve **iki yerde** görünür:
hub'da (ne işe yaradı) ve konsept üretilirken (üretimi yönlendirir).

### Sıralama ölçüsü: etkileşim oranı, erişim değil

`engagements / impressions`. Erişim saate, ağa ve şansa çok bağlı; gösterim
başına etkileşim açının kendi gücünü ölçer. Ham erişim yine gösterilir ama
sıralamayı o belirlemez.

### Az sayıya güvenilmez

Bir açı sıralanabilmek için en az **3 yayınlanmış gönderi** taşımalı. Altında
kalan açı "yeterli veri yok" der ve ağırlığa girmez. Aksi hâlde ilk şanslı
gönderi hattı kilitler.

### Müdahale ve keşif

Üretmeden önce sistemin o anki ağırlığı **görünür ve değiştirilebilir**.
Ayrıca her partide en az bir slot **keşfe** ayrılır — sistem tek açıya çökemez.
Her konsept neden seçildiğini taşır (`selectionReason`), böylece "bu beş neden
bunlar" sorusu cevaplanabilir kalır.

### Soğuk başlangıç dürüst olur

Veri yokken tarafsız üretir ve **bunu söyler**. Sessizce rastgele davranmaz.

Bugün canlıda bağlı hesap sıfır, yayınlanmış gönderi sıfır: döngünün girdisi
**boş**. Panel ilk gün "henüz veri yok" diyecek ve bu doğru davranış; hesaplar
bağlandığı anda kendiliğinden dolar. Bu, bilinen ve kabul edilen durum.

## Hata davranışı

Hub'ın panelleri **bağımsız** yüklenir ve bağımsız başarısız olur. Açı
performansı okunamazsa parti kartları gelmeye devam eder ve okunamayan bölüm
**adıyla** söyler.

Boş ile kırık ayırt edilmek zorundadır. Gerekçesi ölçülmüş: sabah brifinginin
sekiz sorgusu `.catch(() => 0)` ile yutuluyordu (v2.271.0'da düzeltildi) ve
Takvim görünümü 126 jsdom testi yeşilken hiçbir şey render etmiyordu. "Veri yok"
ile "okunamadı" aynı görünürse bu hata tekrar eder.

## Test

- **Birim:** açı sıralaması (eşik altı açı sıralanmaz), keşif slotunun her
  zaman ayrılması, ağırlık müdahalesinin üretime yansıması, soğuk başlangıçta
  tarafsız üretim + açık mesaj, parti kartı durum sayıları
- **Gerçek-DB e2e:** açı performansı sorgusu gerçek Postgres'e karşı. Birim
  testleri Prisma'yı mock'luyor ve mock her `where`'i kabul ediyor;
  `workspaceId: { in: [id, null] }` sekiz hafta boyunca yeşil bir paketle
  fırlamıştı
- **Kiracı izolasyonu:** yabancı workspace'in partileri ve metrikleri dönmemeli
- **Frozen yol kümesi bozulmamalı:** yeni rota eklenmiyor
- Her davranış mutasyonla doğrulanır — silindiğinde düşmeyen test kabul edilmez

## Kapsam dışı

- Dağıtım/outreach akışının kendisi değişmez; hub ona **dallanır**
- `FULL_AUTO`'da öğelerin `NEEDS_APPROVAL`'da beklemesi ayrı bir karar; bu spec
  onu çözmez
- Sosyal kampanya board'unun yeniden tasarımı
