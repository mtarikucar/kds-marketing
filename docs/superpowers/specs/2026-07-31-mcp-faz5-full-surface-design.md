# MCP Faz 5 — Tam Yüzey — Tasarım

**Tarih:** 2026-07-31 · **Durum:** tasarım · **Sahip kararı:** *"panelden sosyal hesapları bağladıktan sonra sistemin sağladığı her şeyi Claude'dan yapabilmeliyim"*

## 1. Amaç

Bugün MCP 18 tool açıyor: lead **arama**, funnel, marka arama, inbox (oku + mesaj gönder), kampanya (listele/metrik/başlat-durdur), sosyal (listele/taslak/yayınla), reklam (metrik/bütçe), randevu (listele/uygunluk), workspace bilgisi.

Sahip, MCP'yi ürünün **birincil kontrol yüzeyi** olarak istiyor: strateji kurma, otomasyon yazma, arama yapma, mail/SMS gönderme, sosyal medya otomasyonu ve içerik yönetimi dahil sistemin tamamı.

## 2. Bugünkü boşluk

**Hiç tool'u olmayanlar:** Strategy Engine · Pipeline/fırsatlar · Tasks · Workflows · Prospecting/Research · Contacts/Companies/Segments/Tags/Import · Sites & Funnels · Payments/Products/Invoices/Subscriptions/Order forms · Voice/Calls/Phone Tree · Courses/Memberships · Reviews · Commissions · Installations · Media generation · Agency · Settings'in tamamı.

**Yarım kalanlar:** lead **yazma yok** (oluştur/güncelle/aşama/not) · randevu **oluşturma yok** · kampanya **oluşturma yok** · reklam kampanyası **oluşturma yok** · marka **yazma yok**.

> En keskin asimetri: Claude bir müşteriye **gerçek mesaj gönderebiliyor** ama o müşterinin lead kaydına **not düşemiyor**.

## 3. Mimari karar — kademeli yükleme (progressive disclosure)

Tam kapsam ~100-140 tool demek. Tasarım §12 bunu öngörmüştü: *"katalog 100'ü aşarsa yeniden değerlendirilir."* Değerlendirme sonucu:

- Tool'lar **alan (domain) bazlı gruplanır**; her tool zaten `scopes` + `risk` + `requiresApproval` ilan ediyor — buna `domain` eklenir.
- Sunucu, istemciye **çekirdek + arama** yüzeyi sunar: her alandan temsilci okuma tool'ları + bir `jeeta.find_tools(query)` keşif tool'u; nadir kullanılan tool'lar `defer` işaretlenir ve talep üzerine yüklenir.
- MCP spec'inin `listChanged` yeteneği zaten açık (`capabilities.tools.listChanged: true`), yani katalog dinamik büyütülebilir.
- **Eşik:** katalog 60 tool'u aşana kadar hepsi doğrudan listelenir; aşınca kademeli yükleme devreye girer. Tek seferde 140 tool listelemek doğruluğu düşürür.

**Değişmez:** politika broker'da kalır. Her yeni tool `McpToolRegistry`'ye kaydolur, `McpBrokerService`'ten geçer (scope → onay → arg limiti → çalıştır + denetim). Transport'a politika eklenmez.

## 4. Risk ve onay disiplini

Katalog büyüdükçe yanlış işlem riski doğrusal artar. Kurallar:

| Risk | Örnek | AUTONOMOUS'ta |
|---|---|---|
| `READ` | listele, ara, metrik | çalışır |
| `WRITE` | lead oluştur, not ekle, taslak | çalışır |
| `SEND` | mail/SMS gönder, arama başlat | çalışır (denetimli) |
| `PUBLISH` | sosyal yayın, kampanya başlat | çalışır (denetimli) |
| `SPEND` | reklam bütçesi, bakiye harcama | **her modda onay** |
| `DESTRUCTIVE` (yeni) | toplu silme, kalıcı kaldırma | **her modda onay** |

`SPEND` ve yeni `DESTRUCTIVE` sınıfı, `mcpWriteMode` ne olursa olsun onay kuyruğuna düşer — otonom mod bile bunları geçemez.

**Asla tool olmayacaklar:** onay verme/reddetme (insan kapısı) · kullanıcı & rol yönetimi (yetki yükseltme) · workspace oluşturma & paket atama (kiracı/faturalama sınırı) · API anahtarı üretme.

## 5. Dalgalar

Değer sırasına göre; her dalga bağımsız sevk edilebilir.

- **D1 — CRM çekirdeği (yazma):** leads (oluştur/güncelle/aşama/not/ata) · tasks (listele/oluştur/tamamla) · contacts & companies · pipeline/fırsat (listele/aşama ilerlet/oluştur) · segments & tags okuma.
- **D2 — İçerik & sosyal otomasyon:** bağlı sosyal hesapları listele · post planla/güncelle/sil · içerik takvimi · **AI medya üretimi** (foto/video) · sosyal kampanya oluştur.
- **D3 — İletişim:** e-posta gönder + şablonlar · SMS kampanyası oluştur & gönder · tıkla-ara (click-to-dial) & çağrı listesi · sesli kampanya · konuşma yönetimi (ata/kapat/etiketle).
- **D4 — Beyin & otomasyon:** **Strategy Engine** (brief oku, aksiyonları listele, onayla/reddet, yeniden sentezle) · workflows (listele/oluştur/aç-kapa/tetikle) · research/prospecting (profil oluştur, av başlat) · brand yazma.
- **D5 — Ticaret & kalan:** ürünler · teklif/fatura · order form · randevu **oluştur** · kurslar · değerlendirmeler · raporlar.

Her dalga sonunda katalog boyutu ölçülür; 60'ı aşınca §3'teki kademeli yükleme devreye alınır.

## 6. Test disiplini

Her tool için: şema doğrulaması · scope zorlaması · **workspace izolasyonu** · risk/onay sınıfının doğru dalda çalıştığı (APPROVAL vs AUTONOMOUS) · `ToolCallLog` yazıldığı. Mevcut broker spec'leri değişmeden geçmeye devam etmeli.

## 7. Kapsam dışı

Onay verme tool'u · rol/kullanıcı yönetimi · workspace/paket işlemleri · API anahtarı üretimi · MCP resources/prompts primitifleri (yalnız tools).
