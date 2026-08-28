# Panel bilgi mimarisi: 15 hub → 3 yüzey

Tarih: 2026-08-28
Durum: tasarım onaylandı, uygulama planı bekliyor

## Sorun

Panelde 15 üst düzey hub ve 52 sayfa var. Kullanıcı ne yapacağını bulmak için
gezinmek zorunda; sistemin arkada ne yaptığı ise hiçbir ekranda görünmüyor.

Ölçüm (2026-08-28, canlı): 41 zamanlanmış iş koşuyor ve bunların hiçbiri panelde
görünmüyor. 363 lead sahipsiz, 2 konuşma cevapsız — bu ikisi aynı türden ihmal
ama bugün ayrı ekranlarda durdukları için birinden diğeri fark edilmiyor.

## Hedef

Üç yüzey ve bir ayarlar bölümü. Hiçbir özellik silinmez; yeri değişir veya
kullanılana kadar rafın altında bekler.

| Yüzey | İçerik |
|---|---|
| **Ana ekran** (`/home`) | Sol %38 sekmeli (Takvim ⋮ Akış) · Sağ %62 sohbet |
| **İletişim** | Kişi birincil tek liste; yazışma kişinin bir alanı |
| **Growth Studio** | Araştırma, kampanya, sosyal, reklam, içerik, raporlar |
| **Ayarlar** | Strateji, otomasyonlar, ekip, entegrasyon, modüller |

Eriyenler: `calendar`, `tasks`, `sales`, `strategy`, `automation`, `reports`,
`voice`, `payments`, `sites`, `memberships`, `agency`.

- `sales` → İletişim (kişinin alanı)
- `calendar`, `tasks` → Ana ekran takvimi
- `strategy`, `automation`, `agency` → Ayarlar
- `reports` → Growth Studio
- `voice` → İletişim (bir kanal)
- `payments`, `sites`, `memberships` → Ayarlar › Modüller; ilk kayıt oluştuğunda
  kendi yerini alır

## Ana ekran

### Düzen

Sol sütun %38, sekmeli — Takvim ve Akış aynı anda görünmez. Bu bilinçli bir
takas: her panele iki kat yer düşüyor. Kaybı telafi etmek için **Akış sekmesinde
uyarı rozeti** durur; takvime bakarken bir iş düştüğünde sekme kendini belli
eder.

Sağ sütun %62, sohbet.

### Takvim — dört kaynak, tek zaman ekseni

1. **Sistem işleri** — `SchedulerRegistry`'deki cron'ların `nextAt` değeri
   (bugün yalnızca MCP'den okunabiliyor, REST karşılığı yok)
2. **Görevler** — `MarketingTask.dueDate`
3. **Randevular** — rezervasyonlar ve takvim entegrasyonu
4. **Kampanya/gönderi tarihleri** — `SocialCampaign`, `Campaign.scheduledAt`,
   planlanmış gönderiler.

   Statü kuralı: **`CANCELLED` gösterilmez, `DRAFT` gösterilir.** Takvim "ne
   gelecek" sorusuna cevap veriyor; iptal edilmiş bir kampanya tanımı gereği
   gelmeyecek olan şey ve bu servis aynı mantıkla iptal edilmiş randevuyu
   (`CONFIRMED` filtresi) ve iptal edilmiş görevi (`PENDING`/`IN_PROGRESS`
   filtresi) zaten dışarıda bırakıyor. Aynı `Promise.all` içinde iki kaynakta
   eleyip iki kaynakta almanın gerekçesi olmazdı.

   `DRAFT` bunun tersi: tarihi gelmiş ama hâlâ taslak olan bir kampanya,
   sahibinin görmesi gereken bir aksaklıktır — bugün canlıda 18 Ağustos'ta
   başlayıp 30 Eylül'de biten sezon kampanyası tam olarak bu durumda ve hiçbir
   ekran bunu söylemiyor. `SENT`/`PAUSED`/`COMPLETED` de kalır: geriye bakılan
   bir pencerede meşru geçmiştir.

Yeni uç: `GET /marketing/home/timeline?from=&to=`. Dört kaynağı sunucuda
birleştirir ve her satıra bir `kind` ayırıcısı koyar (`system` | `task` |
`appointment` | `campaign`). Arayüz bunu görsel olarak ayırır: **sistem işleri
soluk ve arka planda, insanın işi belirgin.** Ayırmazsak dört kaynak lapa olur.

### Akış — şu an ne oluyor

Kaynaklar:
- `ScheduledJob` satırları (arka plan işleri; statü, deneme, son hata)
- Cron kalp atışları (`ageMinutes` ile — v2.281.0)
- **Sohbetin yaptığı işler** (aşağıya bakınız)

15 saniyede bir yoklama. Canlı akış hissi için yeterli; SSE'ye gerek yok ve
panelin geri kalanı zaten yoklama kullanıyor.

### Sohbet — tam yetkili

Yeni servis yazılmayacak. `CommandAiService` (`POST /marketing/ai/command`)
zaten mevcut ve gerekli olan her şeyi yapıyor:

- Anthropic'e bağlı, tüm MCP kataloğuna erişiyor (`MCP_ALL_SCOPES`)
- İşi `broker.invoke` üzerinden yapıyor → onay kapısı, denetim kaydı ve kiracı
  izolasyonu otomatik geçerli
- `{ answer, actions: { tool, status, approvalId }[] }` döndürüyor
- `MAX_ITERS = 8`, dakikada 6 istek sınırı

**Yetki kararı:** sohbet tam yetkili çalışır (`mcpWriteMode: AUTONOMOUS`), yani
onay sormaz. Bunun dengesi görünürlük:

- Dönen `actions[]` dizisinin her elemanı **anında akış paneline düşer**
- Geri alınabilir olanlarda satırın yanında **"geri al"** durur
- Yani sözleşme "onay yok" değil, **"tam görünürlük + geri alma"**

Geri alınabilirlik araca göre belirlenir ve tahmine bırakılmaz. Kural:
**yalnızca sistem içinde kalan yazmalar geri alınabilir.**

| Geri alınabilir | Geri alınamaz |
|---|---|
| atama, durum/aşama değişikliği, not, etiket, konuşma kapatma, taslak oluşturma | gönderilen mesaj, yayımlanan gönderi, harcanan bütçe, kesilen fatura, silme |

Geri alınamayan bir iş akışta **geri al düğmesi olmadan** görünür; satır bunu
açıkça söyler ("gönderildi — geri alınamaz"). Var olmayan bir düğme, olmayan bir
güvenceden iyidir.

Uygulama notu: geri alınabilirlik araç kaydından türetilir (`risk` ve fiil),
elle tutulan bir listeden değil — elle liste, yeni araç eklendiğinde sessizce
eksik kalır.

Bilinen risk, kayda geçiriliyor: MCP denetimi (2026-08-27) onay kapısının risk
sınıfına değil araç başına `requiresApproval` bayrağına bağlı olduğunu gösterdi.
AUTONOMOUS modda `approve_strategy_action` gibi bir araç, ürünün kendi otonom
şeridinin geçemediği `GROWTH_AUTOPILOT_AUTONOMY` kill-switch'ini atlar. Bu
tasarım o davranışı canlı hale getirir. Sahibin bilinçli kararı; kapıyı risk
sınıfına bağlamak ayrı bir iş olarak açık duruyor.

## İletişim — kişi birincil

Tek nesne var: **kişi**. Konuşma onun bir alanı. Gerekçe kullanıcının kendi
cümlesi: *"iletiştiğimiz kişiler zaten kayıt olan kişiler."*

Üç sütun: liste (%34) · yazışma · kayıt kartı (%26).

Listenin üstünde iş kuyruğu filtreleri, sayılarıyla:
`Bekleyen 2` · `Atanmamış 363` · `Hepsi`

Bu, konuşma-öncelikli bir listenin yaratacağı körlüğü engelliyor: 363 lead'in
hiç yazışması yok (araştırmadan geldiler), konuşma sekmesinde olsalardı bugün
olduğu gibi görünmez kalırlardı.

## Hata davranışı

Panellerin her biri **bağımsız** başarısız olur. Bir kaynağın kırılması ana
ekranı boşaltmaz.

Bu kural sabittir ve gerekçesi ölçülmüştür: sabah brifinginin sekiz sorgusu
`.catch(() => 0)` ile yutuluyordu, yani "sorgu patladı" ile "raporlanacak bir şey
yok" aynı görünüyordu (v2.271.0'da düzeltildi). Aynı hatayı burada tekrarlamak
yasak.

- Takvimin bir kaynağı okunamazsa: diğer üçü gelir, üstte **adıyla** söylenir —
  *"takvimin 1 kaynağı okunamadı: sistem işleri"*
- Akış okunamazsa: sekme boş değil, hata durumu gösterir
- AI kredisi yoksa sohbet **açıkça** söyler; dönmeyen bir spinner ya da sessiz
  başarısızlık kabul edilmez. (28 Ağustos itibarıyla kredi yok — bu durum
  varsayımsal değil, bugünkü hâl.)

## Test

- **Birim:** takvim birleştirme (dört kaynak, sıralama, `kind` ayırıcısı), rozet
  mantığı, "bir kaynak düştü" hâli
- **Gerçek-DB e2e:** `/marketing/home/timeline` ucu tohumlanmış veriye karşı.
  Birim testleri Prisma'yı mock'ladığı için sorgu geçerliliğini doğrulamaz —
  `workspaceId: { in: [id, null] }` sekiz hafta boyunca yeşil bir paketle
  fırlıyordu.
- **Kiracı izolasyonu:** timeline ucu yabancı workspace verisi döndürmemeli
- Sohbet panelinin uçtan uca doğrulanması **AI kredisi geldiğinde** yapılacak;
  o zamana kadar arayüz tamam sayılmaz.

## Kapsam dışı

- **Growth Studio'nun içi** — ayrı ve daha derin bir çalışma
- **Tek satın alma modeli** — ayrı spec
  (`2026-08-28-tek-satin-alma-modeli-design.md`)

## Bağımlılık

Menüde yetki filtresi olmadığı varsayılır: `visibleNav`'ın `has(feature)`
süzgeci kalkar ve herkes aynı üç yüzeyi görür. Bu, ikinci spec'in bir
parçasıdır; o iş yapılmadan menü koşullu kalmaya devam eder.
