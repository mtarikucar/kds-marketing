# Lead ve iletişimin birleşmesi

Tarih: 2026-08-29
Durum: tasarım — sahibin "başla ve bitir" talimatıyla onaylı kabul edildi

## Sorun

Konuştuğun kişi ile kayıttaki kişi aynı kayıt, ama bugün iki ayrı ekranda
duruyorlar. Bir mesajı okuyup o kişinin geçmişine bakmak için başka sayfaya
gitmek gerekiyor; lead'e bakarken onunla ne konuşulduğu görünmüyor.

Aynı kopukluk satış tarafında da var: `Opportunity.leadId` veri modelinde mevcut
ve indeksli, ama hiçbir ekran lead ile fırsatı yan yana göstermiyor.

## Keşif — neyin zaten var olduğu

Bu iş büyük ölçüde **inşa değil, bağlama**. Ölçüldü:

| Var | Nerede |
|---|---|
| Lead detayında `activities` / `offers` / `tasks` sekmeleri | `pages/marketing/leadDetail/` |
| Hareketler akışı (`ActivityTimelineTab`) | aynı dizin |
| `GET /marketing/leads/:leadId/activities` | `marketing-activities.controller.ts:37` |
| `Opportunity.leadId` — nullable soft ref, indeksli | `schema.prisma` |
| `GET /marketing/opportunities?leadId=` | `OpportunityFilterDto.leadId` mevcut |
| `Conversation.leadId` — zorunlu, indeksli | `schema.prisma` |
| Tıkla-ara altyapısı | `DialerPage`, telefon modülü, `jeeta.click_to_dial` |

**Tek backend boşluğu:** `GET /marketing/conversations` `status`, `channelId` ve
`assignedToId` ile filtreleniyor — `leadId` ile filtrelenemiyor.

## Kararlar

Sahibin talimatı "başla ve bitir" olduğu için aşağıdaki kararları ben verdim.
Yanlış olan varsa değiştirilir; hepsi tek tek yazılı olsun diye buradalar.

### 1 · Birleşik yüzey: iki sekme, tek veri kümesi

`/inbox` ve `/leads` **aynı bileşeni** render eder, yalnızca varsayılan sekmesi
farklıdır:

- **Konuşmalar** — zaman sıralı, okunmamış önce. Triyaj modu.
- **Kişiler** — filtreli liste, iş kuyruğu rozetleriyle. Süzme modu.

Aynı veri, farklı fiil. Sağdaki detay paneli her iki sekmede de **aynı**: kişi
ve onunla olan yazışma.

**Her iki rota da korunur.** `/inbox` ve `/leads` frozen 50-yol kümesinin
üyeleri ve o küme `navigation.test.ts` tarafından sabitlenmiş durumda; birini
silmek testi düşürür ve daha önemlisi kullanıcıların yer imlerini kırar.

Neden iki görünüm, tek liste değil: bugün **363 lead'in hiç konuşması yok**
(araştırmadan geldiler). Konuşma-öncelikli tek liste onları görünmez kılardı —
tam olarak bugünkü hâl.

### 2 · Lead detayı beş sekme olur

Mevcut üçe iki tane eklenir:

| Sekme | İçerik | Durum |
|---|---|---|
| **Hareketler** | Zaman akışı: not, durum değişikliği, arama, mesaj | var |
| **Konuşmalar** | O lead'in tüm kanallardaki yazışmaları | **yeni** |
| **Satış** | O lead'e bağlı fırsatlar, aşamalarıyla + fırsat oluştur | **yeni** |
| **Teklifler** | Mevcut | var |
| **Görevler** | Mevcut | var |

Hareketler ile Konuşmalar ayrı kalır ve **Hareketler yazışmayı kopyalamaz**,
ona atıf yapar. İkisi aynı veriyi iki kez gösterirse hangisinin doğru olduğu
sorusu doğar ve bu ekibin bu hafta altı kez ödediği bedelin ta kendisi.

### 3 · Lead başlığında iki eylem

- **Ara** — `click_to_dial`, lead'in telefonuna. Sonuç araması Hareketler'e düşer.
- **Mesaj** — lead'in mevcut konuşmasını açar; yoksa kanal seçtirip başlatır.

Telefonu olmayan lead'de **Ara düğmesi görünmez** — tıklanınca başarısız olan
bir düğme, olmayan düğmeden kötüdür.

### 4 · Backend: tek değişiklik

`GET /marketing/conversations` opsiyonel `leadId` filtresi alır. Kiracı
sınırlaması değişmez (`workspaceId` zaten her sorguda).

## Kapsam dışı

- Satış hattının kendisi (`/opportunities` board) değişmez — lead'den o hatta
  **geçiş** eklenir, hat yeniden tasarlanmaz.
- Konuşma başlatma akışının kanal seçimi, mevcut inbox davranışını izler;
  yeni bir gönderim yolu yazılmaz.
- Yüzey isimlendirmesi ("Inbox" hub'ı Lead/Fırsat/Takvim içeriyor) ayrı bir
  karar; bu spec onu çözmez.

## Hata davranışı

Sekmeler **bağımsız** yüklenir ve bağımsız başarısız olur. Konuşmalar okunamazsa
Satış sekmesi çalışmaya devam eder ve okunamayan sekme **adıyla** söyler.

Bu kural bu depoda ölçülmüş bir bedelin sonucu: sabah brifinginin sekiz sorgusu
`.catch(() => 0)` ile yutuluyordu, yani "sorgu patladı" ile "gösterilecek bir şey
yok" aynı görünüyordu (v2.271.0'da düzeltildi). Boş bir sekme ile kırık bir sekme
ayırt edilebilmeli.

## Test

- **Birim:** sekme geçişleri; telefonu olmayan lead'de Ara düğmesinin yokluğu;
  bir sekmenin hatası diğerlerini düşürmüyor
- **Gerçek-DB e2e:** `leadId` filtresi gerçek Postgres'e karşı — birim testleri
  Prisma'yı mock'luyor ve mock her `where`'i kabul ediyor; `in: [id, null]`
  sekiz hafta boyunca yeşil bir paketle fırlamıştı
- **Kiracı izolasyonu:** yabancı workspace'in lead'inin konuşmaları dönmemeli
- **Frozen yol kümesi bozulmamalı:** `/inbox` ve `/leads` ikisi de kalır
- Her davranış mutasyonla doğrulanır — silindiğinde düşmeyen test kabul edilmez
