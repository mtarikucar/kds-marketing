# Satış hattı ile kişinin birleşmesi

Tarih: 2026-08-30
Durum: tasarım — sahip iki kararı doğrudan verdi (hattın yeri, hatta olmayanlar)

Devamı olduğu belge: `2026-08-29-kisi-birincil-yuzey-design.md` (konuşma kişinin
bir alanı oldu). Bu belge aynı şeyi anlaşma için yapıyor.

## Ölçüm — 2026-08-30, canlı

| | |
|---|---|
| Kişi | **363** |
| Satış hattındaki anlaşma | **2** (biri sentetik test, `[TEST] Yaşam döngüsü`) |
| Gerçek anlaşma | **1** — Happy Day Organizasyon, 45.000 ₺, OPEN |
| Hatta olmayan kişi | **361** |

Hat boş değil çünkü satış yok; **işin olduğu yerden uzakta durduğu için kimse
beslemiyor.** Konuşmalarda yaşanan kopukluğun aynısı.

## İki ölçülmüş kopukluk

1. **`Opportunity.leadId` nullable, FK yok, Prisma ilişkisi yok** (`schema.prisma:3931`)
   — tıpkı `Conversation.leadId` gibi. Hat, kimseye ait olmayan anlaşma tutabiliyor.
2. **Aşama değişimi kişinin akışına hiç düşmüyor.** `opportunities.service.ts`
   içinde tek bir `LeadActivity` yazımı yok. Bir anlaşma "Teklif gönderildi"ye
   taşındığında o kişinin geçmişinde izi olmuyor.

İkincisi bu işin asıl bedeli: v2.284.0 mesajı ve aramayı tek akışa topladı,
**satış hareketi hâlâ o akışın dışında.**

## Kararlar

### 1 · Anlaşma kişinin bir alanı olur — VE tahta kalır (sahibin kararı)

**Kayıt kartında `SATIŞ` bölümü:** anlaşma adı, değeri, beklenen kapanış ve
**aşama seçici**. Aşama oradan taşınır; sayfadan çıkmak gerekmez. Anlaşması
olmayan kişide bölüm "Hatta ekle" sunar.

Bir kişinin **birden fazla** anlaşması olabilir (`leadId` çoğa-bir). Kart hepsini
listeler; tek anlaşma en sık hâl ve tek satır olarak görünür.

**`/opportunities` tahtası kalır**, ama kartlar anlaşma değil **kişi** gösterir:
kişinin adı birincil, anlaşma değeri ve son teması ikincil. Günlük iş kişiden
yürür; tahta tahmin ve genel bakış için durur.

`/opportunities` frozen 50-yol kümesinin üyesi; rota silinmez.

### 2 · "Hatta değil" sütunu (sahibin kararı)

Tahtanın **en solunda**, sayısıyla: açık anlaşması olmayan kişiler. Sürükleyip
bir aşamaya bırakmak o kişiye anlaşma açar.

Gerekçe, önceki spec'in gerekçesiyle aynı: **361 kişinin hatta olmaması bugün
hiçbir ekranda görünmüyor.** Tahtayı yalnızca anlaşması olanlara açmak, sessiz
çoğunluğu yine görünmez kılardı — tam olarak bugünkü hâl.

Sütun **sayfalanır**. 361 kart tek seferde çizilmez.

### 3 · Satış hareketi akışa düşer

Anlaşma açılışı, aşama değişimi, kazanıldı ve kaybedildi birer `LeadActivity`
olarak yazılır ve `GET /leads/:id/timeline` onları `kind: 'status'` ayrımıyla
döndürür. Böyle olmazsa "iletişim ile alakalı her şey tek akışta" cümlesi
satış için yalan olur.

Yazım anlaşmanın kendi işlemi **içinde** olur; ayrı bir yol değil.

## Menüdeki artık — düzeltilir

`navigation.ts:255-256` hâlâ `/inbox` ve `/leads`'i **iki ayrı madde** olarak
listeliyor, ikisi de v2.284.0'dan beri aynı bileşeni render ediyor
(`App.tsx:137-140`, ayırt edici prop yok). Menüde tek madde kalır; **iki rota da
korunur** (yer imleri + frozen küme).

## Korunacaklar

- Frozen 50-yol kümesi — liste (`PATHS_BEFORE_THE_SURFACE_MERGE`) harfi harfine
  korunur. **Düzeltme (2026-08-31):** bu satır önce "`navigation.test.ts`
  değiştirilmez" diyordu; yanlıştı. Menü tek maddeye indiğinde `/inbox` bir
  menü maddesi olmaktan çıkıp `/leads`'in **alias**'ı oldu — rota, yer imi ve
  `findActiveHub` çözümü yerinde kaldı. Testin `allPaths` toplamı yalnızca
  maddelerin kendi `path`'lerini sayıyordu, dolayısıyla hiçbir rota
  kaybolmadığı hâlde donmuş liste ile karşılaştırma kırmızıya düşerdi. Tek
  satır değişti: toplam artık çocukların `path`'ini **ve** `aliases`'ını
  topluyor (`navigation.test.ts:193-196`). Donmuş listenin kendisi hiç
  oynamadı ve hâlâ ısırıyor — bir rotayı gerçekten silen refactor yine kırmızı
  verir.
- Sürükle-bırak aşama taşıma, tahmin çubuğu, `?deal=` derin bağlantısı
- v2.284.0'ın kazanımları: tek liste, tıklamanın gezinmemesi, tek akış,
  `unread`/`truncated`/`gated` ayrımı
- Kiracı izolasyonu: "hatta değil" sorgusu ham SQL gerektiriyor (ilişki yok),
  her yüklem kendi iddiasını düşürmeli

## Hata davranışı

Değişmez: hata ile boşluk ayrı. "Hatta değil" sütunu okunamazsa **adıyla** söyler;
`0 kişi` diye görünmez. Aşama taşıma başarısız olursa kart eski yerine döner ve
sebep yazılır — sessizce durmaz.

## Test

- **Birim:** aşama seçicinin taşıması; anlaşmasız kişide "Hatta ekle"; kartların
  kişi göstermesi; "hatta değil" sütununun sayfalanması
- **Gerçek-DB e2e:** "açık anlaşması olmayan kişiler" sorgusu gerçek Postgres'e
  karşı; **kiracı izolasyonu**; aşama değişiminin `LeadActivity` yazması ve
  akışta görünmesi
- Her davranış mutasyonla doğrulanır

## Kapsam dışı

- Tahmin (forecast) matematiği değişmez
- Birden fazla hat (pipeline) yönetimi
- Tek satın alma modeli (`2026-08-28-tek-satin-alma-modeli-design.md`)
