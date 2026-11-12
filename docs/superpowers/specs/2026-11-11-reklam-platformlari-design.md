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
| Kesin sınır | Var: "you will never be charged more than your total budget" | Var: "you spend no more than the full budget for the lifetime of the campaign" | Var (yardım sayfası, 2026-11-12'de doğrudan okundu): "it won't exceed the total lifetime budget by the end of the campaign"; "Once your ad group reaches its allocated budget, ad delivery will pause automatically." | **Belgede yok**: toplam bütçenin aşılmayacağı yazmıyor. Analiz sayfası "credits for overspend"den yalnızca bitiş saatinden sonra gösterilen reklamlar için söz ediyor |
| En kısa süre, en düşük bütçe | 3 gün; en çok 90 gün. Alt bütçe belgede yok | En düşük ömür boyu bütçe süreye göre değişir ve LinkedIn onu yalnızca reddederken söyler (belgedeki hata örneği: "cannot be lower than 100.00"); kitle en az 300 kişi (B86) | Kampanya en az 500 TL; reklam grubu en az 200 TL × gün | Belgede yok |
| Reklamın sahibi görünen kimlik | Yok (reklam hesabı) | Reklam hesabının kendi şirket Sayfası (B85) | Müşterinin gerçek TikTok hesabı, reklam hesabına bağlı olmalı | X hesabı |
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
  hedefleme, `politicalIntent`, `PAUSED`) → görsel yükleme → karanlık gönderi (yazarı şirket
  Sayfası, `adContext`, `contentLandingPage`, eylem düğmesi) ile kreatif tek çağrıda
  (`creatives?action=createInline`, taslak olarak) → etkinleştirme: kreatifler, kampanya, kampanya
  grubu. Günlük bütçe kullanılmaz: günlük bütçe aşım yapar.
- **Durum ve sayılar.** Kreatifin `review.status` ve `rejectionReasons`; günlük sayılar `adAnalytics`
  (`pivot=CREATIVE`, `timeGranularity=DAILY`, `costInLocalCurrency`, `landingPageClicks`).
- **Bağlantı.** Bugünkü LinkedIn uygulaması; ek kapsamlar `rw_ads`, `r_ads`, `r_ads_reporting` ve
  reklamın kendi gönderisi için `w_organization_social`, `r_organization_social` (hepsi Advertising
  API ürünüyle gelir). İşletmeci, ürün onaylanınca `JEETA_LINKEDIN_AD_SCOPES` ayarını açar; kapalıyken
  `linkedin_ads` bağlantısı reddedilir. Farklı kapsamla yeni giriş eski belirteci geçersiz kılar:
  ayar açıkken her LinkedIn girişi, açık olan bütün kapsamların birleşimini ister. Hesaplar `adAccountUsers?q=authenticatedUser` ile listelenir;
  kampanya için hesapta `CAMPAIGN_MANAGER` ya da üstü rol gerekir.
- **Sürüm.** `Linkedin-Version: YYYYMM` başlığı; her sürüm en az bir yıl.

### 3.3 TikTok

- **Kurulum zinciri.** Kampanya (`TRAFFIC`, `BUDGET_MODE_TOTAL`, `operation_status: DISABLE`) →
  reklam grubu (`PLACEMENT_TIKTOK`, ülke, `SCHEDULE_START_END`, toplam bütçe, `CLICK` / `CPC`) →
  görsel yükleme → müzik seçimi → reklam (`CAROUSEL_ADS`, görsel, `music_id`, kimlik, en çok 100
  karakter metin, eylem düğmesi, hedef adres). Eski "elle kurulan" uçlar kullanılır: Smart+ uçları
  trafik amacını kabul etmiyor.
- **Kimlik.** TikTok yerleşiminde ad ve avatarla özel kimlik reddediliyor; reklam hesabına bağlı
  gerçek bir TikTok hesabı (`TT_USER` ya da `BC_AUTH_TT`) gerekir. Bağlayıcı bağlı tek hesabı
  kullanır (B88).
- **Yetkilendirme.** TikTok for Business uygulamasının yetkilendirme sayfası
  (`/portal/auth?app_id&state&redirect_uri`); dönüşte `auth_code` (ve başka bir değer olarak `code`)
  gelir, kod `auth_code`'dur; `oauth2/access_token` ile süresi dolmayan belirtece çevrilir. İkinci
  uygulama ayrı bir dönüş adresi ister (`/oauth/callback/tiktok_ads`, göç `0042`).
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
  (`WEBSITE_CLICKS`, `PROMOTED_TWEETS`, başlangıç ve bitiş, `PAUSED`, toplam bütçe) ve onun ülke
  hedefi (B95) → görsel yükleme → web sitesi kartı → yalnızca tanıtım için gönderi → tanıtılan
  gönderi → satır öğesinin ve kampanyanın etkinleştirilmesi.
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
| B85 | LinkedIn'de reklam, reklam hesabının adına reklam verdiği şirket Sayfası adına konuşur (hesabın LinkedIn'deki `reference` alanı). Plan Sayfa taşımaz ve ayrıca bir `linkedin_page` bağlantısı gerekmez: görselin sahibi, gönderinin yazarı ve kampanyanın bağlı kurumu her adımda LinkedIn'den okunan o tek kurumdur. Böylece reklam, Sayfa bağlantısının istediği Community Management API onayına bağlı kalmaz. Bir kişi adına reklam veren hesap seçime sunulmaz. (B63'ün LinkedIn satırındaki "şirket Sayfası" alanının yerine geçer.) |
| B86 | LinkedIn en düşük ömür boyu bütçeyi sürenin uzunluğuna göre belirler ve yalnızca reddederken söyler ("will be displayed if the set budget is too low"); `adBudgetPricing` hedeflemeye göre günlük alt sınır ve teklif verir, toplam alt sınır vermez. Bu yüzden LinkedIn'de alt sınır plan bulgusu olamaz: bütçe küçükse kurulum kampanya adımında LinkedIn'in kendi cümlesiyle durur, hiçbir şey harcanmaz ve kampanya bir insanı bekler. (B66'nın LinkedIn bölümünün yerine geçer; ilk gerçek denemede öğrenilen alt sınırlar buraya yazılır.) |
| B87 | LinkedIn'de ilk sürümün kitlesi yalnızca ülkelerdir; yaş ve cinsiyet gönderilmez. LinkedIn, hedeflemesinin cinsiyet ve yaş gibi kişisel özelliklere göre ayrımcılık için kullanılmasını yasaklar ve hedefleme yapan uygulamaların bunu arayüzünde bildirmesini ister: panel bildirimi LinkedIn hesabı seçilirken ve LinkedIn kampanyasının sayfasında gösterir, ajan aracı da söyler. LinkedIn ülkeyi kendi konum varlığı olarak, koda göre değil ada göre verir: ad LinkedIn'in ülke kodu tablosundan alınır ve arama yanıtında tam o adı taşıyan tek bir varlık yoksa kampanya kurulmaz. Kampanyanın dili ilk ülkenin LinkedIn'de listelenen dilidir (yoksa İngilizce) ve LinkedIn'in kendi örneğinde olduğu gibi kitleye de yazılır (`interfaceLocales`): LinkedIn'i başka dilde kullanan üyeler reklamı görmez (Campaign Manager'daki "profil dili" ile aynı davranış). Görsel JPG, PNG ya da GIF olmalıdır; başka türde görsel plan bulgusudur (`image_type_not_taken`). (B64'ün LinkedIn için daraltılmış hâli.) |
| B88 | TikTok'ta reklam, reklam hesabına bağlı gerçek TikTok hesabı adına konuşur (`TT_USER` ya da `BC_AUTH_TT`); plan hesap taşımaz. Bağlı ve kullanılabilir tek bir hesap olmalıdır: hiç yoksa ya da birden fazlaysa reklam kurulmaz, hesap tahmin edilmez. TikTok'ta ilk sürümün kitlesi yalnızca ülkelerdir ve 18 yaş üstü bütün yaş grupları açıkça gönderilir (TikTok birçok pazarda 13–17 yaşa ulaşabilecek reklamı reddediyor); yaş aralığı ve cinsiyet gönderilmez (TikTok'un yaş grupları planın yaş aralığıyla bire bir örtüşmez). Reklam yalnızca TikTok'un kendisinde gösterilir (`PLACEMENT_TIKTOK`). (B63 ve B64'ün TikTok için kesinleşmiş hâli.) |
| B89 | TikTok alt bütçelerini önceden söyler: reklam grubunda günde 20 ABD doları (ömür boyu bütçede bunun gün sayısı katı), kampanyada 50 ABD doları; her biri para biriminin "bütçe doğrulama katsayısı" ile çarpılır (Türk lirasında 10). Katsayı tablosu TikTok'un sayfasından üretilip bağlayıcıda tutulur. TikTok'un iki sayfası kampanya alt sınırında çelişir (20 ve 50): sıkı olan tutulur. Bunlar hesabın sınırlarıdır ve küçük bütçe plan bulgusudur. Kampanya `request_id` olmadan oluşturulur: TikTok o zaman aynı adlı ikinci kampanyayı kendisi reddeder. Görselin dosya adı görselin MD5 özetini taşır; aynı ad reddedilirse görsel özetiyle bulunur. Metinde emoji olamaz ve bu, plan aşamasında denetlenir (`no_emoji`). |
| B90 | TikTok'un "yapay zekâ ile üretildi" etiketi (`aigc_disclosure_type`) yalnızca özel kimlikli reklamda vardır; TikTok ise kendi yerleşiminde özel kimliği artık kabul etmiyor. Bağlı hesap adına konuşan reklam bu etiketi API'den taşıyamaz. Jeeta'nın TikTok reklamında görseli ajan üretmiş olabilir (B39): etiketi TikTok kendi koyabilir, Jeeta koyamaz. Bu sınır sahibine bildirildi; gerekirse TikTok reklamında yalnızca gerçek çekim kullanılması ayrı bir karar olarak alınır. |
| B91 | B69'un "listeden ilk parça" kuralı şöyle kesinleşir: TikTok müzik önerisini (`SEARCH_BY_RECOMMEND`) en az iki görsel adresi için verir, tek görselli reklamda kullanılamaz. Parça sırayla şuradan alınır: reklamverenin TikTok'ta beğendiği ilk parça (`SEARCH_BY_LIKED`), yoksa reklam hesabının geçmişte kullandığı ilk parça (`SEARCH_BY_HISTORY`), o da yoksa `background` anahtar sözcüğüyle aramanın ilk sonucu (`SEARCH_BY_KEYWORD`). Hepsi TikTok'un kaydırmalı reklam için sunduğu müziktir. Üçü de boşsa reklam kurulmaz. Müziği kendisi seçmek isteyen reklamveren bunu TikTok'ta bir parçayı beğenerek yapar; Jeeta'da ayrı bir seçim alanı yoktur. TikTok'un reklam listesinde ada göre süzme ve görsel aramasında özete göre süzme olmadığı için bağlayıcı reklam grubunun reklamlarını ve hesabın görsellerini okuyup eşleştirmeyi kendisi yapar. |
| B92 | X'te reklam, reklam hesabının kendi X kullanıcısı adına yazılan ve yalnızca tanıtım için olan (profilde görünmeyen, `nullcast`) bir gönderidir; plan hesap taşımaz ve ayrıca bir `x` bağlantısı gerekmez. Gönderi, hesabın adına reklam verdiği kullanıcı (X'in `FULL` "promotable user"ı) için yazılır; bu X'in varsayılanıdır, kullanıcı adı verilmez. Gönderi bir web sitesi kartı taşır: görsel (JPG ya da PNG, en çok 3 MB), en çok 70 karakterlik başlık ve adres. Web sitesi kartında düğme yoktur: X'te `call_to_action` ve `description` alınmaz. `primary_text` gönderinin metnidir (X'in saydığı biçimde en çok 280 karakter) ve yazıyla bağlantı taşıyamaz (`no_link`: X web sitesi kartı ya da gönderide bağlantı ister, ikisini birden değil); `headline` kartın başlığıdır. Görsel yüklendikten sonra reklam hesabının medya kitaplığına eklenir (X'in belgelediği iki adımlı yol): kart görseli oradan alır. X'in Ads API'sinde "siyasi reklam değil" beyanı için bir alan yoktur; Avrupa Birliği ülkesi hedeflemesi burada da reddedilir (B79) |
| B93 | X kampanyası bir fonlama aracına bağlanır. Hesabın ödeyebilen (`able_to_fund`, etkin, silinmemiş) tek bir fonlama aracı olmalıdır: hiç yoksa ya da birden fazlaysa hesap seçime sunulmaz ve kampanya kurulmaz; hangisinin ödeyeceği tahmin edilmez. Para birimi o araçtan okunur. X çoğu hesapta kampanyada günlük bütçe de ister ve günlük bütçe toplamı aşamaz: günlük bütçe olarak toplamın kendisi verilir, böylece tek sınır toplamdır. Hesap ayrıca X'in onayladığı (`ACCEPTED`) bir hesap olmalı ve giriş yapan kullanıcı kampanya kurabilmelidir (`ACCOUNT_ADMIN` ya da `AD_MANAGER`). Tanıtılan gönderiyi hesabın adına reklam verdiği kullanıcı yazar: giriş yapan o kullanıcıysa başka izin gerekmez; başka biriyse X'in `TWEET_COMPOSER` izni gerekir ve görsel yüklenirken o kullanıcı ek sahip (`additional_owners`) olarak verilir. Hesabın adına reklam verdiği tek bir kullanıcı yoksa hesap sunulmaz |
| B94 | B73'ün uygulanışı. X'te tek bir tanıtılan gönderinin açma/kapama anahtarı yoktur (`promoted_tweets` yalnızca oluşturulur, okunur ve silinir). Bir reklam, tanıtımı silinerek duraklatılır ve yeniden oluşturularak sürdürülür; gönderinin kendisi kalır. Bu yüzden reklamın kimliği X'in tanıtım satırı değil, satır öğesi ile gönderidir (`xa:{hesap}:ad:{satır öğesi}:{gönderi}`): duraklatılıp sürdürülen reklam aynı reklam kalır. Durumu o an var olan tanıtımından okunur; hiç tanıtımı kalmamışsa duraklatılmıştır. Reklam kapalı oluşturulur: reklam adımı gönderiyi yazar ama tanıtmaz; tanıtım, reklam açıldığında oluşturulur. X'te duraklatılmış tanıtım olmadığı için, çalışan bir kampanyaya eklenen bir reklam böylece kurulum onu açmadan yayına girmez |
| B95 | Konum ölçütü olmayan bir satır öğesi herkese, her yerde gösterilir. Bu yüzden ülkeler ayrı bir adım değildir: satır öğesi adımı önce her ülkenin X'teki karşılığını bulur (X'in tek bir konum olarak tanımadığı ülke hiçbir şey oluşturulmadan reddedilir), sonra satır öğesini oluşturur ya da kampanyada aynı adı taşıyanı benimser, sonra eksik her ülkeyi ekler ve ancak hepsi yerindeyken yanıt verir. Ortak çekirdeğin "adla ara" adımı X'te satır öğesi için boş döner; benimsemeyi adım kendisi yapar ki yarıda kalmış bir kurulumda eksik ülke tamamlansın. Satır öğesi `PAUSED` olduğu için arada hiçbir şey gösterilmez |
| B96 | X günlük sayıları tanıtım satırı başına verir ve bir istekte en çok yedi gün ve yirmi kimlik alır. Bağlayıcı aralığı yedişer günlük parçalara, kimlikleri yirmişerlik gruplara böler ve bir reklamın (silinmiş olanlar dahil) bütün tanıtımlarının sayılarını toplar. Sonuç, karttaki bağlantıya tıklamadır (`url_clicks`); harcama, bir reklamın tanıtımları toplandıktan sonra mikro birimden küçük birime en yakın değere yuvarlanır. X bir günü reklam hesabının kendi saat diliminde okur, istenen günler ise UTC günleridir: aralığın başından bir gün öncesi ve sonundan bir gün sonrası da okunur (o günde bir şey olduysa bildirilir), böylece UTC'nin doğusundaki bir hesapta günün ilk saatlerinin harcaması bir gün geç okunmaz. X ileri tarihli günü kabul etmezse aynı aralık onsuz okunur. Silinmiş satır öğelerinin harcaması da okunur |
| B97 | B67'nin uygulanışı. X'in kuralları `hard_budget_cap: false` ve `watch_minutes: 15` taşır; panel bunu X hesabı seçilirken ve X kampanyasının sayfasında, ajanın araç açıklaması da kendi metninde söyler. Jeeta'nın durdurması X'te bütçenin tek sınırıdır: kampanyanın anahtarı satır öğelerini de birlikte taşır (durdururken önce kampanya, sonra her satır öğesi kapatılır; biri yanıt vermese de diğeri denenir ve ikisi de kapanmadan durdurma tamamlanmış sayılmaz; sürdürürken önce satır öğeleri, en son kampanya açılır). İki okuma arasında (en çok on beş dakika) bütçeden fazlası harcanabilir; X'in bildirdiği harcamanın tamamı genel reklam bütçesine yazılır. Hiçbir X çağrısı gerçek platformda çalıştırılmadı (B38) |

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
| A6 | TikTok, 2027 başından sonra trafik amaçlı elle kurulan kampanyayı API'den kabul edecek mi? Belgesi "After December 31, 2026, you will no longer have the ability to create Manual Campaigns using the /campaign/create/ endpoint" diyor ve yerine gelen Smart+ kampanyaları trafik amacını desteklemiyor (yalnızca uygulama, web dönüşümü ve form). Yanıt olumsuzsa TikTok adımı web dönüşümü amacıyla (piksel gerektirir) yeniden tasarlanır | Sahibi, TikTok'a sorar |
| A7 | X reklam API'si OAuth 2.0 belirtecini gerçekten kabul ediyor mu? | İlk gerçek çağrıda görülür |
| A8 | LinkedIn'in yapay zekâ politikası reklam oluşturmayı bağlıyor mu (B75)? | Sahibi, başvuruda |
| A9 | TikTok'ta reklam hesabına bağlı TikTok hesabını, yetkilendirmeyi yapan kullanıcıdan başka biri bağladıysa belirteç onu görüyor mu? | İlk gerçek çağrıda görülür |
| A10 | X'in tek seferlik görsel yüklemesi (`/2/media/upload`) kartın istediği `media_key` değerini yanıtında veriyor mu, ve reklam hesabının kendi kullanıcısı adına yazılan gönderi o görseli kullanabiliyor mu (eski API'de bunun için `additional_owners` vardı)? | İlk gerçek çağrıda görülür |
| A11 | X, onaylanmış (`ACCEPTED`) dışındaki hesap ve tanıtım durumlarını hangi sözcüklerle bildiriyor? Bağlayıcı yalnızca belgede geçenleri tanır; tanımadığını olduğu gibi gösterir | İlk gerçek çağrıda görülür |
| A12 | X satır öğesini bağlantı tıklaması başına mı, gösterim başına mı ücretlendiriyor? Bağlayıcı `pay_by` göndermez (X onu amaca göre kendisi belirler); belge varsayılan olarak ikisini de söylüyor | İlk gerçek çağrıda görülür |
| A13 | Satır öğesi ve kampanya düz `PUT …?entity_status=ACTIVE` ile açılıyor mu (başvuru belgesi öyle diyor; X'in kendi MCP sunucusunun sayfası ayrı "activate" yollarından söz ediyor), ve X aynı metni taşıyan iki gönderiyi kabul ediyor mu (`DUPLICATE_TWEET`)? | İlk gerçek çağrıda görülür |

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
  `ads.tiktok.com/help/article/budget` yardım sayfasından ("About Budget", Temmuz 2026
  güncellemesi), 2026-11-12'de doğrudan okundu.
- **X:** `github.com/xdevplatform/docs` (commit `fe4cdaf4`): `x-ads-api/campaign-management.mdx`,
  `x-ads-api/campaign-management/reference.mdx`, `x-ads-api/creatives/reference.mdx`,
  `x-ads-api/analytics.mdx`, `x-ads-api/fundamentals/`,
  `fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.mdx`,
  `developer-terms/ads-api-agreement.mdx`.
