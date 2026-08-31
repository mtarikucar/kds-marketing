# Gelen kutusunu tek ekrana sığdırmak

Tarih: 2026-09-01
Durum: tasarım — sahip iki kararı doğrudan verdi (sol sütun, kalan üç madde)

Öncesi: `2026-08-29-kisi-birincil-yuzey-design.md` (konuşma kişinin alanı oldu),
`2026-08-30-satis-hatti-kisi-birlesimi-design.md` (anlaşma da), ve v2.285.0
(arama da). Bu belge kalanları topluyor.

## Sahibin talimatı

> "gelen kutusu içinde olan herşeyi hiç bir özelliği kaybetmeden olabildiğince
> tek ekrana işlevsel olarak sığdırmaya çalış"

**"Hiçbir özelliği kaybetmeden" bu belgenin en sert kısıtı.** Kanban sürükleme,
takvim düzenleme, toplu atama/silme/kayıt, CSV dışa aktarma, teklif/tahmini
fiyat/belge sekmeleri — hiçbiri silinmiyor. Sayfa silmiyoruz; **menüyü**
topluyoruz ve parçaları kişinin etrafında topluyoruz.

## Bugün gelen kutusunun altındaki dokuz madde

`Kişiler` · `Şirketler` · `Satış Hattı` · `Belgeler` · `Takvim` · `Randevular`
· `Görevler` · `Ses` · `Telefon Ağacı`

## Sınıflandırma — şemadan doğrulandı

| Nesne | Kişinin alanı mı | Kanıt |
|---|---|---|
| Konuşma · hareket · arama | ✓ zaten akışta | v2.284.0 / v2.285.0 |
| Anlaşma | ✓ zaten kayıt kartında | v2.285.0 |
| Görev | ✓ | `MarketingTask.leadId` |
| Teklif | ✓ | model adı **`LeadOffer`** |
| Tahmini fiyat | ✓ | `Estimate.leadId` |
| Randevu | ✓ | `Booking.leadId` |
| **Şirket** | ✗ kişilerin toplamı | `Company`'de `leadId` yok |
| **Ses · Telefon Ağacı** | ✗ kanal yapılandırması | `/calls` ile aynı sınıf |

Altısı kişinin alanı, üçü değil.

## Karar 1 · Sol sütun görünüm değiştirir (sahibin kararı)

Aynı kişi kümesi, dört diziliş: **Liste · Hat · Takvim · Görevler**.

Orta sütun (akış) ve sağ sütun (kayıt kartı) **her görünümde aynen kalır**.
Yani hattan birine tıklayıp aynı ekranda yazışmasını okursun; seçili kişi
görünüm değişince korunur.

Her görünüm kendi tam yeteneğini taşır: Hat'ta kanban sürükleme ve "Hatta değil"
sütunu, Takvim'de randevu düzenleme, Görevler'de tamamlama. `?view=table`
(toplu işlem + CSV) bugünkü gibi dişli menüsünde kalır.

## Karar 2 · Kalan üçü (sahibin kararı)

- **Ses** ve **Telefon Ağacı** → `Ayarlar › Telefon`, v2.285.0'da arama
  kayıtlarını taşıdığımız grubun yanına. Kanal yapılandırması, günlük iş değil.
- **Şirketler** → kişi listesinin bir **gruplaması** (`Grupla: Şirkete göre`).
  Şirket ayrı bir nesne olmaya devam eder ve `/companies` rotası durur; ama
  günlük iş kişiden yürüdüğü için menüde ayrı madde olmayı hak etmiyor.

Sonuç: **gelen kutusu menüde tek madde.**

## Rotalar korunur — pazarlık dışı

Frozen 50-yol kümesi `navigation.test.ts` ile sabit. `/companies`,
`/opportunities`, `/calendar`, `/tasks`, `/documents`, `/appointments`,
`/voice`, `/voice/ivr` **hepsi çözülmeye devam eder**; yer imleri kırılmaz.
Değişen tek şey menüde nerede göründükleri ve aynı işin tek ekrandan da
yapılabiliyor olması.

## Aşamalar

Tek seferde sevk edilmez; her aşama kendi başına yeşil ve geri alınabilir.

1. **Kayıt kartı kişinin kalanını alır** — Görevler, Teklifler, Tahmini fiyat,
   Randevular bölümleri. Lead detayındaki sekmelerle **aynı bileşenler**
   kullanılır; ikinci bir kopya yazılmaz (iki kopya = "hangisi doğru?" bedeli).
2. **Sol sütun görünüm değiştirici** — Liste · Hat · Takvim · Görevler.
3. **Şirkete göre gruplama.**
4. **Menü tekleşir; Ses ve Telefon Ağacı Ayarlar'a taşınır.**

## Hata davranışı

Değişmez: her sütun ve her bölüm **bağımsız** başarısız olur, ve okunamayan
kaynak **adıyla** söyler. Boş bir bölüm ile kırık bir bölüm ayırt edilebilmeli.
Kayıt kartında beş bölüm olacağı için bu kural daha da önemli: biri patlayınca
kart boşalmamalı.

## Test

- **Birim:** görünüm değişince seçili kişinin korunması; her görünümün kendi
  yeteneğini taşıması (kanban sürükleme, takvim düzenleme, görev tamamlama);
  bir bölümün hatasının diğerlerini düşürmemesi
- **Gerçek-DB e2e:** kayıt kartının beş kaynağı ve **kiracı izolasyonu** — her
  `workspaceId` yüklemi kendi iddiasını düşürmeli
- **Frozen yol kümesi bozulmamalı** — sekiz rota da çözülmeye devam etmeli
- **Özellik kaybı taraması:** taşınan her sayfanın yeteneklerinin hâlâ
  erişilebilir olduğunu iddia eden testler
- Her davranış mutasyonla doğrulanır

## Kapsam dışı

- Growth Studio
- Ayarlar'ın kendi iç düzeni
- Tek satın alma modeli
