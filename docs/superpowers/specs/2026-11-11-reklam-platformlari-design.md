# Reklam yönetimi: Google, LinkedIn, TikTok ve X

Tarih: 2026-11-11. Üst tasarım: `2026-11-10-uc-modul-ve-panel-iskeleti-design.md` (§8 Reklam
yönetimi, §9 Bütçe, B32 para kuralı). Bu belge o tasarımın "Sonra" satırındaki "TikTok, LinkedIn, X,
Google reklamları"nı açar. Kararlar üst tasarımın numaralarını sürdürür (B61 ve sonrası benim
kararlarım; sahibin kararları S ile).

## 1. Neden

Sahibi: "tek reklam Meta'da verilmiyor", "bu reklam işine daha detaylı çalış, hepsini ekle"
(2026-11-11). Bugün yalnızca Meta'da kampanya kurulabiliyor. Reklam kampanyasının kendisi (hedef,
toplam bütçe, başlangıç ve bitiş, ajanın planı, Jeeta'nın kurması, izlemesi, durdurması) platformdan
bağımsız yazıldı; eksik olan her platformun bağlantısı, kurucusu ve o platformun kendi kuralları.

## 2. Değişmeyenler

- Bir insan hedef ve toplam bütçe verir ya da ajan önerir, insan onaylar (S20, S24). Ajan tek bir plan
  teslim eder. Jeeta denetler, bütün bütçeyi her sınıra karşı tutar ve kampanyayı platformda kendisi
  kurar: önce duraklatılmış, sonra etkinleştirilmiş (B11).
- Para kuralı (B32): kampanya bütçesi platformun kendi toplam bütçesi olarak kurulur. Genel reklam
  bütçesi ve stratejinin ücretli şerit tavanı bütün platformlar için ortaktır (S6, B37).
- İlk gerçek çalıştırma her platformda sahibinin kendi hesabında, küçük bütçeyle ve o anki açık
  onayıyla yapılır (B38). Aşağıdaki hiçbir çağrı gerçek platformda çalıştırılmadı.

## 3. Platformlar

Her satır resmî belgeden okundu (kaynaklar §9). "Kesin sınır", platformun toplam bütçeden fazlasını
harcamayacağını belgesinde söyleyip söylemediğidir.

| | Google | LinkedIn | TikTok | X |
|---|---|---|---|---|
| İlk sürümde kurulan | Arama kampanyası, metin reklamı (görsel yok) | Sponsorlu içerik, tek görselli | TikTok yerleşiminde tek görselli kaydırmalı reklam (müzik zorunlu) | Görselli web sitesi kartı taşıyan tanıtılan gönderi |
| Kesin sınır | Var: "you will never be charged more than your total budget" | Var: "you spend no more than the full budget for the lifetime of the campaign" | Var (yardım sayfası; arama ile): "will never exceed the budget you set" | **Belgede yok**: analiz sayfası "credits for overspend" diyor |
| En kısa süre, en düşük bütçe | 3 gün; en çok 90 gün. Alt bütçe belgede yok | Ömür boyu bütçe en az 100 (hesap para birimi); kitle en az 300 kişi | Kampanya en az 500 TL; reklam grubu en az 200 TL × gün | Belgede yok |
| Reklamın sahibi görünen kimlik | Yok (reklam hesabı) | Şirket Sayfası | Müşterinin gerçek TikTok hesabı, reklam hesabına bağlı olmalı | X hesabı |
| Eylem düğmesi | Yok | Var | Var | Yok (görselli web sitesi kartında) |
| Tek reklamı duraklatma | Var | İncelemedeki reklam duraklatılamaz; kampanyadan durur | Var | Yok: tanıtılan gönderi silinir |
| Önizleme | Yok | Yok | Yok | Yok |

### 3.1 Google Ads

- **Kurulum zinciri.** Kampanya bütçesi (`period: CUSTOM_PERIOD`, `total_amount_micros`,
  `explicitly_shared: false`) → kampanya (`SEARCH`, `PAUSED`, başlangıç ve bitiş zamanı, "Maximize
  clicks", `contains_eu_political_advertising` beyanı) → reklam grubu (`SEARCH_STANDARD`) → ülke
  hedefi ve anahtar sözcükler → duyarlı arama reklamı (3–15 başlık, 2–4 açıklama, hedef adres).
  Bütçe türü sonradan değiştirilemez. Tek `mutate` isteği bu nesnelerin hepsini bir arada, ya hep ya
  hiç oluşturabilir.
- **Durum ve sayılar.** `ad_group_ad.policy_summary` (onay ve inceleme durumu, politika konuları);
  günlük sayılar `ad_group_ad` üzerinden GAQL ile (`segments.date`, `metrics.cost_micros`,
  `impressions`, `clicks`).
- **Bağlantı.** OAuth, kapsam `https://www.googleapis.com/auth/adwords`, çevrimdışı erişim.
  `ListAccessibleCustomers` kullanıcının doğrudan eriştiği hesapları verir; para birimi, saat dilimi
  ve durum `customer` kaynağından okunur. Yönetici (MCC) hesabı üzerinden erişim ilk sürümde yok.
- **Sürüm.** v26; sürümler yaklaşık 12 ay yaşar.

### 3.2 LinkedIn

- **Kurulum zinciri.** Kampanya grubu (`totalBudget`, `runSchedule`) → kampanya
  (`SPONSORED_UPDATES`, `WEBSITE_VISIT`, `totalBudget`, `runSchedule`, `pacingStrategy: LIFETIME`,
  hedefleme, `politicalIntent`) → görsel yükleme → karanlık gönderi (yazarı şirket Sayfası,
  `adContext`, `contentLandingPage`, eylem düğmesi) → kreatif → etkinleştirme. Günlük bütçe
  kullanılmaz: günlük bütçe aşım yapar.
- **Durum ve sayılar.** Kreatifin `review.status` ve `rejectionReasons`; günlük sayılar `adAnalytics`
  (`pivot=CREATIVE`, `timeGranularity=DAILY`, `costInLocalCurrency`, `landingPageClicks`).
- **Bağlantı.** Bugünkü LinkedIn uygulaması; ek kapsamlar `rw_ads`, `r_ads`, `r_ads_reporting`.
  Farklı kapsamla yeni giriş eski belirteci geçersiz kılar: reklam açıkken giriş, Sayfa ve reklam
  kapsamlarının birleşimini ister. Hesaplar `adAccountUsers?q=authenticatedUser` ile listelenir;
  kampanya için hesapta `CAMPAIGN_MANAGER` ya da üstü rol gerekir.
- **Sürüm.** `Linkedin-Version: YYYYMM` başlığı; her sürüm en az bir yıl.

### 3.3 TikTok

- **Kurulum zinciri.** Kampanya (`TRAFFIC`, `BUDGET_MODE_TOTAL`, `operation_status: DISABLE`) →
  reklam grubu (`PLACEMENT_TIKTOK`, ülke, `SCHEDULE_START_END`, toplam bütçe, `CLICK` / `CPC`) →
  görsel yükleme → müzik seçimi → reklam (`CAROUSEL_ADS`, görsel, `music_id`, kimlik, en çok 100
  karakter metin, eylem düğmesi, hedef adres). Eski "elle kurulan" uçlar kullanılır: Smart+ uçları
  trafik amacını kabul etmiyor.
- **Kimlik.** TikTok yerleşiminde ad ve avatarla özel kimlik reddediliyor; reklam hesabına bağlı
  gerçek bir TikTok hesabı (`TT_USER` ya da `BC_AUTH_TT`) gerekir.
- **Durum ve sayılar.** `secondary_status` ve `/ad/review_info/` (ret nedenleri); günlük sayılar
  `/report/integrated/get/` (`data_level: AUCTION_AD`, `stat_time_day`).
- **Bağlantı.** Bugünkü TikTok bağlantısı (paylaşım için Login Kit) reklam için geçerli değil:
  TikTok for Business ayrı bir uygulama ve ayrı bir yetkilendirme ister. Reklamverenin verdiği
  belirtecin süresi dolmaz.
- **Belirsizlik.** Belge sitesinin bir sayfası 2027 başından sonra elle kurulan kampanyaların hiç
  oluşturulamayacağını, duyurusu ise yalnızca satış, uygulama ve form amaçlarını söylüyor. Trafik
  amacının durumu TikTok'a sorulmalı (§8).

### 3.4 X

- **Kurulum zinciri.** Kampanya (toplam bütçe, `PAUSED`, fonlama aracı) → satır öğesi
  (`WEBSITE_CLICKS`, `PROMOTED_TWEETS`, başlangıç ve bitiş, `PAUSED`, toplam bütçe) → görsel yükleme
  → web sitesi kartı → yalnızca tanıtım için gönderi → tanıtılan gönderi → ülke hedefi → satır
  öğesinin ve kampanyanın etkinleştirilmesi.
- **Durum ve sayılar.** `entity_status`, `servable`, `reasons_not_servable`; günlük sayılar
  `stats/accounts/:id` (`PROMOTED_TWEET`, `BILLING` ve `ENGAGEMENT`, istek başına en çok 7 gün,
  günler hesabın saat dilimine göre).
- **Bağlantı.** Belgeler çelişiyor: reklam sayfaları yalnızca OAuth 1.0a diyor, yeni sayfalar OAuth
  1.0a'nın 2027-01-31'de kapanacağını ve reklam API'sinin OAuth 2.0 belirtecini kabul ettiğini
  söylüyor. OAuth 2.0 ile yazılır (`ads.read`, `ads.write`, `media.write`, `offline.access`) ve ilk
  gerçek çağrıyla doğrulanır. Para birimi fonlama aracından okunur; fonlama aracı API ile açılamaz.

## 4. Kararlar

| No | Karar |
|---|---|
| B61 | Bir reklam kampanyası tek bir reklam hesabında, yani tek bir platformda çalışır; platform, hesabın türünden gelir. Bir bütçeyi platformlar arasında bölen kampanya bu sürümde yok: iki platform isteyen iki kampanya açar. Genel reklam bütçesi hepsini birlikte sınırlar |
| B62 | Beş reklam hesabı türü vardır: `meta_ads`, `google_ads`, `linkedin_ads`, `tiktok_ads`, `x_ads`. Reklam yönetimi modülü bunlardan birinin bağlı olmasını ister. Her türün yazma izni ayrı denetlenir (Meta `ads_management`, Google `adwords`, LinkedIn `rw_ads`, X `ads.write`; TikTok'ta reklamveren yetkilendirmesi) ve eksikse plan reddi bunu adıyla söyler (B58) |
| B63 | Plan tek ve kapalı bir şema olarak kalır; bir reklamın neyi taşıdığı platforma göre değişir ve platformun almadığı alan reddedilir. Meta: Sayfa, görsel, ana metin, başlık, açıklama, eylem düğmesi. LinkedIn: şirket Sayfası, görsel, ana metin, başlık, eylem düğmesi. TikTok: TikTok hesabı, görsel, en çok 100 karakter metin, eylem düğmesi. X: X hesabı, görsel, ana metin, kart başlığı. Google: 3–15 başlık (en çok 30 karakter), 2–4 açıklama (en çok 90 karakter), planın kendisinde 1–20 anahtar sözcük; görsel ve Sayfa yok |
| B64 | Meta dışındaki platformlarda ilk sürümün kitlesi ülke, yaş ve cinsiyettir. Bölge, şehir ve ilgi alanı Meta'nın kendi anahtarlarıdır, başka platformda reddedilir. Geniş kitle (`broad`) yalnızca Meta'dadır. Google aramada kitle, anahtar sözcükler ve ülkedir; yaş ve cinsiyet gönderilmez |
| B65 | Sonuç her platformda bağlantı tıklamasıdır (web sitesi). Form kampanyası bu sürümde yalnızca Meta'da kalır |
| B66 | Platformun kendi sınırları plan bulgusudur, kurulumda öğrenilmez: Google'da 3 günden kısa ya da 90 günden uzun süre, LinkedIn'de 100'ün altında bütçe, TikTok'ta kampanya ve reklam grubu alt sınırlarının altında bütçe, metin uzunlukları. Platform alt sınırı API'den veriyorsa oradan okunur (LinkedIn `adBudgetPricing`, Meta `min_daily_budget`); vermiyorsa belgedeki değer sabit olarak tutulur ve bu belgede kaynağıyla yazılır |
| B67 | X'te toplam bütçenin aşılmayacağı belgede yazmıyor. X kampanyası yine toplam bütçeyle kurulur (kampanyada ve satır öğesinde), ama Jeeta X'i saatte bir değil on beş dakikada bir okur, bütçeye ulaşıldığında satır öğesini ve kampanyayı duraklatır, panel ve ajan aracı X hesabı seçildiğinde bu farkı açıkça söyler. Aşım olursa gerçek harcama olduğu gibi genel reklam bütçesine yazılır. X dört platformun sonuncusu olarak kurulur |
| B68 | Google'ın ilk sürümü arama reklamıdır: görsel ve logo istemez, toplam bütçeyi destekler, reklam başına günlük sayı verir. Görselli Google reklamı (Demand Gen) ikinci sürümdür; Performance Max kurulmaz (reklam başına sayı vermez, yalnızca dönüşüm teklifiyle çalışır) |
| B69 | TikTok'un ilk sürümü tek görselli kaydırmalı reklamdır, çünkü Jeeta bugün görsel üretir, video üretmez. Müzik zorunludur: Jeeta, TikTok'un kaydırmalı reklam için verdiği listeden ilk parçayı alır; ajan parça seçmez. Video reklamı kısa video üretimiyle birlikte gelir |
| B70 | Bağlayıcı arayüzü (`AdCampaignWriter`: kampanya, reklam seti, görsel, kreatif, reklam, durum, günlük sayılar; `set_status`) değişmeden kalır; her platform kendi zincirini bu adımlara oturtur. Platformun ayrı bir kreatif nesnesi yoksa (Google, TikTok) o adım hiçbir çağrı yapmaz. Kimlikler bağlayıcının kendi kodladığı dizgilerdir (hesap ve nesne türü içinde), çünkü Meta dışında bir nesne yalnızca kimliğiyle bulunamaz |
| B71 | Hiçbir platform oluşturma çağrısında yineleme anahtarı vermiyor (TikTok'unki 10 saniye geçerli). Bu yüzden B11'in kuralı her platformda uygulanır: her nesnenin adı kampanyanın kimliğini taşır ve oluşturmadan önce o adla aranır |
| B72 | Önizleme yalnızca Meta'da vardır. Başka platformda panel planın metnini ve görselini gösterir, "platform önizlemesi yok" der |
| B73 | Tek reklamı duraklatamayan platformda (X) "reklamı duraklat" hamlesi tanıtılan gönderiyi siler, "sürdür" yeniden oluşturur. İncelemedeki reklamı duraklatamayan platform (LinkedIn) için B77'ye bakın |
| B74 | Kurulum sırası: önce ortak çekirdek (hesap türleri, platforma göre plan, bulgular, panel), sonra Google, LinkedIn, TikTok, X. Her platform kendi CI'ı ve staging yayınıyla ayrı çıkar; biri gecikirse diğerleri beklemez |
| B75 | LinkedIn'in geliştirici yapay zekâ politikası "son kullanıcı katılımı olmadan yapay zekâ üretimi içeriğin otomatik paylaşımını" kısıtlıyor; reklam oluşturmayı bağlayıp bağlamadığı belgede açık değil. LinkedIn'de kampanya yalnızca bir insanın açtığı ya da onayladığı kampanyadır (zaten böyle: S20, S24) ve bu, LinkedIn başvurusunda böyle anlatılır. Belirsizlik sahibine bildirildi |
| B76 | Google'da anahtar sözcükler "sıralı eşleme" (phrase match) ile kurulur: geniş eşleme küçük bir toplam bütçeyi ilgisiz aramalara harcayabilir, tam eşleme çoğu zaman hiç gösterim almaz. Ajan eşleme türü seçmez |
| B77 | B73'ün "hamle reddedilir" kuralı yerine: tutulan (ya da yerine yenisi konan) bir reklamı platform hâlâ çalışıyor diye bildirirse izleme onu her okumada yeniden duraklatır. Böylece incelemedeki reklamı duraklatamayan platformda (LinkedIn) tutma kaydedilir ve inceleme bitince uygulanır; duraklatma isteği yolda kaybolan her platformda da aynı şey olur |
| B78 | Görseli olmayan reklamın (arama reklamı) metinleri materyalsiz doğruluk denetiminden geçer: konusu genel sayılır ve yalnızca doğrulanmış bir olayın kendi materyalinin söyleyebileceğini söyleyemez. Görselli reklamda denetim değişmez |
| B79 | Avrupa Birliği ülkesi hedeflemesi bu sürümde hiçbir platformda yoktur (her platformun AB'ye özel bir beyanı ya da ödeyen/yararlanan bilgisi var). Jeeta her platformda "siyasi reklam değil" beyanını gönderir; siyasi ve özel kategorili reklam desteklenmez (B33'ün devamı) |
| B80 | Google başlangıç ve bitişi hesabın saat diliminde ve (her kampanya türü için) gün ayrıntısında alır. Kampanya, başlangıç gününün 00:00:00'ından bitiş gününün 23:59:59'una kurulur; tam bitiş anı Jeeta'nındır (izleme kampanyayı bitiş saatinde duraklatır), Google'ınki yedektir. Gün sayımı bir gün fazla çıkabildiği için Google'da en uzun süre 89 gündür; en kısa süre 72 saat her zaman Google'ın üç gününü kapsar |
| B81 | Google'da reklamın adı yoktur (API'nin `Ad.name` alanı başka reklam türleri içindir), bu yüzden B71'in "adla ara" kuralı reklamda uygulanamaz. Bağlayıcı reklamı oluşturmadan önce reklam grubunda aynı başlıkları, açıklamaları ve adresi taşıyan bir reklam arar ve varsa benimser. Buna bağlı olarak Google'da bir kampanyanın iki reklamı aynı şeyi söyleyemez (`same_as_another_ad`); düzeltme hamlesi de yerine geçtiği reklamla aynı şeyi söyleyemez |
| B82 | Google arama kampanyası yalnızca Google Arama'da gösterilir: Görüntülü Reklam Ağı ve arama ortakları kapalıdır (plan bir arama reklamıdır; planlanan ve denetlenen neyse o yayınlanır, B55 ile aynı gerekçe). Konum, ülkede *bulunanlar*dır (`PRESENCE`), ülkeyle yalnızca ilgilenenler değil. Teklif "tıklamaları en üst düzeye çıkar"dır |
| B83 | Google'ın erişim belirteci yaklaşık bir saat yaşar; saatlik yenileme işi arada boşluk bırakır. Bu yüzden saklanan kimlik bitiş zamanı taşımaz (bağlantı yenileme belirteci kadar yaşar; bitiş saklansaydı bağlantı her saat bir süre "süresi dolmuş" okunurdu) ve bağlayıcı her çağrı için yenileme belirteciyle bir erişim belirteci alıp bitimine yakın olana dek bellekte tutar. Yenileme belirteci getirmeyen bir giriş reddedilir. Yönetici (MCC) hesabı üzerinden erişilen hesaplar sunulmaz (`login-customer-id` gönderilmez) |
| B84 | Google API erişimi Google Cloud projesine verilir (geliştirici belirteci artık gönderilmez). Projenin erişim düzeyi yetmediğinde gelen hata (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` ve benzerleri) kiracının değil platformundur: "yeniden bağlan" denmez, platformun projesinin bu hesabı çağıramadığı söylenir |

## 5. Ortak çekirdekte değişenler

- **Hesap türleri ve bağlantı.** Dört yeni yetenek türü, her birinin girişi, hesap keşfi ve
  yoklaması. Google yeni bir sağlayıcıdır (bugün hiç bağlantısı yok); TikTok reklamları ayrı bir
  platform uygulaması ister; LinkedIn ve X bugünkü uygulamalarına ek kapsam ister.
- **Plan.** `ads.plan_submit` şeması platforma göre alan alır (B63); denetim hesabın türüne göre
  yapılır. `ads.campaign_get` ajana kampanyanın hangi platformda olduğunu ve o platformun planının
  neyi istediğini söyler.
- **Biçim ve bulgular.** Platformun almadığı ya da gerektirdiği alan biçim hatasıdır (`VALIDATION`,
  alanın adıyla: `field_not_for_this_platform`, `required_on_this_platform`, uzunluk ve sayı
  sınırları) ve ret sayılmaz. Platformun çalıştırmadığı süre (`duration_not_supported`) ve hesabın
  en düşük bütçesinin altındaki bütçe (var olan `below_the_accounts_minimum`) reddedilen planın
  bulgusudur. Panel insanın yapabileceği olanları sözle söyler.
- **İzleme.** Okuma aralığı platforma göre (X on beş dakika, diğerleri saatlik). Sonuç sayısı her
  platformda bağlantı tıklamasıdır.
- **Panel.** Hesap seçimi platformu gösterir; kampanya sayfası planı platformuna göre gösterir;
  X hesabı seçildiğinde bütçe uyarısı; bağlantılar sayfasında dört yeni tür.

## 6. Yapılmayacaklar (bu sürümde)

Platformlar arası bütçe bölüşümü; Google Demand Gen ve Performance Max; TikTok ve X'te video;
Meta dışında form kampanyası; Meta dışında bölge, şehir ve ilgi alanı hedeflemesi; yönetici (MCC,
Business Center) hesabı üzerinden erişim; platformların kendi önizlemeleri.

## 7. Sahibinin şimdiden başlatması gerekenler

İzinler uzun süren kısımdır; kod hazır olduğunda izin de hazır olmalı.

| Platform | Başvuru | Belgedeki süre |
|---|---|---|
| Google | Google Cloud projesinde Google Ads API'yi açmak; erişim düzeyi "Explorer" (çoğunlukla otomatik), sonra marka doğrulamasıyla "Basic"; OAuth izin ekranının `adwords` kapsamı için doğrulanması. İzin ekranı "Testing" durumundayken belirteçler 7 günde bir düşer | Standard düzeyi için 10 iş günü; diğerleri belirtilmemiş |
| LinkedIn | Geliştirici uygulamasına "Advertising API" ürününü istemek (Development kademesi: en çok 5 reklam hesabı, hesaplar geliştirici portalında eşlenir). Sonra destek bileti ve tanıtım videosuyla Standard kademesi | Belirtilmemiş |
| TikTok | TikTok for Business geliştirici kaydı (şirket alan adlı e-posta ve şirket sitesi); uygulama incelemesi, kapsamlar: Ad Account Management, Ads Management, Reporting, Creative Management | Kayıt yaklaşık 3, inceleme 2–3 iş günü |
| X | Uygulama için Ads API Access Form (Standard Access) ve Ads API Agreement'ın kabulü. Sözleşme, ücretlerin harcamanın yüzdesi olarak ayrıca gösterilmesini ve beyaz etiketli sürüm için X'in onayını istiyor: sahibi okumalı | 3 iş gününe kadar |

Her platformda ilk gerçek deneme için ayrıca gerçek bir reklam hesabı gerekir: Google ve LinkedIn
test hesapları reklam göstermez ve sayı vermez; TikTok'un deneme ortamı 2026-12-01'de kapanıyor.

## 8. Açık sorular

| No | Soru | Kimde |
|---|---|---|
| A6 | TikTok, 2027 başından sonra trafik amaçlı elle kurulan kampanyayı API'den kabul edecek mi? | Sahibi, TikTok'a sorar |
| A7 | X reklam API'si OAuth 2.0 belirtecini gerçekten kabul ediyor mu? | İlk gerçek çağrıda görülür |
| A8 | LinkedIn'in yapay zekâ politikası reklam oluşturmayı bağlıyor mu (B75)? | Sahibi, başvuruda |
| A9 | TikTok'ta reklam hesabına bağlı TikTok hesabını, yetkilendirmeyi yapan kullanıcıdan başka biri bağladıysa belirteç onu görüyor mu? | İlk gerçek çağrıda görülür |

## 9. Kaynaklar

Hepsi 2026-11-11'de okundu.

- **Google:** developers.google.com/google-ads/api altında `docs/api-policy/access-levels`,
  `docs/oauth/multi-user-authentication`, `docs/account-management/listing-accounts`,
  `docs/campaigns/search-campaigns/getting-started`, `docs/responsive-search-ads/overview`,
  `docs/campaigns/budgets/create-budgets`, `docs/campaigns/budgets/overview`,
  `docs/api-policy/eu-par`, `docs/sunset-dates`, `docs/mutating/best-practices`,
  `reference/rpc/v26/AdGroupAdPolicySummary`; support.google.com/google-ads/answer/10486938 ve
  10486536 (toplam bütçe).
- **LinkedIn:** learn.microsoft.com/en-us/linkedin/marketing altında `increasing-access`,
  `integrations/ads/account-structure/create-and-manage-campaign-groups`,
  `…/create-and-manage-campaigns`, `…/create-and-manage-creatives`,
  `…/create-and-manage-account-users`, `community-management/shares/images-api`,
  `community-management/shares/post-api-schema`, `integrations/ads-reporting/ads-reporting`,
  `developer-ai-policy`, `versioning`; linkedin.com/help/lms/answer/a422101 (ömür boyu bütçe).
- **TikTok:** `github.com/tiktok/tiktok-business-api-sdk` (commit `f809c396`) ve
  business-api.tiktok.com/portal/docs sayfaları (kimlikleri: 1739318962329602 kampanya,
  1739499616346114 reklam grubu, 1739953377508354 reklam, 1766217791987713 kaydırmalı reklam,
  1848048566169730 kimlik, 1739381246298114 bütçe, 1737585839634433 alt sınırlar,
  1740302848100353 rapor, 1853452461203458 elle kurulan kampanyalar). Kesin sınır cümlesi
  ads.tiktok.com yardım sayfasından, arama ile.
- **X:** `github.com/xdevplatform/docs` (commit `fe4cdaf4`): `x-ads-api/campaign-management.mdx`,
  `x-ads-api/campaign-management/reference.mdx`, `x-ads-api/creatives/reference.mdx`,
  `x-ads-api/analytics.mdx`, `x-ads-api/fundamentals/`,
  `fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.mdx`,
  `developer-terms/ads-api-agreement.mdx`.
