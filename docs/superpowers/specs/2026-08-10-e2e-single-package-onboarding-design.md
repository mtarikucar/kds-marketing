# E2E kapsamı, tek paket ve onboarding omurgası — tasarım

**Tarih:** 2026-08-10
**Dal:** `feat/e2e-single-package-onboarding` (main @ `6b9e1e1` üzerinden)
**Durum:** Onaylandı, uygulanıyor

## Problem

Ürün sahibinin üç şikâyeti var:

1. Sistemin uçtan uca çalıştığına dair güven yok — tarayıcı seviyesinde hiçbir test yok.
2. "Sisteme girdiğimde ne yapacağımı şaşırıyorum" — ürün ilk kullanıcıyı yönlendirmiyor.
3. Üç ayrı satılabilir paket (STARTER/GROWTH/SCALE) yerine tek satın alma istiyor.

Keşif sırasında dördüncü bir problem çıktı: **kredi ekonomisi bugünkü haliyle "düşük dahil kredi + top-up" modelini taşımıyor.** Bu spec dördünü de kapsıyor.

## Karar özeti

| Konu | Karar |
|---|---|
| Sıra | E2E temeli → tek paket + kredi ekonomisi → onboarding → geniş E2E kapsamı |
| Ticari model | 14 günlük deneme + **tek** ücretli paket |
| Fiyat | **$149 / ay · ₺6.900 / ay**, 1.500 AI kredisi, 2.500 mesaj dahil |
| Limitler | Düşük dahil kredi, gerektiğinde self-servis top-up |
| Eski paketler | Silinmez — `RETIRED` + gizli |
| Eklentiler | SMS OTP / faks / sesli kampanya eklenti kalır; kota boost'ları pakete katlanır |
| Kredi ekonomisi | Kapsam **içinde** |
| Yinelenen ödeme | Kapsam **dışı** (ayrı proje) |
| Mevcut müşteri | Yok — geriye uyum kısıtı yok, yine de veri kaybetmeden ilerlenir |

## Keşif bulguları (uygulamayı şekillendirenler)

Bu bölüm kanıta dayanıyor; her iddia ya dosya:satır ya da canlı ölçümle doğrulandı.

### Zaten yazılmış, sadece bağlanmamış

Bunları **yeniden yazmayın**:

- **Strateji sihirbazı tam çalışıyor.** `/onboarding/strategy` (URL al → AI soru-cevap → sentez) ve `/studio/strategy` konsolu canlı; backend'i (`strategy.controller.ts`, `strategy-intake.controller.ts`, arketipler, orkestratör, sentez) hazır. **Paket kısıtı yok** — sadece MANAGER + `settings.manage`. Sol menüde "Strateji" girişi de var. Canlı ölçümle doğrulandı.
- **8 adımlı kurulum checklist'i** (`GettingStarted.tsx`) gerçek API sorgularıyla çalışıyor ve her adımı derin-linkliyor.
- **4 adımlı ürün turu** (`ProductTour.tsx:25-32`) yazılmış ve en+tr çevrilmiş ama **tasarımı gereği hiç otomatik başlamıyor**.
- **Karşılama diyaloğu** yalnızca `?welcome=1` ile açılıyor; bu parametreyi tek bir satır yazıyor.
- **`Package.status = RETIRED`** şemada zaten var — paket daraltması için migration gerekmiyor.
- **Operatör paket atama** uçtan uca çalışıyor (`assignPackageToWorkspace`, 2999 yılı sonsuz dönem).
- **`GrowthWallet`** — kalıcı, ledger destekli, süresi dolmayan bakiye. AI kredisi için kopyalanacak doğru desen bu.

### Kanıtlanmış E2E gerçekleri

| Bulgu | Kanıt |
|---|---|
| `storageState` **çalışmaz** — oturum `sessionStorage`'da | `marketingAuthStore.ts:249` `createJSONStorage(() => sessionStorage)` |
| `addInitScript` ile sessionStorage enjeksiyonu **çalışır** | Canlı probe: `/dashboard`'a authenticated düştü, 20 API çağrısı 200 |
| Sadece **refresh** token yeterli — axios interceptor access token'ı üretiyor | Aynı probe |
| Kayıt throttle'ı acımasız: `201, 429, 429, 429` | Canlı probe; `REGISTER_THROTTLE` 3/60s + **10 dk blok** |
| `POST /marketing/workspaces` throttle'sız — toplu fixture kapısı | `marketing-workspaces.controller.ts:36-43` |
| E-posta doğrulaması **yok** — otomatik kayıt engellenmiyor | `MarketingUser` şemasında doğrulama alanı yok |
| 147 migration + paket seed'i temiz veritabanına sorunsuz uygulanıyor | Canlı: `marketing_e2e` oluşturuldu ve seed'lendi |
| Playwright 1.61.0 kurulu, Chromium **yeni indirildi** | `chromium_headless_shell-1228` |
| Üretim kodunda sadece **12** `data-testid` var, arayüz 5 dilli | Metin tabanlı seçiciler kırılgan |
| Dev veritabanı main'den ayrışmış (30+ bekleyen + 2 dal-yerel migration) | E2E'nin **kendi** veritabanı şart |
| `backend/.env` **gerçek GoDaddy SMTP** taşıyor | E2E gerçek mail gönderebilir — ayrı env zorunlu |

### Para ve maliyet gerçekleri

**AI'ın %100'ünü Jeeta ödüyor.** Müşterinin kendi anahtarını gireceği hiçbir yol yok (`ANTHROPIC_API_KEY`, `FAL_KEY` platform env'i). "AI kredisi" bir ödeme yöntemi değil, Jeeta'nın kendi harcama karnesi.

Müşteri **kendi hesabından** ödüyor (Jeeta'ya maliyeti 0): SMS, WhatsApp, sesli arama, faks, İYS, OTP (kendi NetGSM aboneliği) ve **reklam bütçesinin tamamı** (kendi ad account'u).

Kritik delikler:

| Öncelik | Delik | Kanıt |
|---|---|---|
| P0 | **Kredi tavanı dolar tavanı değil** — bir rezervasyon N LLM çağrısı kapsıyor; aynı 6.000 kredi ~$3,6 ile ~$1.980 arası mal olabiliyor (**550×**) | `strategy-synthesis.service.ts:21-23,171-179` (8 kredi → ≤10 Opus çağrısı); `research-worker.service.ts:24-26` (3 kredi → ≤8 Opus + 30 scraper) |
| P0 | **Kampanya e-postası tamamen sayaçsız** — Jeeta'nın SMTP'si, sınırsız | `campaign-sender.service.ts:454` EMAIL dalı `:469`'daki rezervasyondan önce return ediyor; `LIMIT_KEYS`'te e-posta yok |
| P0 | **Gecelik strateji yeniden-sentezi** her ACTIVE strateji için gözetimsiz | `strategy-feedback.cron.ts:28-50` — tipik kullanıcının $42 COGS'unun $18,30'u gece cron'larından |
| P1 | **STT sayaçsız ve rezervasyondan önce** — kredisi biten workspace yine para yakıyor | `call-analysis.service.ts:54` (STT) vs `:58` (reserve) |
| P1 | Strateji onboarding'te crawl+scrape hiç ölçülmüyor | `strategy-intake.service.ts:250-251` `ResearchSpendService`'i import etmiyor |
| P1 | `messagesMonthly` **ters çalışıyor** — maliyeti olmayan SMS/WA'yı sayıyor, maliyeti olan e-postayı saymıyor | `entitlements.service.ts:113-121` |

Bugünkü fiyatlamada STARTER paket kredisi $0,198/kredi, top-up $0,018/kredi — **top-up paketten 11× ucuz.** Kredi tablosu düzeltilmeden düşük dahil krediye geçmek kredi başına geliri 11 kat düşürür.

### Paket daraltmasının tuzakları

- `Workspace`'te `packageId` **yok**; tek bağ `WorkspaceSubscription.workspaceId @unique → packageId`, üstelik **FK'sız düz String**.
- Eski paketleri **silmek** mevcut abonelikleri "eksik paket" dalına düşürüp `zeroEntitlements` yapar (`entitlements.service.ts:218-223`).
- `TRIAL` kodu silinirse **her yeni kayıt** sessizce aboneliksiz kalır (`marketing-auth.service.ts:667-669`).
- `OPERATOR` kodu silinirse sınırsız-atama yolu kırılır (`package-assignment.ts:17`).
- Tripwire spec'i seed dosyasını **metin olarak** parse ediyor: en az 4 `features:{}`/`limits:{}` bloğu ve her blokta **tüm** anahtarlar şart (`entitlements.tripwire.spec.ts:64,82`). Ortak `{...ALL_TRUE}` spread'i build'i kırar.
- `activatedModules` izin listesi paket üstünde ikinci bir maske: `DEFAULT_ACTIVATED_MODULES = TOGGLEABLE − memberships − research`. Geri-doldurma olmadan "her şeyi aldım" diyen kullanıcı Kurslar ve Araştırma'yı göremez.
- **Para hatası:** `activateSubscription` dönemi koşulsuz `now`'a sıfırlıyor (`billing-settlement.service.ts:326-330`) — tek paket kalınca "Satın Al"a tekrar basmak kalan ödenmiş süreyi siler.
- **Para hatası:** mutabakat süpürgesi "zaten verilmiş"i `packageId` eşitliğiyle anlıyor (`:250-254`) — tek paketle her sipariş eşleşir, grant'i patlamış yenileme sessizce hiç uzatmaz.

## Uygulama

### W0 — E2E temeli

**Amaç:** gerçek backend'e karşı, güvenilir, tekrarlanabilir tarayıcı testi koşabilmek.

- **Ayrı veritabanı** `marketing_e2e`; `prisma migrate deploy` + `seed:packages` ile kurulur. Dev verisine asla dokunulmaz.
- **Ayrı env** (`backend/.env.e2e`): `EMAIL_*` boş (gerçek mail yasak), `PAYTR_TEST_MODE=1`, `AI_DISABLED=1`, ayrı port.
- **`globalSetup`**: throttle nedeniyle **tek bir** sahip hesabı API ile kaydeder, tam paketi atar, kimlik bilgilerini diske yazar.
- **Worker-kapsamlı fixture**: her test kendi workspace'ini throttle'sız `POST /marketing/workspaces` ile açar.
- **Kimlik doğrulama**: `addInitScript` ile `sessionStorage['marketing-auth-storage']` enjeksiyonu. Şekil tek bir yardımcıda toplanır ve `marketingAuthStore.ts:243-268`'e işaret eden bir yorumla sabitlenir.
- **Config**: `reuseExistingServer: !process.env.CI`, `locale: 'tr-TR'` sabit, hata anında `screenshot`/`video`/`trace`, `list` + `html` reporter.
- **`data-testid` geçişi**: en değerli ~15 yüzeyde. 5 dilli arayüzde metin seçicisi kırılgan.
- **npm script'leri**: `e2e`, `e2e:ui`, `e2e:setup`.

### W1 — Tek paket + kredi ekonomisi

**Katalog** (`seed-packages.ts`, sadece veri):

| Kod | Değişiklik |
|---|---|
| `JEETA` (yeni) | $149 / ₺6.900 · yıllık $1.490 / ₺69.000 · **23 özelliğin tamamı** · 1.500 kredi · 2.500 mesaj · `isPublic: true` · `sortOrder: 1` |
| `TRIAL` | 14 gün korunur, **tüm özellikler** açılır, düşük limitler |
| `STARTER` `GROWTH` `SCALE` | `status: 'RETIRED'`, `isPublic: false`, özellikleri all-true'ya yükseltilir — **silinmez** |
| `OPERATOR` | Dokunulmaz |

Tripwire'ı memnun etmek için her satır kendi tam `features`/`limits` bloğunu literal olarak taşımaya devam eder.

**Migration:** `activatedModules`'e `memberships` + `research` birleştiren, geri alınabilir (`migration.sql` + `down.sql`) backfill; `DEFAULT_ACTIVATED_MODULES = TOGGLEABLE_MODULE_KEYS`.

**Kredi tablosu** (`ai-credit-costs.ts`) gerçek maliyete göre yeniden fiyatlanır. Ana kalemler: `research.qualify` 3→22, `strategy.synthesize` 8→45, `brand.analyze` 5→15, `ask_ai.question` 2→5, `funnel.draft` 3→9, `content.compose` 1→3. `conversation.reply`, `workflow.ai_classify` ve tüm `media.*` zaten doğru — değişmez. Yeni: `stt.minute`, `research.crawl_page`, `research.actor_run`.

**Tur-başına rezervasyon:** tek toplu rezervasyon yerine ajan döngülerinin içinde `reserve(1)` (`strategy-synthesis.service.ts:171`, `research-worker.service.ts:79`). Kredi tavanı ancak böyle dolar tavanına dönüşür.

**Delik kapatma:** e-posta `messagesMonthly`'ye dahil edilir (rezervasyon kanal dalının üstüne taşınır); STT rezervasyonu `transcribeUrl`'den **önce** çağrılır; intake crawl/scrape ölçülür; `strategy-feedback.cron` haftalığa çekilir ve "son 7 günde giriş yapmış" koşulu eklenir.

**Para hataları:** aynı-paket tekrar satın almada dönem sıfırlanmaz; mutabakat süpürgesine `succeededAt > currentPeriodStart` kontrolü eklenir.

**Top-up döngüsü:** kredi süreli limit-delta'sı yerine kalıcı bakiyeye dönüştürülür (`GrowthWallet` deseni); adet seçici; %80/%100 uyarısı; `AI_CREDITS_EXHAUSTED` 403'ünün ön yüzde gerçek karşılığı.

**Ön yüz:** `PackageMatrix` üç sütundan tek karta iner; `popular = p.code === 'GROWTH'` sabiti kalkar; eksik 4 `FEATURE_LABELS` eklenir ve `PackageMatrix.test.tsx`'teki bayat 19-anahtar aynası aynı PR'da güncellenir; `UpgradeCallout`'un "Growth plan" metni yeniden hedeflenir; `gate.upgrade.*` ve paket açıklamaları Türkçeleştirilir (bugün kodda gömülü İngilizce, hiçbir dil dosyasında yok).

### W2 — Onboarding omurgası

- **Sunucu tarafı onboarding durumu.** Bugün checklist yalnızca `localStorage['kds-onboarding']`'da ve ✕ ile **kalıcı** kapanıyor; kapatan kullanıcı bir daha asla göremiyor. Kopyalanacak desen: `GET /marketing/netgsm/onboarding`.
- **İlk giriş tetikleyicisi.** Bugün girişten sonra hiçbir dallanma yok. Strateji yoksa sihirbaza yönlendirilir.
- **Sihirbaz ön-doldurması.** Kayıtta zaten toplanan `productUrl` / `productDescription` sihirbaza aktarılır — bugün aynı URL ikinci kez soruluyor ve kayıt sırasında hiçbir analiz başlatılmıyor.
- **Rakip CTA'lar çözülür.** Panoda "İlk lead'inle başla" checklist'in üstünde ve ondan baskın; pazarlama ürününde ilk adım elle lead eklemek değil.
- **Menüye sihirbaz girişi** (`/onboarding/strategy` bugün yalnızca konsolun CTA'sından ulaşılabiliyor).
- **Ürün turunun tetiği açılır.**
- **Social Planner çıkmazı.** Hesap bağlı değilken iki CTA da devre dışı ve `/accounts`'a link yok (`SocialPlannerPage.tsx:317,341-346`).
- **Kredi bitti deneyimi.** Bugün `AskAiPanel.tsx:22-25` her 403'ü "planında yok, yükselt" diye etiketliyor — kredisi biten kullanıcıya zaten sahip olduğu özelliği yükseltmesi söyleniyor.

### W3 — Geniş E2E kapsamı

IA W1/W2 sonrası kesinleştiği için en sona bırakıldı. Değer sırası: giriş→pano · lead CRUD · inbox · studio · strateji sihirbazı · fırsatlar · raporlar · ürün→sipariş formu→fatura · otomasyon builder · entegrasyonlar · **`/settings/modules`** (gating yığınının en iyi tek doğrulaması) · faturalama · operatör paneli. Ardından CI işi (postgres servisi, migrate, seed, backend boot, preview, hata artefaktları).

## Kapsam dışı

- **Yinelenen ödeme.** Bugün yalnızca Stripe yeniliyor; PayTR tek seferlik ve hiçbir kod RENEWAL siparişi üretmiyor. TL müşterisi ACTIVE → PAST_DUE → EXPIRED akışına hatırlatma, dunning ve tekrar denemesi olmadan giriyor. Ayrı proje.
- **Refresh-token iptal açığı.** Rotasyon yeni çift üretiyor ama eskisini iptal etmiyor; tek iptal yolu `tokenVersion`. Çalınan token 7 gün geçerli. Canlı probe ile doğrulandı (aynı token iki kez 201). `marketingAuthStore.ts`'teki "her kullanımda sunucuda iptal edilir" yorumu gerçeği yansıtmıyor.
- **Gerçek token ölçümü.** `anthropic.service.ts:104-112` her çağrıda `usage` döndürüyor, her caller atıyor. Bu spec'teki maliyet rakamları `max_tokens` tavanlarından türetildi, ölçümden değil. Bir `AiUsageLog` tablosu iki haftada gerçek $/kredi verir — fiyatı ölçümle yeniden türetmek için önerilir.

## Doğrulama

- Her iş kolu kendi testleriyle iner; backend'de mevcut 522 birim + 40 HTTP e2e spec'i yeşil kalır.
- Tripwire spec'leri (`entitlements.tripwire.spec.ts`, `feature-guard-presence.tripwire.spec.ts`) **düzenlenmeden** geçmelidir — geçmiyorsa yaklaşım yanlıştır.
- W1 sonrası `/settings/modules` E2E'si gating yığınının uçtan uca doğrulaması olur.
- W2 sonrası sıfırdan bir workspace ile ilk-giriş akışı tarayıcıda koşturulur.
