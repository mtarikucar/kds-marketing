# MCP Faz 5 — Tam Yüzey — Kapanış Kaydı

**Tarih:** 2026-07-31 · **Durum:** tamamlandı (D1–D5 sevk edildi) · **Kaynak tasarım:** [`../specs/2026-07-31-mcp-faz5-full-surface-design.md`](../specs/2026-07-31-mcp-faz5-full-surface-design.md)

Bu, beş dalganın dürüst kaydıdır: ne çıktı, yol boyunca hangi güvenlik
bulguları ortaya çıktı, neyin **bilerek** tool olmadığı, ve ne kaldığı.
Övgü değil, devralan kişinin ihtiyacı olan bilgi.

---

## 1. Ne çıktı

Faz 5 başlarken katalog **18 tool**du: okuma ağırlıklı, yazma yarım. Sahibin
kararı — *"panelden sosyal hesapları bağladıktan sonra sistemin sağladığı her
şeyi Claude'dan yapabilmeliyim"* — bunu ürünün birincil kontrol yüzeyi haline
getirmeyi gerektirdi.

Bugün: **84 tool, 21 alan, 45'i ilan edilmiş.**

| Dalga | Konu | Tool | Toplam |
|---|---|---|---|
| — | Faz 1–2 tabanı | 18 | 18 |
| **D1** | CRM çekirdeği (yazma): lead oluştur/güncelle/aşama/not/ata, tasks, contacts & companies, pipeline, segment/tag okuma | +18 | 36 |
| **D2** | İçerik & sosyal otomasyon: post yaşam döngüsü, içerik takvimi, AI medya üretimi, sosyal kampanya · **+ `DESTRUCTIVE` risk sınıfı** | +11 | 47 |
| **D3** | İletişim: e-posta, SMS/ses kampanyası, click-to-dial, konuşma yönetimi · **+ kademeli yükleme (`jeeta.find_tools`)** | +10 | 57 |
| **D4** | Beyin & otomasyon: Strategy Engine, workflows, prospect research, marka yazma | +16 | 73 |
| **D5** | Ticaret & itibar: ürün/teklif/fatura/order form, randevu **oluştur**, kurslar, değerlendirmeler | +11 | **84** |

Değişmeyen: politika **broker'da** kaldı. 84 tool'un tamamı
`McpToolRegistry`'ye kaydolur ve `McpBrokerService.invoke`'tan geçer
(scope → onay → arg limiti → çalıştır + denetim). Transport'a tek satır politika
eklenmedi.

### Kademeli yükleme (§3) — eşiğe *ulaşmadan önce* devreye alındı

Tasarım "katalog 60'ı aşınca" demişti. D3 bunu **57'de** kurdu, çünkü mekanizma
D4/D5'i sevk edilebilir kılan şeyin ta kendisiydi. `tools/list` yalnızca ilan
edilen alt kümeyi döner; gerisi `jeeta.find_tools` ile bulunur (isim + açıklama
+ alan üzerinde arama, her sonuç kendi JSON şemasıyla — model bir sonraki turda
doğrudan çağırabilsin diye).

İlan tavanı **45** ve `tool-catalogue.spec.ts` tarafından sabitlendi. Kural:
*bir dalga tavanı zorluyorsa sayıyı büyütmez, bir şeyi erteler.*
- D4 bunun için beş tool'u erteledi.
- D5 iki tool daha erteledi (`jeeta.close_conversation`, `jeeta.get_budget`) ve
  üç yeni alanın birincil okumasını ilan etti — net etki **+1**.

Katalog şu anda **tam tavanda**. Sonraki dalga önce takas yapmak zorunda.

---

## 2. Güvenlik bulguları

Bunlar spec'in öngördüğü işler değil; kod okunurken ortaya çıkan gerçek
açıklardı. Üçü de kapatıldı.

### 2.1 AUTONOMOUS para atlatması (D2'de bulundu ve kapatıldı)

Broker'ın tek kapısı `requiresApproval && writeMode !== 'AUTONOMOUS'` idi. Yani
bir çalışma alanını AUTONOMOUS'a çevirmek, "her gönderimde onay tıklamaktan
kurtul" demek yerine **reklam bütçesini de ajana teslim ediyordu**.

Düzeltme, tasarım §4'ün zaten söylediğiydi ama kod söylemiyordu:
`ALWAYS_APPROVED_RISKS = {SPEND, DESTRUCTIVE}` — yazma moduna **koşulsuz**.
Bunu tool başına bir bayrak değil, bir **risk SINIFI** kuralı yapmak bilinçli:
tool yazarı unutamaz. `mcp-broker.destructive.spec.ts` her iki yönü de sabitler.

Bugün 8 tool bu sınıfta ve hiçbir modda inline çalışmaz: `reallocate_budget`,
`generate_image`, `generate_video`, `approve_strategy_action`,
`synthesize_strategy`, `run_research`, `trigger_workflow`,
`delete_social_post`.

### 2.2 "Onaylamak = çalıştırmak" (D4)

`StrategyService.approveAction` bir durum sütununu çevirmiyor — in-process
olarak `StrategyOrchestrator.execute`'u `await` ediyor: `LEAD_HUNT` gerçek
firecrawl/apify parası harcıyor, `COMMUNITY_ENGAGE` bağlı Discord/Reddit'e
**canlı yayın yapıyor**, `AD_CAMPAIGN` canlı reklam hesabına yazıyor.

Bunu düz bir `WRITE` olarak açmak iki felaket üretirdi:
1. Planı isteyen ajan (`synthesize_strategy`) planın her maddesini kendisi
   onaylardı — **öneren kendi önerisini onaylıyor**, yani kapı diye bir şey yok.
2. Daha kötüsü, ürünün kendi otonom şeridinden **daha güçlü** bir yol olurdu:
   `StrategyOrchestrator.applyPlan`, `GROWTH_AUTOPILOT_AUTONOMY` kill-switch'i
   armed değilse harcama/yayın türlerini otomatik çalıştırmayı reddeder;
   `approveAction`'da böyle bir kontrol yok. Gözetimsiz bir MCP onayı,
   `autonomyLevel: AUTONOMOUS`'un bile geçemediği korkuluğun etrafından
   dolaşırdı.

Uygulanan okuma: **ajan bir eylemin çalıştırılmasını İSTEYEBİLİR, onaylayan
OLAMAZ.** Tool `SPEND` olarak sınıflandırıldı, yani her modda kuyruğa düşer; ve
`jeeta.set_strategy_autonomy` şemasından `AUTONOMOUS` seçeneği tamamen
çıkarıldı (literal tuple olarak, ki upstream'e eklenen yeni bir şerit sessizce
ayarlanabilir hale gelmesin).

### 2.3 Eksik paket (feature) kapıları (D3 işaret etti, D5 kapattı)

MCP tool'ları Nest'in guard hattından geçmez, dolayısıyla `@RequiresFeature`
kontrolünü kendileri yapmak zorunda (`mcp-feature-gate.ts`, D2'de eklendi).
İki gerçek sızıntı bulundu:

- **Inbox.** `MarketingConversationsController`'ın *her* route'u
  `@RequiresFeature('conversationAi')`. D3'ün yazma tool'ları (assign/close/note)
  kontrolü yapıyordu; Faz 1–2'den gelen `list_conversations` /
  `read_conversation` / **`send_message`** yapmıyordu. Paketi paylaşılan gelen
  kutusunu içermeyen bir çalışma alanı, MCP üzerinden konuşmalarını listeleyip
  bir müşterinin tüm mesaj geçmişini okuyup **o müşteriye cevap yazabiliyordu**.
- **Takvim.** `MarketingBookingController` tamamen `@RequiresFeature('funnels')`;
  `list_bookings` / `get_booking_availability` hiçbir kontrol yapmıyordu.

İkisi de D5'te kapatıldı, REST ile aynı `FEATURE_NOT_IN_PACKAGE` gövdesiyle —
ajanın kullanıcıya aktarabileceği bir cümle.

İki yerde MCP **bilerek REST'ten katı**: `research` (D4) ve `memberships` (D5).
İkisi de yeni çalışma alanlarında **kapalı** başlayan Settings > Modules
anahtarları; "bu modülü kapattım" ifadesi, bir ajanın oraya yazmasını istemediğim
anlamına gelir.

### 2.4 Yan bulgu: `reply_to_review` hiçbir yere yayınlamıyor

D5, "değerlendirmeye cevap müşterinin markası adına **herkese açık** konuşur"
varsayımıyla kapsandı. Kodda öyle değil. `ReviewsService.saveReply`
`replyText` yazıp `status`'ü `REPLIED` yapar, o kadar. Depoda Google Business
Profile'a cevap POST eden **hiçbir çağrı yok** (`review-clients.ts` yalnızca GET
yapar; `business.manage` OAuth kapsamı isteniyor ama hiçbir yazma için
kullanılmıyor). Panelin düğmesi de zaten "Save reply" diyor.

Yine de kapıya alındı — isim korkutucu olduğu için değil, iki somut sebeple:
metin markanın kamusal sesidir ve yayınlanmaya **tek kopyala-yapıştır**
uzaklıktadır; ve `REPLIED` işareti değerlendirmeyi ekibin kuyruğundan **düşürür**
— kimsenin cevaplamadığı ama "cevaplandı" damgası yemiş bir şikâyet,
cevaplanmamış olandan kötüdür. Tool'un açıklaması durumu açıkça söyler, çünkü
Google'a yayınladığını sanan bir model kullanıcıya **yayınladım** der ve kimse
gidip yapıştırmaz.

---

## 3. Sınıflandırma disiplini

Kural şuydu: **tool ismine göre değil, kodun yaptığına göre sınıflandır.**
D5'te bunun dört örneği:

| Tool | İsmin vaadi | Kodun gerçeği | Sınıf |
|---|---|---|---|
| `jeeta.send_invoice` | fatura gönderir | `InvoicesService.send` **kimseye ulaşmaz** — durumu SENT yapıp linki döner (modülde e-posta yolu yok). Gerçek teslimat `InvoiceTextService.sendByText` (SMS/WhatsApp). | O yüzden **text-to-pay sarıldı**; gerçek müşteriye para talebi ⇒ `WRITE` + `SEND` onayı. `SPEND` değil: para **içeri** akıyor. |
| `jeeta.create_booking` | satır yazar | Katılımcıya ICS'li onay e-postası, bağlı Google/Outlook takvimine yansıtma (ikinci davet), Lead oluşturma + otomatik atama, ekip arkadaşının slotunu alma, hatırlatıcı işleri, `booking.created` workflow tetiği, Slack. | `WRITE` + `SEND` onayı. İptal "geri alma" değil, ikinci bir mesaj. |
| `jeeta.enrol_lead` | hoş geldin e-postası, erişim verme | `EnrollmentService.enroll`'un **tüm gövdesi** iki varlık kontrolü + idempotent `upsert`. Servise mailer/outbox/mesaj göndericisi enjekte bile edilmiyor. Erişim okuma anında `resolveLessonAccess`'ten türetiliyor. | Gözetimsiz `WRITE`. Kapıya almak tiyatro olurdu. |
| `jeeta.reply_to_review` | herkese açık konuşur | Yerelde saklar (bkz. §2.4). | Yine de `WRITE` + `PUBLISH` onayı — gerekçesi §2.4'te. |

`SEND`/`PUBLISH` ayrı risk **değerleri** değil: kapıda `WRITE` gibi davranırlar
(riskli ama gözetimsiz çalışabilir) ve kuyruktaki insana `approvalKind` ile
ayrışırlar. Bunları risk değeri yapmak, davranışı olmayan bir kelime dağarcığı
eklemek olurdu.

---

## 4. Bilerek tool OLMAYANLAR

Tasarım §7 + dalgaların kendi kararları. Yokluğu bir özelliktir:

**Yetki sınırı (spec §7):**
- **Onay verme/reddetme/uygulama.** Hiçbir tool bir `ApprovalRequest`'i
  karara bağlamaz. (`jeeta.approve_strategy_action` bir *strateji önerisini*
  onaylar, onay talebini değil — ve kendisi her modda kuyruğa düşer.)
- **Kullanıcı & rol yönetimi.** `users.manage` `MCP_ALL_SCOPES`'ta **yok**;
  hiçbir tool onu isteyemez.
- **Workspace oluşturma & paket atama.** `billing.manage` da listede yok.
- **API anahtarı üretme.** Kimlik basabilen bir ajan, verildiği her scope'tan
  kaçar.

**Para (D5 kararı):**
- `mark_invoice_paid`, `void_invoice`, `pay_with_wallet`, iade,
  `submit_order_form`. Gerçekleşmemiş bir ödemeyi kaydetmek, canlı bir alacağı
  iptal etmek ve müşterinin saklı bakiyesini borçlandırmak — hiçbir denetim
  kaydının geri alamayacağı muhasebe sonuçları; ve paranın geldiğini yalnızca
  bir insan ya da PSP callback'i **bilebilir**. `d5-isolation.spec.ts` böyle bir
  tool'un var olmadığını sabitler.

**Doğruluk (dalga kararları):**
- **Ders tamamlama** (öğrenci adına) — olmamış bir öğrenme kaydı uydurur ve
  onun adına sertifika bastırabilir.
- **Research adayını kabul etme** — kotayı tüketen ve staging kuyruğunun var
  olma sebebi olan insan inceleme adımı (D4).
- **Ham SMTP e-postası** — `EmailService.sendPlainEmail` opt-out, unsubscribe
  footer'ı ve bounce baskılaması yapmaz. `jeeta.send_email` bu yüzden tek
  alıcılı bir **kampanya** kurar: hukuki bir sorun, pürüz değil (D3).
- **Konuşma etiketleme** — `Conversation`'da etiket sütunu yok; tool ya panelin
  okumadığı bir depo icat eder ya da sessizce LEAD'i etiketlerdi (D3).
- **Randevu iptal/erteleme** — ikisi de katılımcıya tekrar mesaj atar ve bir
  insanın verdiği taahhüde dokunur (D5).
- **Kurs yazarlığı, order form oluşturma, review kaynağı bağlama** — insanın
  zaten bitirdiği kurulum; yarım kalanı hiç yoktan kötüdür (D5).

---

## 5. Test disiplini

Her dalga aynı dört şeyi kanıtlar (spec §6):

- **`dN-isolation.spec.ts`** — dalganın *her* tool'u sabit bir çağıran workspace
  ve şemanın izin verdiği *her* serbest metin alanına yabancı bir workspace id
  ekilmiş argümanlarla sürülür; her servis çağrısının ilk argümanı çağıranın
  workspace'i olmak zorunda ve yabancı id hiçbir yerde görünemez. Ayrıca
  registry-strict kanıtı: **hiçbir tool `workspaceId` argümanı almaz** (alan
  şemada yok, sessizce yok sayılmıyor).
- **`dN-approval-gate.spec.ts`** — kural değil **kablolama**: gerçek broker
  üzerinden gerçek tool'lar. D5'inki iki yönü de kaydeder — üç kapılı tool'un
  `APPROVAL`'da kuyruğa düştüğünü *ve* `SPEND` olmadıkları için `AUTONOMOUS`'ta
  inline çalıştıklarını.
- **`tool-catalogue.spec.ts`** — tam katalog isim isim, toplam + ilan sayısı,
  her alanda en az bir ilan edilmiş tool, her ertelenmiş tool'un
  `jeeta.find_tools` ile kendi adından bulunabilmesi, ve her dalganın erteleme
  takası **isimle**.
- **Feature gate** — yetkisiz çalışma alanının temiz reddi, servise dokunmadan.

Sayılar: `npx jest mcp` **63 suite / 836 test** (Faz 5 öncesi karşılığı 58/728),
tam e2e **39 suite / 234 test** yeşil, `tsc --noEmit` 0 hata.

---

## 6. Ne kaldı

**Ürün boşlukları (MCP'ye özgü değil, burada kayda geçti):**
1. **`reply_to_review` yayınlamıyor** (§2.4). GBP `reply` yazma yolu hiç
   yazılmadı; OAuth kapsamı zaten alınıyor. Yazıldığında bu tool'un
   sınıflandırması **zaten doğru** — yalnızca açıklaması güncellenir.
2. **Quiet hours hiçbir gönderim yolunda yok** (D3'te tespit edildi): kampanya,
   mesaj, workflow ve ses göndericilerinin hiçbirinde gönderim penceresi
   mantığı yok. Bunu tek bir tool'da uygulamak uyum tiyatrosu olurdu.
3. **Estimates REST'te `invoicing` kapısının dışında**, ama kabul edilen bir
   teklifi faturaya çevirmek bir `Invoice` satırı basıyor. MCP bu tutarsızlığı
   *aynen* yansıtıyor (`create_estimate` kapısız), çünkü uygulamada yapılabilen
   bir şeyi MCP'de reddetmek parite kuralını ters çevirirdi. Asıl düzeltme
   REST'te.
4. **`mcpWriteMode` için UI anahtarı yok** — yalnızca iki REST route'u. Bu,
   konektörün en güvenlik-hassas ayarı.
5. **MCP onayları için ayrı bir panel yok**; kuyruk Growth Autopilot sayfasının
   Approvals sekmesinde ve yalnızca bir Growth Budget provision edilmişse
   görünüyor.
6. **Apply reaper penceresi** (issue #152): kalp atışı susmuş ama hâlâ canlı bir
   `apply`'ı süpüren cron, operatörün tekrar Apply'a bastığı bir pencere
   bırakabiliyor. Kalıcı çözüm, reaper'ın danışabileceği dayanıklı bir yürütme
   kaydı.

**MCP tarafında kalanlar:**
7. **İlan yüzeyi tam tavanda (45/45).** Sonraki dalga *önce* takas yapmalı.
8. **Canlı uçtan uca koşu 18 tool'luk katalogda yapıldı** (2026-07-29). 84
   tool'un tamamı unit + izolasyon spec'leriyle kapsanıyor ama canlı bir tekrar
   koşusu yapılmadı; özellikle **gerçek bir sağlayıcı gönderimi** (SMS/WhatsApp/
   e-posta gerçek bir hatta) hiç denenmedi — test workspace'i WEBCHAT
   kullanıyordu.
9. **Hâlâ tool'suz alanlar** (tasarım §2'den, bilinçli olarak kapsam dışı
   bırakıldı): commissions, installations, agency, imports, custom objects,
   sites/funnel **sayfa kurgusu**, subscriptions, phone tree, ve Settings'in
   tamamı. Bunların çoğu ya kurulum işi (insan bitirir) ya da yetki sınırı
   (§7). Talep gelirse ayrı bir dalga.
10. **`jeeta.find_tools` kullanım verisi yok.** Kademeli yükleme doğru
    varsayımla kuruldu (60+ tool doğruluğu düşürür) ama modellerin ertelenmiş
    tool'ları pratikte bulup bulmadığı ölçülmedi. `ToolCallLog` bunu
    yanıtlayabilir: `jeeta.find_tools` çağrılarının ne sıklıkta ertelenmiş bir
    tool çağrısıyla takip edildiğine bakmak ilk metrik olurdu.

---

## 7. Devralana tek paragraf

Politika broker'da; oraya bak (`mcp-broker.service.ts`). Yeni bir tool eklerken
üç soruyu kodu okuyarak yanıtla: **kime ulaşıyor**, **kimin parasını
harcıyor**, **geri alınabilir mi**. Para çıkıyorsa veya satır siliniyorsa
`SPEND`/`DESTRUCTIVE` — başka hiçbir şey yapmana gerek yok, broker her modda
kuyruğa alır. Müşteriye ulaşıyorsa `WRITE` + `requiresApproval` + doğru
`approvalKind`. REST karşılığında bir `@RequiresFeature` varsa `assertFeature`
ile aynısını yap. Ve tool'u **ilan etme** — `defer: true` varsayılan olsun;
tavan dolu.
