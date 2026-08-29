# Kişi birincil yüzey: gerçek birleşme

Tarih: 2026-08-29
Durum: tasarım — sahip iki kararı doğrudan verdi (sıralama, orta sütun)

Yerine geçtiği belge: `2026-08-29-lead-iletisim-birlesimi-design.md` §1 ve §2.
Dayandığı onaylı belge: `2026-08-28-panel-ia-design.md` §İletişim.

## Neden bu belge var

Sahip "gelen kutusu ve leadleri **işlevsel olarak** birleştir" dedi. v2.283.0
iki sekme çıkardı: `/inbox` ve `/leads` aynı bileşeni render ediyor ama Kişiler
sekmesindeki satıra tıklamak hâlâ `/leads/:id`'ye gidiyor. Konuşma listesi ve
kişi listesi hâlâ iki ayrı liste, iki ayrı davranış. **Taşındı, birleşmedi.**

28 Ağustos IA spec'i doğrusunu zaten yazmıştı ve sahip onu onaylamıştı:

> Tek nesne var: **kişi**. Konuşma onun bir alanı.
> Üç sütun: liste (%34) · yazışma · kayıt kartı (%26).

## Karar

**Tek liste, tek nesne: kişi.** Sekme yok.

- Liste **insanları** taşır — konuşması olan da, hiç konuşmamış 363 sessiz lead de.
- Satıra tıklamak **hiçbir yere gitmez.** Orta sütunda o kişinin akışı, sağda
  kayıt kartı açılır. Gezinme değil, seçim.
- Konuşması olmayan kişide orta sütun "konuşma başlat"ı sunar (v2.283.0'daki
  kanal seçici dialog).
- Üstte iş kuyruğu: `Bekleyen` / `Atanmamış` / `Hepsi`, sayılarıyla. Bu kısım
  v2.283.0'da doğru çıktı, aynen kalır.

### Sıralama — sahibin kararı

**Son hareket zamanına göre.** Konuşması olanlar üstte (son mesaja göre), hiç
konuşmamışlar altta kayıt tarihine göre. Triyaj hissi korunur; sessiz lead'ler
listenin dibine düşer ama **kuyruk çipleriyle** bulunurlar — `Atanmamış 363`
tek tıkla onları öne çıkarır.

Bu, "tek liste sessizleri gizler" itirazının cevabıdır: gizlenmelerini önleyen
şey sıralama değil, çiplerdir.

### Orta sütun — sahibin kararı

**Yazışma ve tüm hareketler tek akışta.** Mesajlar, aramalar, notlar ve durum
değişiklikleri tek zaman ekseninde. Sahibin ilk cümlesi buydu: *"iletişim ile
alakalı olan herşeyi"* lead'den yapabilmek.

**Zorunlu sonuç — lead detayı dörde iner.** Eski §2 "Hareketler ile Konuşmalar
ayrı kalır" diyordu; orta sütun ikisini birleştirince o ayrım aynı veriyi iki
yerde iki farklı şekilde gösteren bir fazlalığa dönüşür. Tek akış bileşeni
yazılır ve **her iki yerde** kullanılır:

| Sekme | Durum |
|---|---|
| **Akış** | Hareketler + Konuşmalar tek akışta — v2.283.0'ın iki sekmesi burada erir |
| **Satış** | v2.283.0'dan aynen |
| **Teklifler** | mevcut |
| **Görevler** | mevcut |

## Asıl iş backend'de

Görsel birleşme kolay kısım. İki liste iki uçtan geldiği sürece birleşme
kozmetik kalır:

1. **Kişi listesi zenginleşir.** `GET /marketing/leads` her kişi için
   `lastMessageAt`, `lastMessagePreview`, `unreadCount` ve `lastActivityAt`
   döndürür; `lastActivityAt`'e göre sıralanabilir. Bugün bu bilgi yalnızca
   `/conversations`'ta var ve orada nesne konuşma, kişi değil.

2. **Kişi akışı tek uçtan gelir.** Yeni uç: mesajlar + lead hareketleri tek
   zaman ekseninde, `kind` ayırıcısıyla. Deseni `home-timeline.service.ts`
   veriyor — özellikle **okunamayan kaynağı adıyla söyleme** ve `CAP + 1` ile
   kırpma tespiti. İki kaynaktan biri patlarsa akış boş görünmemeli.

`Conversation`'ın `Lead`'e Prisma ilişkisi yok (çıplak `leadId`, FK yok), bu
yüzden zenginleştirme ham SQL ile toplanıp lead sayfasına iliştirilir. Boş liste
(`in: []`) tuzağı v2.283.0'da kapatıldı, aynı desen korunur.

## Korunacaklar

- **`/inbox` ve `/leads` ikisi de kalır.** Frozen 50-yol kümesi
  `navigation.test.ts` ile sabit; rota silmek yer imlerini kırar. İkisi de aynı
  kişi-birincil yüzeyi render eder — artık varsayılan sekme farkı bile yok.
- **Yetki kapıları.** `/leads` kapısız, `GET /conversations` `conversationAi`
  istiyor. Konuşma sütunu kapısıyla birlikte görünür; kapısı olmayan workspace
  kişi listesini ve hareketleri görür, yazışmayı görmez.
- **v2.283.0'ın kazanımları:** rıza kapısı, lead başına anahtarlanmış durum,
  `FAILED` mesajın "gönderildi" dememesi, `Bekleyen` tanımının sabah brifingiyle
  aynı olması. Hiçbiri geri alınmaz.

## Hata davranışı

Değişmez ve bu belgede de sabittir: üç sütunun her biri **bağımsız** başarısız
olur, ve okunamayan kaynak **adıyla** söyler. Boş bir sütun ile kırık bir sütun
ayırt edilebilmeli. Akışın iki kaynağından biri okunamazsa diğeri gelir ve
eksiğin hangisi olduğu yazılır.

## Test

- **Birim:** liste sıralaması (konuşmalı üstte, sessiz altta); çiplerin sessizleri
  öne çıkarması; seçimin gezinme yapmaması; bir kaynağın hatasının diğer
  sütunları düşürmemesi
- **Gerçek-DB e2e:** zenginleştirilmiş liste ve akış ucu gerçek Postgres'e karşı;
  **kiracı izolasyonu** — yabancı workspace'in kişisi ve mesajı hiç dönmemeli
- **Frozen yol kümesi bozulmamalı**
- Her davranış mutasyonla doğrulanır — silindiğinde düşmeyen test kabul edilmez

## Uygulamada bir sapma: `?view=table`

Bu belge "sekme yok" diyor ve yüzey öyle çıktı — `/inbox` ve `/leads` aynı üç
sütunu render ediyor, hiçbir varsayılan kimseyi tabloya düşürmüyor.

Ama eski Kişiler sekmesindeki lead **tablosu** silinmedi. Toplu atama, toplu
silme, toplu iş akışına alma ve CSV dışa aktarım yalnızca orada var; yeni
listeye yeniden yazmak bu görevin kapsamı dışındaydı ve bir yöneticinin toplu
atamasını yerleşim uğruna sessizce kaldırmak daha kötü bir cevap olurdu.
Tablo `?view=table` ile açılıyor, başlıktaki tek düğmeyle gidilip geliniyor.

Bu bir **görünüm**, ikinci bir nesne değil: aynı kişiler, aynı kuyruklar, hiçbir
varsayılan oraya götürmüyor. Sahip "tablo da gitsin" derse silinecek yer tek bir
dal — `InboxPage`'in `tableView` kolu ve `LeadsPage` importu.

## Kapsam dışı

- `/opportunities` board'unun kendisi
- Growth Studio
- Tek satın alma modeli (`2026-08-28-tek-satin-alma-modeli-design.md`)
