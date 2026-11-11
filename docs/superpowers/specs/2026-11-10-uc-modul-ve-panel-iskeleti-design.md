# Büyüme stüdyosunun üç modüle ayrılması ve panelin yeni iskeleti — tasarım

Tarih: 2026-11-10 · Durum: sahip onayını bekliyor · Kapsam: Rust yığını (`rust/`), panel (`rust/panel`)

Bu belge, sahiple 2026-11-10'da yapılan tasarım görüşmesinin yazılı halidir. Bir çatı tasarımdır:
panelin iskeletini, ortak zemini ve üç yeni modülün ne yaptığını, ekranlarını ve kurallarını
tanımlar. Yapım dört adıma bölünür (§12); her adımın kendi uygulama planı ayrıca yazılır.

Kararların sahibi her yerde işaretlidir: **S** sahibin kararı, **B** bu belgeyi yazanın kararı
(sahip görmüş olabilir ama kendisi istemedi; değiştirilebilir). Tam liste §13'te.

---

## 1. Neden

Büyüme stüdyosu bugün tek modülün içinde üç ayrı işi (içerik üretme, sosyal medyada paylaşma,
reklam) ve hepsine hizmet eden ortak parçaları (strateji çubuğu, öğrenilenler, günlük, acil fren)
bir arada tutuyor. Sonuç:

- Üç kat sekme ve çakışan adlar ("Materyaller" iki yerde, "Plan" iki yerde, "Yayınlar" ile
  "Paylaşımlar" yan yana, "Büyüme stüdyosu"nun ilk sekmesi "Stüdyo").
- 70 işlem ve 55 panel ucu tek bir `studio.*` adının ve tek bir izin çiftinin altında.
- Reklam tarafının kendi ekranı yok; Stüdyo sekmesinin içinde kapalı bölümlerde duruyor ve reklam
  oluşturamıyor.
- Ekran insanı sürecin içine çekiyor: ara onaylar, formlar, açıklamasız "Ajan bekleniyor" rozeti.

Sahibin isteği: üç iş, birbirinden bağımsız kurulabilen üç derin modül olsun; işi ajanlar yapsın;
insan mümkün olduğunca uzak dursun.

## 2. İlkeler

| # | İlke | Kimin |
|---|---|---|
| P1 | İşi yalnızca ajanlar yapar. Jeeta hiçbir yapay zekâ, medya üretimi ya da trend servisini çağırmaz; ajanın kararını kesin kurallarla uygular. | S (mevcut yön) |
| P2 | Sistem insana bağlı ilerlemez. İnsan isterse hedef verir; vermese de hatlar çalışır. | S |
| P3 | İnsana kalan işler dört tanedir: hedef vermek (isteğe bağlı), bütçeyi belirlemek ve durdurmak, sistemin kendi açtığı reklam kampanyasını onaylamak, gerçek çekimi yükleyip paylaşım iznini vermek. | S |
| P4 | Para sınırı kesindir ve reklamda güvence odur. Sınırı aşacak hiçbir yazma platforma gitmez. | S |
| P5 | Her modül tek başına kurulabilir ve başka bir modül kurulu olmadan çalışır. | S |
| P6 | İnsana düşen her şey yalnızca ana sayfadaki "işler ve onaylar"da görünür. | S |
| P7 | Onayın kalktığı yerde güvence otomatik denetimlerdir (§5.4). | B |

## 3. Hedefler, hedef olmayanlar, kaçınılacaklar

**Hedefler**

- Panelin yan menüsü: ana sayfa, zorunlu alanlar, isteğe bağlı modüller (§4).
- "Büyüme stüdyosu"nun yerine dört modül: İçerik oluşturma, Sosyal medya yönetimi, Reklam
  yönetimi ve bunların ortak deposu Materyal kütüphanesi.
- Reklam modülünün reklam kampanyası oluşturabilmesi (ilk platform Meta).
- Harcamanın ve durdurmanın tek yeri olarak Bütçe.
- Her modülde, insanın bakınca ne olduğunu anladığı tek bir ana ekran.

**Hedef olmayanlar (bu çalışmada yapılmaz)**

- Sosyal medya modülünde mesajlar ve yorumlar (Gelen kutusu modülünde kalır).
- Trend takibi (ileride ayrı bir modül ya da ek).
- Panelde elle kullanılan kurgu masası ya da metin editörü (B4).
- Jeeta'nın ajan çalıştırması ya da uyandırması; ajan dışarıda çalışır ve yoklamayla iş alır.
- Kendi kendine sürekli çalışan bir ajan işçisi yazmak (S26).
- Kişiler, Aday havuzu, Kampanyalar (izinli erişim), Aramalar modüllerinde değişiklik.
- Eski sistem (v1, `backend/`, `frontend/`); yalnızca reklam başlatma kodu referans olarak okunur.

**Kaçınılacaklar (çalışsa bile başarısızlık sayılır)**

- Herhangi bir para sınırını aşan harcama.
- Sistemin kendi açtığı bir kampanyanın onay almadan para harcaması.
- Paylaşım izni olmayan gerçek materyalin bir paylaşımda ya da reklamda kullanılması.
- Bir modülün, başka bir modül kurulu olmadığı için açılmaması ya da hata vermesi.
- İnsandan ara onay, ara form ya da adım adım ilerletme isteyen ekranlar.
- Nedenini ve ne yapılacağını söylemeyen bekleme durumları.
- Bağlı ajanların bugün kullandığı araçların sessizce bozulması.

---

## 4. Panelin iskeleti

### 4.1 Yan menü

| Katman | Yeni | Bugün |
|---|---|---|
| Ana sayfa | Ajan merkezi: ajanlar, işler ve onaylar, ajanda | Var (2026-11-10 çalışması) |
| Zorunlu | Strateji | Var, zorunlu |
| Zorunlu | Bütçe | Var, "Yönetim" altında |
| Zorunlu | Kullanıcılar | "Ekip" ve "Roller" iki ayrı sayfa; tek sayfada birleşir |
| Zorunlu | API anahtarları | Var |
| Zorunlu | Yetenekler ve bağlantılar | Var |
| Zorunlu | Ajanlar | Var (B2) |
| Modül | İçerik oluşturma | Büyüme stüdyosu → Üretim alanları |
| Modül | Sosyal medya yönetimi | Büyüme stüdyosu → Paylaşımlar, Stüdyo/Bugün, Stüdyo/Plan |
| Modül | Reklam yönetimi | Büyüme stüdyosu içinde kapalı bölümler |
| Modül | Materyal kütüphanesi | Büyüme stüdyosu → Materyaller |
| Modül | Gelen kutusu | Bugün zorunlu; isteğe bağlı olur (S) |
| Modül | Kişiler, Aday havuzu, Kampanyalar, Aramalar | Değişmez |
| Kalkar | İş takibi (`/activity`) | Yönetim altında |
| Kalkar | Günlük (`/ledger`) ve Stüdyo/Günlük | Yönetim altında ve Stüdyo sekmesinde |
| Kalkar | Büyüme stüdyosu (`/studio`) | Dört modüle dağılır |

"Zorunlu" burada "her hesapta vardır, kaldırılamaz" demektir. Modül kaydında (`workspace_modules`)
zorunlu tek yerleşik modül Strateji olur; Bütçe, Kullanıcılar, API anahtarları, Yetenekler ve
bağlantılar ile Ajanlar bugün olduğu gibi modül kaydının dışında, sabit sayfalardır.

Kalkan sayfaların eski adresleri ana sayfaya ya da yeni yerine yönlenir; eski bağlantı boş sayfa
göstermez.

### 4.2 Ana sayfa: işler ve onaylar

- İş takibi sayfası kalktığı için ana sayfadaki akış bekleyen işlerin **tamamını** gösterir
  (bugün "Tümü" görünümünde ilk dördünü gösterip gerisi için İş takibi'ne gönderiyor).
- Bu çalışmanın akışa eklediği iş türleri:

| İş | Ne zaman | İnsanın yaptığı |
|---|---|---|
| Reklam kampanyası önerisi | Sistem kendi kampanyasını açmak istediğinde (§9.3) | Onaylar ya da reddeder |
| Gerçek çekim talebi | Ajan üretemeyeceği bir materyale ihtiyaç duyduğunda (bugün de var) | Yükler, paylaşım iznini verir |
| TikTok paylaşımını tamamla | TikTok'a gidecek her paylaşımda (§7.4; platform kuralı) | TikTok ekranındaki seçimleri yapar |
| Ajanın çözemediği sorun | Reddedilen reklam, tekrar tekrar tutulan içerik, kopan bağlantı | Sorunu görür, ilgili sayfaya gider |

- Akıştaki "Günlük" sekmesi (son işlemlerin kaydı) **kalır** (S27). Onaylar kalktığı için
  ajanların ne yaptığının sonradan görülebildiği tek yer burasıdır. Kalkan, Yönetim → Günlük
  sayfası ve Stüdyo/Günlük sekmesidir; akıştaki "tüm günlük" bağlantısı da onunla kalkar.

### 4.3 Kullanıcılar

Ekip üyeleri ve roller tek sayfada: üstte üyeler ve davetler, altında roller ve izinleri. İşlevler
aynen kalır; yalnızca iki sayfa birleşir.

### 4.4 Modül kaydı

Yerleşik modül listesi (`jt_app::usecases::modules::catalog`):

| Kimlik (öneri) | Ad | Gereksinim | Not |
|---|---|---|---|
| `strategy` | Strateji | yok | Zorunlu kalan tek modül |
| `inbox` | Gelen kutusu | `messaging` | Zorunlu olmaktan çıkar |
| `content` | İçerik oluşturma | yok | Yeni |
| `social` | Sosyal medya yönetimi | `social_account` | Yeni |
| `ads` | Reklam yönetimi | `ads` | Yeni |
| `materials` | Materyal kütüphanesi | yok | Yeni; B3 |
| `people`, `prospects`, `outreach`, `calls` | değişmez | değişmez | |
| ~~`growth-studio`~~ | kalkar | | |

- **B3 — Kütüphane bağımlılığı.** `content`, `social` ya da `ads` kurulunca `materials` da kurulur;
  bu üçünden biri kuruluyken `materials` kaldırılamaz. `materials` tek başına da kurulabilir.
- **B28 — Mevcut çalışma alanları.** `growth-studio` kurulu olan her çalışma alanında dört yeni
  modül kurulu gelir; ayarları (ajan ataması, bağlantılar, açıklama) dördüne de kopyalanır.
- **S25 — Modül kaldırılınca işleri durur, verisi kalır.** Bugün kaldırmak modülü yalnızca
  menüden gizliyor ve süren işler devam ediyor. Yeni kural: kaldırılan modülün otomatik işleri
  durur. Yeni iş başlamaz, tetikleyiciler çalışmaz, planlı paylaşımlar bekletilir, reklam
  kampanyaları platformda duraklatılır; kaldırılmış modülün işlemleri HTTP ve MCP'de reddedilir.
  Hiçbir veri silinmez; modül yeniden kurulunca işler kaldığı yerden devam eder. Yasal
  yükümlülükler (kişi silme, onay ve ret kayıtları) modül kurulu olmasa da çalışır.
- Bu kural bu çalışmada dört yeni modüle uygulanır. Gelen kutusu, Kampanyalar ve Aramalar için
  aynı kuralın uygulanması ayrı bir iştir (§15, A6).
- Modül kilidi (`2026-11-10-module-capability-gating-design.md`) aynen geçerlidir: gereksinimi
  karşılanmayan modül menüde kilitli durur, HTTP ve MCP işlemleri `CAPABILITY_REQUIRED` döner.
- Kapı eşlemesi bugün işlem adının önekine bakıyor (`studio.*` → `growth-studio`,
  `jt_app/src/gate.rs`). Yeni yapıda her işlem tam olarak bir modüle ya da ortak zemine ait olur
  (Ek A) ve eşleme işlem bazında yapılır.
- Gelen kutusu isteğe bağlı olduğu için, onun işlemlerini kullanan başka modüller onsuz da
  çalışmalıdır: Kişiler modülü kişi kayıtları için `inbox.*` işlemlerini kullanıyor; bu işlemler
  Gelen kutusu kurulu ya da kilitli olmasa da Kişiler için açık kalır.
- **B19 — İzinler.** Bugünkü tek çift (`studio.work`, `studio.manage`) modül başına ayrılır. Amaç:
  İçerik oluşturma'ya atanmış bir ajan anahtarı paylaşım yapamasın, para harcayamasın. Mevcut
  rollere ve anahtarlara yeni izinler, bugünkü yetkilerini daraltmayacak şekilde geri doldurulur.

### 4.5 Strateji

- Stüdyo'daki **Öğrenilenler** (hipotez güveni, kanıtlar, değerlendirme kaydı) Strateji sayfasına
  taşınır (S: öğrenilenler hipotezi ve stratejiyi günceller).
- Modüller Strateji'ye yalnızca ölçüm gönderir; öğrenme hesabı değişmez.
- Stüdyo'daki strateji çubuğu kalkar; hipotez önerme Strateji sayfasında zaten vardır.
- **B21 — Trend sinyali.** Elle trend notu ekranı taşınmaz ve kalkar; kayıt aracı ve verisi olduğu
  gibi kalır, ileride trend işine devredilir.

---

## 5. Ortak zemin

### 5.1 Materyal kütüphanesi

Üç modülün okuyup yazdığı ortak depo. Bugünkü Materyaller sekmesinin işi buraya taşınır:

- **Ekranlar:** Yükle, Kütüphane, Olaylar, Çekim listesi; materyal sayfası (içerik bilgileri,
  etiketler ve kişiler, izin ve yerleşim, kullanım geçmişi). Davranış değişmez.
- **Biten içerikler:** İçerik oluşturma'nın bitirdiği paketler (§6.1) kütüphanede ayrı bir
  görünümde durur; Sosyal medya yönetimi ve Reklam yönetimi buradan alır.
- **Paylaşım izni kuralı değişmez:** gerçek çekimde izni bir kişi (sahip ya da yönetici) verir;
  ajanın ürettiği ve içinde kişi olmayan görselde izni ajan verebilir. Bu, P3'teki tek zorunlu
  insan işidir ve kişisel veri gereğidir.
- Kişisel veri kuralları (silme, 24 ay saklama, kimliksiz kayıt) aynen kalır.
- **B39 — Ajanın ürettiği görsel tek başına içerik olabilir (yapım sırasında bulunan çelişki).**
  3 Kasım tarihli materyal tasarımına göre (D10) ajanın ürettiği, bir olaya bağlı olmayan görsel
  yalnızca "destek"ti: her içerikte en az bir gerçek çekim bulunmak zorundaydı. Bu kural S14
  ("ilk adım görsel") ve S22 ("sistem insana bağlı ilerlemez") ile çelişiyordu; gerçek çekimi
  olmayan bir üretim alanı hiç bitemiyordu. Yeni kural: içinde kişi, ad ya da logo olmayan,
  ajanın ürettiği görsel, **belirli bir şeyden söz etmeyen** içeriğin tek görseli olabilir.
  Belirli bir olaydan söz eden içerikte eskisi gibi yalnızca destektir; metinde kayıtlı bir
  olayın adı, yeri ya da müşterisi geçerse içerik tutulur. Kişi gösteren görselde izni yine bir
  insan verir. Kural çalışma alanı ayarıdır (İçerik oluşturma → Ayarlar → Materyal kuralları:
  "Ajanın ürettiği görsel tek başına paylaşılabilsin"), varsayılan **açıktır**; kapatılınca eski
  kural aynen geçerlidir. Sunucu görsele bakmaz: ajanın "ben ürettim" dediği bir görselin gerçek
  bir ürünü ya da yeri yanlış gösterip göstermediğini denetleyemez; bu, ayarı açık tutan
  işletmenin kabul ettiği risktir ve sahibin gözden geçirmesi gereken ilk karardır.
- **B20 — Özel gün takvimi** (bugün Materyaller → Takvim) İçerik oluşturma'nın ayarlarına taşınır,
  çünkü işi üretim alanı açtırmaktır (§6.3).

### 5.2 Strateji bağı

- Her üretim alanı, planlı paylaşım ve reklam kampanyası bir strateji hipotezine bağlıdır (mevcut
  zincir kuralı). Hipotezi ajan seçer; ekranda hipotez, kol, şerit gibi iç terimler görünmez.
- Onaylı strateji olmadan paylaşım ve harcama yapılmaz (mevcut strateji kapısı). Üretim alanı ve
  kampanya açmak, hazırlık yapmak strateji onayı beklemez; yürütme bekler ve bunu satırda söyler.

### 5.3 Ajan bağlantısı

- Ajan çalışma alanına bir API anahtarıyla bağlanır, düzenli yoklamayla (`jeeta.work.checkin`)
  bekleyen işleri alır, kendi araçlarıyla yapar ve sonucu MCP araçlarıyla teslim eder. Jeeta ajanı
  çalıştırmaz, uyandırmaz.
- Modüle ajan atama, modül ayarındaki `agent_ids` ile yapılır (bugün var). Her modülün yerleşik
  tanımındaki `workflow` ve çalışma alanının yazdığı `brief`, ajanın o modüldeki talimatıdır.
  İçerik oluşturma'nın 14 adımı (§6.2) bu `workflow` alanında durur.
- **S26 — Bu çalışmanın ajan tarafındaki kapsamı.** Teslim edilen, Jeeta tarafı ve ajanın
  izleyeceği iş tarifidir (modülün `workflow` metni ve iş ipuçları). Her adımın kanıtı, sahibin
  MCP ile bağladığı gerçek bir Claude ya da Codex oturumunun işi baştan sona bitirmesidir;
  otomatik testlerde betikli bir ajan vekili kullanılır. Kendi kendine sürekli çalışan bir ajan
  işçisi bu çalışmanın dışındadır ve kendi güvenlik sınırıyla ayrı bir iş olarak ele alınır
  (§15, A7). O iş yapılana kadar "insansız" çalışma, sahibin bağladığı ajanın düzenli yoklama
  yapmasına bağlıdır.
- **B34 — Atama uygulanır.** Bugün `agent_ids` saklanıyor ama sunucu okumuyor; yoklama, izni olan
  her anahtara tüm işleri veriyor. Yeni kural: bir modüle ajan atanmışsa o modülün işleri
  yoklamada yalnızca atanan ajanlara verilir. Hiç ajan atanmamışsa, modülün iznini taşıyan her
  ajan anahtarına verilir; böylece bugünkü tek ajanlı kurulumlar bölmeden sonra da çalışır.
- **B30 — Ajan durumu satırı.** Üç modülün ana ekranının en üstünde tek satır durum vardır ve
  açıklamasız rozetin yerini alır:

| Durum | Satır | Eylem |
|---|---|---|
| Modülde çalışabilecek bağlı ajan yok | "Bu modülde çalışabilecek bağlı bir ajan yok; işler bekliyor." | Ajanlar sayfasına ya da modül ayarına git |
| Ajan yoklamayı kaçırdı | "Ajan en son {zaman} yoklama yaptı; {n} iş bekliyor." | Ajanlar sayfasına git |
| Strateji onaylı değil | "Onaylı strateji yok; hazırlık yapılır, paylaşım ve harcama bekler." | Strateji'ye git |
| Strateji ücretli kanalı içermiyor (yalnızca Reklam yönetimi) | "Strateji reklam harcamasına izin vermiyor; kampanyalar bekler." | Strateji'ye git |
| Reklam bütçesi belirlenmemiş (yalnızca Reklam yönetimi) | "Bütçe'de reklam bütçesi yok; kampanyalar bekler." | Bütçe'ye git |
| Her şey yolunda | Satır görünmez | |

### 5.4 Onayın yerini alan otomatik denetimler

| Denetim | Nerede uygulanır | Bugün |
|---|---|---|
| Materyal izni kapısı: paylaşım izni olmayan ya da uygun olmayan materyal kullanılamaz | Paylaşım ve reklam | Paylaşımda var; reklama taşınır (B10) |
| Doğruluk kontrolü: metindeki yer, tarih, kişi materyalle çelişiyorsa tutulur | Paylaşım ve reklam | Paylaşımda var; reklama taşınır (B10) |
| Paylaşım sınırları: günlük sınır, aralık, sessiz saatler | Paylaşım | Var |
| Bütçe kapısı: her platform yazımından önce tüm sınırlar denetlenir | Reklam ve ücretli her bağlantı | Var |

- **B9 — Doğruluk bulgusu önce ajana döner.** Bugün bulguyu bir insan tek sürüm için serbest
  bırakıyor. Yeni düzende bulgu, nedeniyle birlikte ajanın işine döner; ajan metni ya da materyali
  düzeltip yeniden teslim eder. Aynı içerik üç kez tutulursa ana sayfaya "ajanın çözemediği sorun"
  olarak düşer; insanın serbest bırakma yetkisi orada durur: tutulan teslimin nedenlerini görür ve
  yalnızca metin denetimine takılanı olduğu gibi kabul edebilir (B45).

---

## 6. İçerik oluşturma modülü

### 6.1 Kavramlar

- **Üretim alanı.** Tek bir içerik işi. Bugünkü üretim alanının (`studio_production_projects`)
  genişlemiş hali. Alanları:

| Alan | Zorunlu | Not |
|---|---|---|
| Hedef | Evet | Tek cümle yeter (S) |
| Başlama saati | Evet | Ajan o saatte işe başlar (S). Varsayılan "şimdi" (B) |
| Platform, biçim | Hayır | Boşsa ajan stratejiye göre seçer (B5) |
| Açan | — | İnsan ya da sistem; sistemse hangi tetikleyici (§6.3) |

- **İçerik paketi.** Üretim alanının çıktısı: bir ya da birkaç **platform sürümü**. Her sürümde
  biçim (gönderi, kaydırmalı gönderi, Reels, hikâye, TikTok videosu …), görsel ya da video
  dosyaları, açıklama, başlık, etiketler, bağlantı ve denetim sonuçları bulunur.
- **Durumlar:** Sırada · Çalışıyor (hangi adımda) · Çekim bekliyor · Tamamlandı · Sorun var ·
  Arşivde.

### 6.2 Akış

İnsan en çok başta (hedef) ve gerçek çekim gerekirse görünür; ara adımların hiçbiri onay istemez.

| # | Adım | Kim | Ekranda görünen |
|---|---|---|---|
| 1 | Amacı belirle | Ajan, stratejiden | Amaç satırı |
| 2 | Hedef kitleyi tanımla | Ajan, stratejiden | Kitle satırı |
| 3 | Platformu ve biçimi seç | Ajan (insan seçtiyse o) | Sürüm listesi |
| 4 | Konu araştırması | Ajan | Kısa kaynak listesi |
| 5 | Fikir ve yaklaşım | Ajan | Bir cümle |
| 6 | Ana mesaj | Ajan | Bir cümle |
| 7 | Başlık ve açılış | Ajan | Metin |
| 8 | Metin ya da senaryo | Ajan | Metin |
| 9 | Materyali üret ya da topla | Ajan; gerçek çekim gerekiyorsa insan | Kullanılan materyaller, çekim talepleri |
| 10 | Düzenleme ve tasarım | Ajan | Ara çıktı |
| 11 | Platforma uyarla | Ajan | Platform sürümleri |
| 12 | Paylaşım bilgileri | Ajan | Açıklama, başlık, etiket, bağlantı |
| 13 | Son kontrol | Ajan ve Jeeta'nın denetimleri (§5.4) | Kontrol sonuçları |
| 14 | Paketle | Jeeta | Paket kütüphaneye düşer |

- Adım 1 ve 2 stratejide zaten tanımlıdır; ajan içerik bazında daraltır (B5).
- Ajan ilerleyişi (hangi adımda, ara çıktı) teslim eder; ekran bunu gösterir ama bakmak zorunlu
  değildir.
- Ajan kütüphaneden materyal seçebilir, kendi araçlarıyla üretebilir (ilk adımda görsel) ya da
  gerçek çekim talep edebilir. Talep ana sayfaya ve Çekim listesi'ne düşer; üretim alanı "Çekim
  bekliyor" olur ve çekim yüklenip izni verilince kendiliğinden devam eder.

### 6.3 Üretim alanını kim açar

- **İnsan:** hedef ve başlama saatiyle (§6.4b).
- **Sistem (S: sistem insana bağlı ilerlemez).** Bugünkü üç tetikleyici paylaşım isteği yazmak
  yerine üretim alanı açar; hedef cümlesini sistem yazar:

| Tetikleyici | Bugün | Yeni |
|---|---|---|
| Yeni materyal | Bir olaya onaylı, uygun materyal gelince (30 dk bekleme ile tek istek) | Aynı koşulda bir üretim alanı |
| Özel gün | Takvimdeki günün hazırlık penceresi açılınca | Aynı koşulda bir üretim alanı |
| Boş kanal | Bir kanal belirlenen gün sayısı boyunca gönderisiz kalınca | Aynı; yalnızca Sosyal medya yönetimi kuruluysa çalışır (B8) |

- İnsanın ve sistemin açtıkları aynı üretim hattında, aynı sırada durur; satırda kimin açtığı yazar.

### 6.4 Ekranlar

**(a) Üretim hattı — ana ekran (S: tek sıra).**

```
[ajan durumu satırı, gerekiyorsa]
Üretim hattı                                            [+ Üretim alanı aç]
Dün 09:00    Yeni kupa serisi lansmanı     3 platform sürümü hazır      Tamamlandı
Dün 14:00    Atölye turu                   Ajan 3 çekim istedi          Çekim bekliyor
Bugün 10:00  Anneler günü (sistem açtı)    Görsel üretiliyor · 9/14     Çalışıyor
Bugün 16:00  Kış koleksiyonu duyurusu      Saatini bekliyor             Sırada
```

- Tek liste, başlama saatine göre sıralı. Her satır: saat, ad, bir satır durum açıklaması, durum.
- İnsandan bir şey bekleyen satırlar (çekim) renkle ayrılır.
- **B6 — Sıra ve paralellik.** Sıra başlama saatine göredir; saati gelen birden çok iş varsa ve
  modüle atanmış boşta ajan varsa işler aynı anda yürür.

**(b) Üretim alanı açma.** Zorunlu: hedef, başlama saati. İsteğe bağlı: platform, biçim. Başka
alan yok.

**(c) Üretim alanı sayfası (S: önizleme ve platformda görünüm; düzen "tek tek, büyük").**

```
Yeni kupa serisi lansmanı · hedef cümlesi
[Instagram · Gönderi] [Instagram · Reels] [TikTok · Video]      ← platform sürümleri
┌───────────────┐   Bu sürüm: biçim, süre, açıklama metni, kullanılan materyaller
│ telefon       │   Kontroller: geçti / tutuldu (nedeni)
│ çerçevesinde  │   Ajanın notları
│ önizleme      │   [Olmamış]  + "ne değişsin" notu
└───────────────┘
Adımlar ve ara çıktılar (kapalı bölüm) · Çekim talepleri
```

- Seçili sürüm, o platformdaki görünümüne yakın bir çerçevede gösterilir; video oynatılır.
- Onay düğmesi yoktur (S: biten içerik doğrudan paylaşıma gider).
- **B7 — "Olmamış".** İnsan kısa bir notla yeniden yapılmasını ister. Henüz yayınlanmamış
  sürümlerin planlı paylaşımı iptal edilir, ajan notu alıp yeni sürüm üretir; eski sürüm geçmişte
  kalır. Yayınlanmış sürüm geri alınmaz; yeni sürüm yeni bir içerik olarak ilerler.
- **B4 — Elle düzenleme yok.** Bugün Stüdyo/Bugün'deki metin kutusuyla insan içerik teslim
  edebiliyor. Yeni modülde panelden içerik yazma ve kurgu yoktur; düzeltme "Olmamış" ile istenir.

### 6.5 Onay yok

Paket tamamlanınca kütüphaneye düşer. Sosyal medya yönetimi kuruluysa paket planlamaya girer
(§7.2); kurulu değilse kütüphanede kullanılmayı bekler.

### 6.6 Kapsam sırası

| Adım | Kapsam | Ajandan beklenen |
|---|---|---|
| İlk (S) | Görsel içerik: tek görsel, kaydırmalı gönderi, hikâye görseli | Görsel üretme ve düzenleme, metin |
| İkinci | Kısa video: üretim, kurgu, altyazı, ses | Video araçları; uzun süren iş |
| Ufuk | Uzun video, uçtan uca film | — |

- Bugünkü işçi (`rust/scripts/production-worker`) yalnızca görsel analizi ve dikdörtgen kırpma
  yapar, modele araç vermez, işi iki dakikayla sınırlar. İlk adım için ajanın görsel üretebilmesi
  gerekir; bu, ajanın kendi yeteneğidir, Jeeta'nın değil. Jeeta tarafında eksik olan, üretim
  isteğini bir üretim alanı işi olarak ajana vermek ve sonucu paket olarak almaktır.
- Uzun süren işler (video) için bugünkü 30 dakikalık iş kirası ve kalp atışı olmaması yetmez;
  ikinci adımın konusudur.

---

## 7. Sosyal medya yönetimi modülü

Yaptığı iş (S): hazır içerik paketlerini planlamak ve paylaşmak; bağlı hesapların performansını
göstermek. Mesajlar ve trendler bu modülde yoktur.

### 7.1 Ana ekran (S: hesap seç, içine gir)

```
[ajan durumu satırı, gerekiyorsa]
Hesaplar              │ Instagram · @hesap · son 30 gün
● Instagram @hesap    │ takipçi   erişim   etkileşim   paylaşım
  TikTok @hesap       │ [eğilim çizgisi]
  Facebook Sayfa      │ Sıradaki paylaşımlar: saat · içerik · biçim · [Platformda zamanlandı | Jeeta yayınlayacak]
+ Hesap bağla         │ Son paylaşımlar: saat · içerik · sonuç
```

- Solda bağlı sosyal hesaplar; "Hesap bağla" Yetenekler ve bağlantılar'a götürür.
- Sağda seçili hesabın ölçüleri, sıradaki paylaşımları ve son paylaşımları ile sonuçları.
- Ölçüler platformun verdiği kadardır (Ek B.2). Platformun vermediği ölçü "—" gösterilir,
  uydurulmaz. Hesap ölçüleri bugünkü `InsightsReader::account_metrics` ile okunur (Meta, TikTok,
  LinkedIn, X bağlayıcılarında var).
- **B22 — Haftalık özet** ayrı sekme olmaktan çıkar; hesap sayfasındaki dönem seçimiyle görülür.

### 7.2 Planlama

- Modüle atanmış ajan, kütüphanedeki hazır paketlerin platform sürümleri için paylaşım zamanını
  seçer ve planlı paylaşımı yazar. İnsan zaman seçmez.
- Bugünkü kurallar aynen uygulanır: günlük sınır, paylaşımlar arası en az süre, sessiz saatler,
  biçim başına hazırlık ve gecikme payı. Bunların ayar ekranı ("Paylaşım ayarları") bu modülde
  kalır ve ikincil bir sayfadır.
- **B18 — İçerik oluşturma kurulu değilse** ajan kütüphaneden paylaşım izni olan materyali seçer,
  açıklamayı kendisi yazar ve tek sürümlük basit bir paket oluşturur. Denetimler aynıdır.

### 7.3 Yayın (S: onay yok; platformun zamanlayıcısı varsa oraya)

- Planlı paylaşım onay beklemeden yayınlanır. Stüdyo'nun şerit bazlı "insan onayı ister" ayarı ve
  Stüdyo/Bugün onay kuyruğu kalkar.
- **B35 — Bağlantının kendi onay ayarı korunur.** Her bağlantının Yetenekler ve bağlantılar'da
  duran "her eylem insan onayı bekler" ayarı vardır (`jt_capability::Policy`; varsayılan kapalı;
  Gelen kutusu ve Kampanyalar'la ortak). Bu ayar bu çalışmanın kapsamı dışındadır ve geçerliliğini
  korur: bir hesapta açıksa o hesaba gidecek paylaşım ve o reklam hesabındaki yazımlar ana sayfada
  onay bekler. Kullanıcının bilerek açtığı bir güvence sessizce kapatılmaz.
- Geçiş kuralı: şerit ayarı açık olan çalışma alanlarında bu tercih, ilgili bağlantıların kendi
  ayarına taşınır. O sırada onay bekleyen içerikler aynı kuralla beklemeye devam eder; hiçbir
  içerik geçiş yüzünden onaysız yayınlanmaz.
- Platformun, üçüncü taraf uygulamalara açık kendi zamanlayıcısı varsa paylaşım oraya kurulur ve
  satırda "Platformda zamanlandı" yazar; yoksa Jeeta'nın zamanlayıcısı (`studio_publish` işi) o
  saatte yayınlar ve satırda "Jeeta yayınlayacak" yazar. Platform bazında durum Ek B.1'dedir.
  Uygulamada bu bir çalışma alanı ayarıdır ve kapalı gelir (B47).
- Platformda zamanlanmış bir paylaşım için denetimler (izin, doğruluk, sınırlar) zamanlama anında
  uygulanır. Sonradan koşul bozulursa (izin geri alındı, içerik "olmamış" dendi) Jeeta platformdaki
  zamanlanmış paylaşımı iptal eder; iptal edemiyorsa bunu ana sayfaya sorun olarak düşürür.

### 7.4 TikTok istisnası (platform kuralı)

TikTok, içeriğin hesaba gönderilmesinden önce hesap sahibinin kendi ekranında seçim yapmasını
(görünürlük, yorum ve düet izinleri, ticari içerik beyanı) şart koşuyor; mevcut kod bunu zorunlu
tutuyor (`jt_studio::requires_posting_screen`). Bu yüzden TikTok'a gidecek her paylaşım ana
sayfaya "TikTok paylaşımını tamamla" işi olarak düşer ve insan o ekranı doldurmadan gönderilmez.
P2'nin platform kaynaklı tek istisnasıdır.

### 7.5 Ölçüm

Yayın sonrası ölçüm (24 saat, 72 saat, 7 gün) bu modülde kalır; sonuçlar hesap sayfasındaki "Son
paylaşımlar"da görünür ve Strateji'ye gider (B17).

### 7.6 Paylaşımı duraklatma

**B23.** Bugünkü fren organik paylaşımı da durdurabiliyor. Fren Bütçe'ye taşındığı (§8) ve
organik paylaşım para harcamadığı için, "paylaşımı duraklat" Paylaşım ayarları'nda hesap bazında
bir anahtar olarak durur; baskın bir düğme değildir.

---

## 8. Bütçe ve durdurma

Bütçe geneldir (S): her modül bütçeye etki eder ve harcaması bütçe ekranında görünür.

### 8.1 İki katmanlı reklam bütçesi (S)

- **Genel reklam bütçesi:** Bütçe sayfasındaki "Reklam bütçesi" kalemi (`BudgetKind::AdBudget`),
  dönemliktir. Meta, TikTok, LinkedIn, X ve ileride eklenecek her platformun reklam harcaması bu
  kalemden düşer.
- **Kampanya bütçesi:** her reklam kampanyasının kendi toplam sınırı.
- **B37 — Genel reklam bütçesinin tanımı.** Çalışma alanı başına tek kalemdir ve bağlı tüm reklam
  hesaplarına kendiliğinden bağlanır. Bu kalem yoksa Reklam yönetimi kampanya başlatmaz ve bütçenin
  belirlenmesini ister. Bugün hesap bazında açılmış reklam bütçesi kalemleri ek sınır olarak kalır
  ve denetlenmeye devam eder.
- Stratejinin bütçe çerçevesindeki ücretli tavan üst sınırdır: genel reklam bütçesi ondan büyük
  girilemez. Strateji ücretli kanalı içermiyorsa reklam harcaması yapılamaz (mevcut kural).
- Ekranda gösterilen "kalan", bağlayıcı olan en düşük sınırın kalanıdır ve hangi sınır olduğu
  yazılır.

### 8.2 Kural (P4)

- Platforma giden her bütçe yazımından önce harcama rezerve edilir ve şu sınırların **hepsi**
  denetlenir: kampanya bütçesi, genel reklam bütçesinin dönemde kalanı, stratejinin bütçe
  çerçevesindeki ücretli tavan ve bağlantıya bağlı diğer kalemler. Biri aşılacaksa yazım yapılmaz
  (bugünkü `reserve_connector_spend`; `BUDGET_CAP`).
- Kampanya açılırken kampanya bütçesi genel bütçede kalandan büyük olamaz.
- **B31.** Genel bütçe dönem içinde biterse tüm platformlardaki kampanyalar duraklatılır; yeni
  dönemde, kampanya bütçesi bitmemişse kendiliğinden devam eder.
- **B32 — Kampanya bütçesi platforma toplam bütçe olarak yazılır.** Platformlar günlük bütçeyi
  aşabiliyor (Meta'da belgelere göre günde %25 ile %75 arası), toplam bütçeyi ise aşmıyor
  (Ek B.3). Bu yüzden Jeeta bir kampanyayı yalnızca günlük bütçeyle kurmaz; kampanya bütçesini
  platformun kesin saydığı toplam bütçe özelliğiyle yazar. Jeeta'nın rezervasyonu ikinci kattır.
- Rezervasyon en kötü durumu varsayar: bir kampanyanın dönem içinde harcayabileceği en yüksek
  tutar (toplam bütçesinden kalan) genel reklam bütçesinden ayrılır.
- Gerçek harcama her gün platformdan okunur (bugün var) ve Bütçe ekranındaki "harcanan" odur.
- Kampanya bütçesi ve süresi platformun en düşük bütçe kurallarını karşılamalıdır; karşılamıyorsa
  kampanya açılmaz ve gereken en düşük tutar söylenir.
- **B24 — Para birimi.** Reklam hesabının para birimi genel reklam bütçesinin para birimiyle aynı
  olmalıdır; değilse o hesapta kampanya açılamaz ve nedeni söylenir. Kur çevrimi yapılmaz (bugünkü
  kod da para birimi eşleşmesi arıyor).

### 8.3 Bütçe ekranı

Bugünkü kalem tablosu (ad, tür, üst sınır, dönem, harcanan, kalan) kalır. Eklenenler:

- **Nereye harcandı:** her kalemin altında modül ve reklam kampanyası kırılımı.
- **B36 — Kırılımın ve durdurmanın kapsamı.** Kırılım, harcama yapan her modülü kapsar: Reklam
  yönetimi, Gelen kutusu, Kampanyalar, Aramalar. Bunun için harcama kaydına modül bilgisi eklenir;
  bu modüllerin davranışı ve ekranları değişmez. İçerik oluşturma ve Sosyal medya yönetimi
  Jeeta'nın içinde para harcamaz. Durdurma yalnızca harcamayı durdurur; para harcamayan işler
  sürer.
- **Durdurma (S: fren bütçede):** üç düzey — tüm harcamayı durdur, bir modülün harcamasını durdur,
  tek bir reklam kampanyasını durdur. Durdurma yeni yazımı engeller ve platformdaki kampanyaları
  duraklatır (bugünkü fren ve durum uzlaştırması). Platform duraklatmayı doğrulamadıysa ekran
  "duraklatma bekliyor" der; durmuş gibi göstermez.
- Bugünkü Stüdyo'daki "Acil fren" düğmesi kalkar.

---

## 9. Reklam yönetimi modülü

### 9.1 Kavramlar

- **Reklam kampanyası (Jeeta'daki birim).** Tek hedef ve tek bütçe; platforma bağlı değildir
  (B15). Alanları:

| Alan | Zorunlu | Not |
|---|---|---|
| Hedef | Evet | Tek cümle |
| Kampanya bütçesi | Evet | Toplam sınır (S) |
| Başlama saati | Evet | |
| Platform | Hayır | Boşsa ajan seçer |
| Bitiş tarihi | Hayır | Boşsa süreyi ajan kampanya planında belirler; platformun toplam bütçe özelliği bir bitiş tarihi ister (B14) |

- **Platform tarafı.** Her platformda yapı aynıdır: kampanya (amaç) → reklam seti (kitle, yerleşim,
  bütçe, süre) → reklam (görsel ya da video, metin, buton, hedef adres). Bunları Jeeta kurar.
- **Durumlar:** Onay bekliyor (yalnızca sistem açtıysa) · Hazırlanıyor · İncelemede (platform) ·
  Yayında · Durduruldu · Reddedildi (ajan düzeltiyor) · Bitti.
- **B27 — Ad.** "Kampanyalar" adında bir modül zaten var (izinli erişim). Karışmaması için bu
  modülün birimi ekranda her yerde "reklam kampanyası" diye geçer.

### 9.2 Akış

| # | Adım | Kim |
|---|---|---|
| 1 | Hedef, kampanya bütçesi, başlama saati | İnsan — ya da sistem önerir ve insan onaylar (§9.3) |
| 2 | Amaç, platform ve reklam türü | Ajan, stratejiden |
| 3 | Görsel ve metin; birkaç çeşit | Ajan; kütüphanedeki paket ya da materyal + kendi metni |
| 4 | Kitle, yerleşim, neyin "sonuç" sayılacağı, tıklamanın gideceği yer | Ajan |
| 5 | Denetim ve kurulum | Jeeta: izin, doğruluk, bütçe kapısı; sonra platformda kurar |
| 6 | İnceleme | Platform |
| 7 | İzleme ve iyileştirme | Ajan; sınırın içinde kaldıkça sormaz |
| 8 | Sonuçlar | Jeeta: harcama Bütçe'ye, sonuç Strateji'ye, form kişileri Gelen kutusu'na |

- **B11 — Kurulumu Jeeta yapar.** Ajan 2–4. adımların sonucunu tek bir yapılandırılmış **kampanya
  planı** olarak teslim eder; Jeeta planı doğrular ve kendi reklam bağlayıcısıyla platformda
  kurar. Ajan reklam panelinde elle kampanya kurmaz. Gerekçe: para sınırı ancak bütçeyi Jeeta
  yazarsa garanti edilir (P4).
- Kampanya platformda önce duraklatılmış olarak kurulur; denetimler ve rezervasyon geçince
  etkinleştirilir.
- Bu, önceki tasarımdaki K12 kararını ("sistem kampanya, reklam seti ya da kreatif yaratmaz")
  kaldırır. K12 sahibin değil, o tasarımı yazanın kararıydı; gerekçesi platform izni ve iş
  yüküydü. `no_paid_creation_api` mimari testi buna göre değişir.
- **B33 — Özel reklam kategorileri.** Platform, iş ilanı, konut, kredi, finansal ürün, siyaset ve
  kumar reklamlarında kategori beyanı ve kısıtlı hedefleme ister. İlk sürümde Jeeta yalnızca
  kategori gerektirmeyen kampanyaları kurar; ajan planında böyle bir kategori beyan ederse kampanya
  kurulmaz ve ana sayfaya sorun olarak düşer.

### 9.3 Onay kuralı

| Kim açtı | Onay | Güvence |
|---|---|---|
| İnsan | Yok; kampanya kendiliğinden başlar (S) | Kampanya bütçesi ve genel reklam bütçesi |
| Sistem | Var; onaylanmadan tek kuruş harcanmaz (S) | Onay ve aynı iki sınır |

- Sistem önerisi ana sayfaya düşer. Öneride hedef, önerilen kampanya bütçesi, platform, reklamın
  önizlemesi, kime gösterileceği ve tıklamanın nereye gideceği yazar.
- **B16.** Onaylanmayan öneri 7 gün sonra kendiliğinden kapanır.
- Sistem ne zaman önerir: modüle atanmış ajan, strateji ve geçmiş sonuçlara bakarak öneri yazar.
  Öneri sıklığı bir ayardır; varsayılan haftada en çok bir açık öneri (B).

### 9.4 İzleme ve iyileştirme

- Ajan sonuçlara günde bir bakar; platformun öğrenme süresi nedeniyle daha sık değişiklik
  yapılmaz. Tempo bir ayardır (B).
- Ajanın yapabildiği hamleler: bir reklamı ya da reklam setini durdurmak ve başlatmak, kampanya
  bütçesinin içinde bütçeyi kaydırmak, yeni çeşit eklemek, reddedilen reklamı düzeltip yeniden
  göndermek. Hepsi kampanya bütçesinin içindedir; kampanya bütçesini yalnızca insan değiştirir.
- Her hamle kampanya sayfasında "ajanın yaptıkları" listesinde, nedeniyle birlikte görünür.

### 9.5 Sonuç ve ölçüm

- İlk sürümde ölçülebilen sonuç türleri: reklam formu (kişi) ve site ziyareti. Satışın platforma
  geri bildirilmesi (dönüşüm bildirimi) sonraki adımdır.
- **B25.** Form sonucu yalnızca Gelen kutusu kuruluysa seçilebilir, çünkü formdan gelen kişinin
  düşeceği yer orasıdır. Kurulu değilse ajan site ziyareti hedefini kullanır.
- Ekranda öne çıkan üç sayı: harcanan / bütçe, sonuç sayısı, sonuç başına maliyet. Tıklama oranı
  gibi ara ölçüler kampanya sayfasında ikinci plandadır.

### 9.6 Ekranlar

**(a) Kampanya sırası — ana ekran (B13).**

```
[ajan durumu satırı, gerekiyorsa]
Reklam yönetimi                         [platform süzgeci]   [+ Reklam kampanyası aç]
Reklam bütçesi · Kasım · tüm platformlar     9.150 / 30.000 harcandı · Bütçe'de gör
Kupa serisi lansmanı   Instagram, Facebook   3.250 / 5.000 ▓▓▓▓░░   41 form · 79    Yayında
Anneler günü           Instagram             0 / 6.000              inceleniyor     İncelemede
Kış koleksiyonu        Cum 09:00'da başlar   0 / 3.000              hazırlanıyor    Hazırlanıyor
```

**(b) Reklam kampanyası açma.** Zorunlu: hedef, kampanya bütçesi, başlama saati. İsteğe bağlı:
platform, bitiş tarihi. Bütçe alanının altında genel reklam bütçesinde kalan tutar yazar.

**(c) Reklam kampanyası sayfası.** Reklamların platformdaki önizlemesi (içerik sayfasındaki düzenle
aynı: sekmeler, büyük önizleme), kime gösterildiğinin düz cümleyle özeti, harcama ve sonuç,
ajanın yaptıkları, "Kampanyayı durdur", bütçe ve bitiş tarihini değiştirme.

### 9.7 Platformlar ve izinler

- **B12 — İlk platform Meta** (Instagram ve Facebook): bütçe yazma, durdurma, sonuç okuma ve form
  alma bağlayıcıda var; eksik olan oluşturma. Eski sistemdeki reklam başlatma kodu
  (`backend/src/modules/marketing/ads/`) taşırken referanstır.
- Yapı platformdan bağımsız tasarlanır; TikTok, LinkedIn, X ve Google sonraki adımlardır.
- Başkalarının reklam hesabında kampanya oluşturmak platform izni gerektirir (Ek B.3). Bu izin
  süreci kod değil, sahibin yürüttüğü başvuru işidir; izin gelene kadar yalnızca uygulamada rolü
  olan kişilerin reklam hesabında denenebilir.
- **B26.** Dışarıda kurulmuş bir reklam setini bağlama (bugünkü özellik) çalışmaya devam eder;
  ana akışta öne çıkmaz.

---

## 10. Bugünkü Büyüme stüdyosundan yeni yapıya

| Bugün | Yeni yeri |
|---|---|
| Stüdyo → Bugün (onay kuyruğu, içerik metni kutusu) | Kalkar. Engeller ilgili modülün satırında ve ana sayfada görünür |
| Stüdyo → Plan | Sosyal medya yönetimi → hesabın "Sıradaki paylaşımlar"ı |
| Stüdyo → Öğrenilenler | Strateji |
| Stüdyo → Günlük | Kalkar |
| Strateji çubuğu, Acil fren | Çubuk kalkar; durdurma Bütçe'de |
| Üretim alanları | İçerik oluşturma |
| Materyaller → Yükle, Kütüphane, Olaylar, Çekim listesi | Materyal kütüphanesi |
| Materyaller → Takvim | İçerik oluşturma → ayarlar |
| Materyalden yeni görsel üret | İçerik oluşturma (üretim alanının işi) |
| Paylaşımlar → Plan, Haftalık özet | Sosyal medya yönetimi → hesap sayfası |
| Paylaşımlar → Paylaşım ayarları | Sosyal medya yönetimi → ayarlar |
| TikTok paylaşım ekranı | Sosyal medya yönetimi; ana sayfadaki işten açılır |
| Reklam seti bağlama, bütçe hamlesi | Reklam yönetimi |
| Filtreler (hipotez, tarih) | Kalkar; hipotez ekranda görünmez |

## 11. Kısıtlar

- Rust ve altıgen mimari; Jeeta'nın bağımlılık ağacında yapay zekâ, medya üretimi ya da trend
  sağlayıcısı olmaz (`studio_has_no_ai_media_or_trend_provider` kuralı kalır). Reklam ve sosyal
  platform bağlayıcıları Jeeta'nın içindedir.
- Her panel işleminin MCP ikizi olur (ikiz kuralı); insana ait kararlar (paylaşım izni, kampanya
  önerisi onayı, bütçe ve durdurma) yalnızca panelden verilir.
- Kiracı izolasyonu (zorunlu satır düzeyi güvenlik) her yeni tabloda uygulanır.
- Her şema değişikliği ve veri tohumu geri alınabilir bir ileri/geri çift olarak yazılır; geri
  adım yalnızca ileri adımın eklediğini kaldırır ve çalışan veriye dokunmaz.
- Mevcut kayıtlar (materyaller, olaylar, üretim alanları, planlı ve yayınlanmış paylaşımlar,
  ölçümler, reklam seti bağları) korunur ve yeni modüllerde görünür.
- Bağlı ajanların kullandığı MCP araç adları (`jeeta.studio.*`) sessizce bozulmaz: ad değişecekse
  eski ad en az bir sürüm boyunca çalışır.
- Depo herkese açıktır: belgelere ve testlere gerçek müşteri verisi, ekran görüntüsü ya da döküm
  girmez.
- Aynı çalışma ağacında başka bir oturumun commit edilmemiş işi var (ana sayfa, modül kilidi,
  gelen kutusu, komisyonların kaldırılması). Adım 0 aynı dosyalara dokunur (`Shell.tsx`,
  `modules.rs`, `gate.rs`, ana sayfa); o iş commit edildikten sonra başlar.
- Platform kuralları: TikTok paylaşım ekranı (§7.4), platformların reklam incelemesi, platform
  izin süreçleri (Ek B).
- Arayüz Türkçe ve İngilizce anahtar eşliğiyle yazılır; ekranda iç terim (hipotez kolu, şerit,
  yuva, parça) görünmez.

## 12. Yapım sırası

Sıra sahiple kararlaştırıldı: önce sınır ve iskelet, sonra içerik, sosyal medya, reklam. Her adım
staging'de çalışan bir ürün bırakır ve kendi uygulama planıyla yürür.

| Adım | Ne | Sonunda görülen |
|---|---|---|
| 0 — İskelet ve bölme | Yan menü, zorunlu alanlar, Kullanıcılar, İş takibi ve Günlük'ün kalkması, Gelen kutusu'nun isteğe bağlı olması; dört modülün kaydı, izinleri ve kapısı; mevcut ekranların davranış değişmeden yeni modüllere yerleştirilmesi; Öğrenilenler'in Strateji'ye taşınması | Büyüme stüdyosu yok; dört modül menüde, her biri bugünkü ekranlarıyla |
| 1 — İçerik oluşturma | Üretim hattı, açma formu, başlama saati, sistemin açtığı üretim alanları, içerik paketi, içerik sayfası, "Olmamış", ajan durumu satırı; görsel içerik | Hedeften pakete insansız görsel üretim |
| 2 — Sosyal medya yönetimi | Hesap ekranı, paketten planlama, onaysız yayın, platform zamanlayıcısı, TikTok işi, paylaşımı duraklatma | Paketten yayına insansız akış ve hesap performansı |
| 3 — Bütçe ve reklam yönetimi | Bütçe ekranında kırılım ve durdurma; reklam kampanyası, kampanya planı, Meta'da oluşturma, iki katmanlı sınır, sistem önerisi ve onayı, izleme | Hedef ve bütçeden yayındaki reklama |
| Sonra | Kısa video; TikTok, LinkedIn, X, Google reklamları; satış bildirimi; trend | — |

Adım 0'da Stüdyo/Bugün ve Stüdyo/Plan geçici olarak Sosyal medya yönetimi'nin içinde durur; Adım
2'de yerlerini hesap ekranı alır.

**B38 — Adım 3'ün kanıtı.** Adım 3 sahte sağlayıcıyla test edilir. Gerçek kanıt, Meta'nın ileri
düzey erişimi gelene kadar yalnızca sahibin kendi reklam hesabında, sahibin o an verdiği açık
onayla ve belirlediği küçük bir bütçeyle yapılır.

## 13. Kararlar

**Sahibin kararları**

| # | Karar |
|---|---|
| S1 | Büyüme stüdyosu üçe ayrılır: Reklam yönetimi, İçerik oluşturma, Sosyal medya yönetimi; üçü de bağımsız ve derin modüllerdir |
| S2 | Reklam modülü reklam oluşturur |
| S3 | Materyal kütüphanesi üç modülün ortak zeminidir; modüldür, zorunlu alan değildir |
| S4 | Strateji ve hipotezler her hesapta geneldir; öğrenilenler hipotezi ve stratejiyi günceller |
| S5 | Günlük ekrandan kalkar; kayıt arkada tutulur |
| S6 | Acil fren baskın olmaz; bütçenin içinde, harcamanın göründüğü yerde durur |
| S7 | Bütçe geneldir; her modül bütçeye etki eder ve bütçe ekranında görünür |
| S8 | Zorunlu alanlar: Bütçe, Strateji, API anahtarları, Kullanıcılar (ekip ve roller tek sayfa), Yetenekler ve bağlantılar. İş takibi kalkar |
| S9 | Onaylar ana sayfadaki işler ve onaylara düşer |
| S10 | Gelen kutusu zorunlu değildir, modüldür |
| S11 | Her içerik kendi üretim alanında yapılır; yalnızca ajanlar üretir; gerçek materyal talep edilebilir; akış 14 adımdır; kapsam filme kadar uzanır |
| S12 | İnsan hedefi verir ve süreçten mümkün olduğunca uzak durur |
| S13 | İçerik sayfasında bitmiş içeriğin önizlemesi ve platformda görünümü vardır; düzen "tek tek, büyük" |
| S14 | İçerikte ilk adım görseldir |
| S15 | Üretim alanı açarken tek cümle yeter; diğerleri isteğe bağlıdır |
| S16 | Üretim alanının zorunlu başlama saati vardır; modülün ana ekranı tek sıralı üretim hattıdır |
| S17 | Sosyal medya yönetimi paylaşımları planlar ve paylaşır; mesaj yoktur; trend ileride |
| S18 | Yayında onay yoktur; platformun kendi zamanlayıcısı varsa oraya kurulur |
| S19 | Sosyal medya ana ekranı bağlı hesaplar ve performanslarıdır; düzen "hesap seç, içine gir" |
| S20 | İnsanın açtığı reklam kampanyası onaysız başlar; para sınırı güvencedir |
| S21 | Kampanyanın kendi bütçesi vardır; ayrıca tüm platformların düştüğü genel reklam bütçesi Bütçe'dedir |
| S22 | Sistem insana bağlı ilerlemez; kendiliğinden akış kalır |
| S23 | Biten içerik doğrudan paylaşıma gider; içerik onayı yoktur |
| S24 | Sistem kendi reklam kampanyasını açıp harcayabilir, ama kendi kararını onaya sunar |
| S25 | Kaldırılan modülün işleri durur, verisi kalır; yeniden kurulunca devam eder |
| S26 | İşi sahibin bağladığı ajan yapar; sürekli çalışan işçi ayrı bir iştir |
| S27 | Ana sayfa akışındaki "Günlük" sekmesi kalır |

**Bu belgeyi yazanın kararları**

| # | Karar | Bölüm |
|---|---|---|
| B2 | Ajan merkezi ve Ajanlar sayfası yerinde kalır | §4.1 |
| B3 | Kütüphane üç modülden biriyle birlikte kurulur | §4.4 |
| B4 | Panelde elle içerik yazma ve kurgu yok | §6.4 |
| B5 | Amaç ve kitle stratejiden; seçilmediyse platform ve biçimi ajan seçer | §6.1, §6.2 |
| B6 | Sıra başlama saatine göre; boşta ajan varsa işler paralel | §6.4 |
| B7 | "Olmamış"ın işleyişi | §6.4 |
| B8 | Boş kanal tetikleyicisi yalnızca Sosyal medya yönetimi kuruluysa | §6.3 |
| B9 | Doğruluk bulgusu önce ajana döner; üçüncü tutulmada insana | §5.4 |
| B10 | İzin ve doğruluk denetimleri reklama da uygulanır | §5.4 |
| B11 | Kampanyayı Jeeta kendi bağlayıcısıyla kurar | §9.2 |
| B12 | İlk reklam platformu Meta | §9.7 |
| B13 | Reklam ana ekranı kampanya sırası ve platform süzgeci | §9.6 |
| B14 | Kampanyada isteğe bağlı bitiş tarihi; boşsa süreyi ajan belirler | §9.1 |
| B15 | Reklam kampanyası platforma bağlı değil | §9.1 |
| B16 | Sistemin kampanya önerisi 7 günde kapanır; haftada en çok bir açık öneri | §9.3 |
| B17 | Ölçüm Sosyal medya yönetimi'nde; sonuç Strateji'ye | §7.5 |
| B18 | İçerik oluşturma yoksa sosyal ajan basit paket yapar | §7.2 |
| B19 | İzinler modül başına ayrılır | §4.4 |
| B20 | Özel gün takvimi İçerik oluşturma'ya | §5.1 |
| B21 | Trend notu ekranı kalkar; aracı ve verisi kalır | §4.5 |
| B22 | Haftalık özet hesap sayfasına yedirilir | §7.1 |
| B23 | Paylaşımı duraklatma Paylaşım ayarları'nda | §7.6 |
| B24 | Reklam hesabı ile reklam bütçesi aynı para biriminde; kur çevrimi yok | §8.2 |
| B25 | Form sonucu yalnızca Gelen kutusu kuruluysa | §9.5 |
| B26 | Dış reklam setini bağlama kalır, öne çıkmaz | §9.7 |
| B27 | Birimin ekrandaki adı "reklam kampanyası" | §9.1 |
| B28 | Mevcut çalışma alanlarında dört modül kurulu gelir | §4.4 |
| B29 | Yapım dört adımdır; her adımın ayrı planı vardır | §12 |
| B30 | Her modülün ana ekranında ajan durumu satırı | §5.3 |
| B31 | Genel bütçe bitince kampanyalar duraklar, yeni dönemde devam eder | §8.2 |
| B32 | Kampanya bütçesi platforma toplam bütçe olarak yazılır | §8.2 |
| B33 | Özel reklam kategorisi gerektiren kampanyalar ilk sürümde kurulmaz | §9.2 |
| B34 | Ajan ataması sunucuda uygulanır; atama yoksa izni olan her ajan çalışır | §5.3 |
| B35 | Bağlantının kendi onay ayarı korunur; şerit ayarı ona taşınır | §7.3 |
| B36 | Harcama kırılımı harcayan her modülü kapsar; durdurma yalnızca harcamayı durdurur | §8.3 |
| B37 | Genel reklam bütçesi tek kalemdir; stratejinin ücretli tavanını aşamaz | §8.1 |
| B38 | Adım 3'ün gerçek kanıtı sahibin kendi reklam hesabında, açık onayla | §12 |
| B39 | Ajanın ürettiği, kişi göstermeyen görsel, belirli bir şeyden söz etmeyen içeriğin tek görseli olabilir; çalışma alanı ayarıdır, varsayılan açık (eski D10 kuralının yerine) | §5.1 |
| B40 | Üretim alanında çalışan (`content.work`) materyal ekler, çekim ister ve talebi yanıtlar; alandan kaynak çıkarmak yöneticinindir (`content.manage`) | §6.2 |
| B41 | "Olmamış" kişinin gördüğü pakete bağlıdır: ajan o sırada adım bildirse de kabul edilir, araya yeni paket girdiyse reddedilir | §6.4 |
| B42 | İstenen çekim beklenirken üretim alanı bitmiş sayılmaz | §6.1 |
| B43 | Paket sınırları: en çok 12 platform sürümü; metin 5.000, başlık 160 karakter; 30 etiket; alan son 20 paketi tutar, tüm teslimler kayıtta kalır | §6.1 |
| B44 | Biçimi bozuk bir teslim (çok uzun metin, geçersiz bağlantı) hatadır, "tutuldu" sayılmaz; üç tutulma yalnızca denetim bulgularından sayılır | §5.4 |
| B45 | Tutulan alanda (üç ret) insan nedeni sürüm sürüm görür; yalnızca metin denetimine takılan teslimi olduğu gibi kabul edebilir (kabul eden kayda geçer), materyal bulgusu hiçbir zaman kabul edilmez; ya da not yazıp ajana geri gönderir, ya da alanı arşivler | §5.4 |
| B46 | İşlem adlarında "package" sözcüğü kullanılmaz (ücretli paket kavramıyla karışmasın diye var olan mimari kuralı): teslim `content.area_deliver`, insanın kabulü `content.delivery_accept` | §14 |
| B47 | Platformun zamanlayıcısı çalışma alanı ayarıdır ve **kapalı gelir** (Sosyal medya → Ayarlar): Facebook çağrıları belgelenmiş biçimlerle yazıldı ama gerçek bir Sayfa'da çalıştırılmadı; sahibi kendi Sayfa'sında bir zamanlama ve bir geri çekme gördükten sonra açar. İlk sürüm yalnızca Facebook Sayfası'nın metin, bağlantı ve tek görselli gönderilerini bırakır (video, çoklu görsel, hikâye Jeeta'da kalır). Platforma bırakma yuvanın tek yayın denemesidir (motorun "bir yuva bir kez denenir" kuralı değişmedi): geri çekilen paylaşım iptal edilir ve içeriği yeniden saat bekler, durdurma kalkınca ajan yeni saat verir (aynı yuva yeniden kurulmaz). Kişinin "Olmamış" ya da iptal eylemi önce platformdan geri çeker; platform doğrulamazsa eylem reddedilir ve kişiye o an söylenir. Saatine iki dakikadan az kalmış paylaşım geri çekilmez: çıkmış bir paylaşım hiçbir durumda silinmez | §7.3, Ek B.1 |
| B48 | Bütçe'de durdurma anahtarları: reklam (ücretli şeridin freni), gelen kutusu, kampanyalar, aramalar, sosyal medya ve "tümü". Aday havuzundan atılan ilk mesaj gelen kutusunun gönderim yolundan gittiği için "Gelen kutusu" altında sayılır ve onunla durur. Çalışma alanı freni (`studio.brake`, şeritsiz) kaldırılmadı: ajan çalışanı durdurabilsin diye kalır, Bütçe'de "tümü durduruldu" olarak okunur ve "tümünü sürdür" onu da kaldırır (0040 numaralı ayrı bir veri göçü gerekmedi) | §9 |
| B49 | Kampanya kaydı ayrı bir alan paketi (`jt_ads`) değil, `jt_app::ports::ads` içindedir; depolama `ads_campaigns` (göç 0040). Kampanyanın tuttuğu para ayrı bir rezervasyon satırı değildir: kampanyanın kendisidir (harcanmamış bütçesi), ve reklamla ilgili her harcama kapısı (kampanya açma, onay, plan, sürdürme, etkinleştirme, bağlı reklam setinin bütçe hamlesi) açık kampanyaların tuttuğunu aynı toplamla görür | §8, §9 |
| B50 | Kurulmuş kampanyanın bütçesi ve bitiş tarihi bu sürümde değiştirilemez (sağlayıcıdaki nesne kurulduğu değerleri taşır): bitirilip yenisi açılır. İzleme ayrı bir zamanlanmış iş değildir, `studio_control` işinin parçasıdır ve sağlayıcıyı kampanya başına saatte bir okur. Kampanya sonuçları stratejinin öğrenme kayıtlarına bu sürümde yazılmaz | §8 |
| B51 | Biten kampanya sağlayıcıda susana kadar izlenir: duraklatma sağlayıcı onaylayana dek yeniden denenir ve o zamana kadar kampanyanın harcanmamış bütçesi tutulur (`provider_still_running`); bitişten sonra 48 saat boyunca saatte bir okunur ki son saatlerin ve geç bildirilen harcama bütçeye yazılsın. Reklam yönetimi modülü kaldırılınca çalışan kampanyalar sağlayıcıda durdurulur. Geniş (Advantage+) kitlede alt yaş 18–25, üst yaş 65'tir. Günlük sonuç yalnızca kampanyanın amacının sayısıdır (form: `lead`, site: `link_click`). | §8 |
| B52 | Etkin olmayan (ödemesi bekleyen ya da askıya alınmış) çalışma alanında paneli kapalıdır, kimse reklamı göremez ya da durduramaz: Jeeta'nın kurduğu kampanyalar sağlayıcıda durdurulur (`workspace_inactive`), okunmaya devam eder, çalışma alanı yeniden etkinleşince kendiliğinden sürer. `studio_control` işi etkin olmayan alanlarda yalnızca bunu yapar | §8 |
| B53 | Paylaşım motoru yalnızca organik sıklığı olan bir hipotez için paylaşım planlar; bu alanı ne panel ne de strateji istişaresi sorar. Bu yüzden strateji onaya sunulurken, strateji paylaşım yapıyorsa (`cadence.per_week` sıfırdan büyük) organik sıklık adlandırmamış her canlı hipoteze varsayılan sıklık yazılır (tek içerik türü `general`); kendi sıklığını adlandıran hipotez (haftada sıfır dahil: paylaşım yapmaz) olduğu gibi kalır. Paketteki sürümün içerik türü etikettir: strateji o türü adlandırmıyorsa paylaşım hipotezin kendi türüyle planlanır. Hiçbir hesabın alamadığı bekleyen sürüm nedenini taşır (`blocked`), panel ve ajan aynı nedeni görür; sosyal modülün durum satırı stratejide paylaşım yapan hipotez olmadığını söyler | §6, §7 |
| B54 | Reklam hesabına giden her çağrı (hesabın kendisi, kampanyaları, reklam setleri, reklamları, kreatifleri, önizlemeleri, ölçüleri, lead formları; reklam hesaplarının listelenmesi ve yoklanması) yazıldığı Marketing API sürümünden (`v27.0`) eski bir sürümle gönderilmez. Bağlayıcının genel varsayılanı `v19.0` Meta'nın artık sunmadığı bir sürümdür; Meta, sunmadığı bir Marketing API sürümüne giden çağrının "başarısız olabileceğini ya da yükseltileceğini" söylüyor ve her sürümü yaklaşık bir yıl sunuyor. `JEETA_META_GRAPH_VERSION` daha yeni bir sürüm veriyorsa o kullanılır. Diğer Meta çağrıları (paylaşım, mesaj, yorum, Sayfa ve Instagram ölçüleri) değişmedi: Meta onları kullanılabilir en eski sürüme düşürüyor ve bu program onlara dokunmadı. Gerçek Meta'da denenmedi (B38) |
| B55 | Yayına giren reklam, planlanan ve sunucunun denetlediği reklamdır: Meta'nın kendiliğinden eklediği içerik kapalı gönderilir. v27.0'dan başlayarak Meta, ürün vitrini (`product_extensions`) hakkında bir şey söylemeyen kreatifte, hesabın kataloğundaki bir ürün kümesinin reklamla eşleştiğinden emin olduğunda ürün vitrinini kendisi açabiliyor; Jeeta'nın kurduğu her kreatif bunu reddeder (`degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status = OPT_OUT`). Aynı sürümün "diğer mobil cihazlara ulaş" varsayılanı yalnızca cihaz hedeflemeli satış kampanyalarına uygulanır, Jeeta'nın kurduğu trafik ve form kampanyalarına değil. Gerçek Meta'da denenmedi (B38) |

## 14. Yapıcıya bırakılanlar

- Modül, işlem, yol ve izin adları; eski adların ne kadar süre takma ad olarak yaşayacağı.
- Tabloların biçimi: üretim alanının yeni alanları, içerik paketi ve platform sürümü, reklam
  kampanyası, kampanya planı, sistem önerisi. Mevcut tabloların (paylaşım isteği, planlı paylaşım,
  yuva, parça, üretim alanı çıktısı) ne kadarının yeniden kullanılacağı.
- Kampanya planının şeması ve Jeeta'nın onu platform nesnelerine çevirme biçimi.
- Sistemin açtığı üretim alanında hedef cümlesinin nasıl kurulduğu.
- Platform önizleme çerçevelerinin sadakat düzeyi (platformun kendi önizlemesi mi, yakın bir
  çerçeve mi); reklamda platformun verdiği önizleme varsa o kullanılır.
- Ajan `workflow` metinlerinin tam ifadesi ve iş ipuçları.
- Ekranların bileşen düzeyi tasarımı; mevcut tasarım diline (`docs/design/jeeta-panel/`) uyulur.
- Adım içi görev sırası ve test düzeni.

## 15. Açık konular

| # | Konu | Durum |
|---|---|---|
| A2 | Platformların zamanlayıcı ve ölçü desteği | Ek B.1, B.2 |
| A3 | Meta'da oluşturma için gereken izinler ve kesin sınır özelliği | Ek B.3 |
| A5 | TikTok ve X belgelerinin başka bir ağdan doğrulanması | 2026-11-11: X'in satırları X'in kendi belge deposundan, TikTok'un gönderi ve ölçü satırları sayfaların kendisinden (bir sayfa okuma hizmetiyle), TikTok'un reklam satırındaki alan ve değer adları resmi SDK deposundan okundu (Ek B). Açık kalan tek şey TikTok reklam satırındaki değerlerin anlamı: o başvuru sayfası okunamadı, anlamlar arama sonucuna dayanır |
| A6 | "Kaldırılınca durur" kuralının Gelen kutusu, Kampanyalar ve Aramalar'a uygulanması | Bu çalışmanın dışında; ayrı iş |
| A7 | Kendi kendine sürekli çalışan ajan işçisi ve güvenlik sınırı | Bu çalışmanın dışında; Adım 1'den sonra ayrı tasarım |
| A4 | Jeeta dışından yapılan paylaşımların hesap sayfasında görünmesi | Bu çalışmada yok; hesap ölçüleri onları zaten kapsar |

---

## Ek A — İşlemlerin modüllere dağılımı

Bugünkü `studio.*` işlemlerinin ait olacağı yer. Adlar bugünkü adlardır; yeniden adlandırma
yapıcıya bırakılmıştır.

| Yeni yer | İşlemler |
|---|---|
| Materyal kütüphanesi | `file_upload`, `material_add`, `material_get`, `materials_list`, `material_preview`, `material_tag`, `material_bind`, `material_free`, `material_permission`, `material_delete`, `material_intelligence_get`, `material_intelligence_list`, `material_intelligence_update`, `material_analysis_claim`, `material_analysis_complete`, `material_analysis_fail`, `material_analysis_retry`, `olay_create`, `olay_update`, `olay_get`, `olays_list`, `olay_confirm`, `shoot_list`, `shoot_request`, `shoot_resolve`; ortak teslim ve denetim: `piece_submit`, `slot_materials`, `material_check_release` |
| İçerik oluşturma | `project_create`, `project_get`, `project_list`, `project_update`, `project_materials`, `project_request`, `project_request_update`, `project_production`, `material_production_request`, `material_production_list`, `material_production_claim`, `material_production_complete`, `material_production_fail`, `calendar_list`, `calendar_set`, `material_policy_set` |
| Sosyal medya yönetimi | `project_publication`, `project_schedule`, `post_requests`, `posts_propose`, `posts_list`, `posting_policy_set`, `weekly_summary`, `slot_get`, `slot_cancel`, `tiktok_posting`, `tiktok_post`, `tiktok_metrics` |
| Reklam yönetimi | `adsets_list`, `adset_bind`, `budget_move` |
| Strateji | `learned`, `judgment_record`, `hypothesis_propose`, `trend_record` |
| Bütçe | `brake` (durdurma olarak) |
| Kalkar ya da yeniden biçimlenir | `overview`, `pending`, `approve`, `policy_set`, `ledger`, `ledger_export` |

`piece_submit`, `slot_materials` ve `material_check_release` (içeriğin teslimi, uygun materyalin
bulunması ve denetim bulgusu) üç modülün de kullandığı işlemlerdir: Sosyal medya yönetimi İçerik
oluşturma olmadan basit paket yapar (B18), Reklam yönetimi aynı denetimlerden geçer (B10). Bu
yüzden bir modüle değil, üçüyle birlikte gelen ortak zemine aittir. `calendar_*` ve
`material_policy_set` (hazırlık, tekrar ve özet süreleri) üretim alanı açtıran tetikleyicilerin
ayarlarıdır. `overview` ve `pending`
modül başına okumalara bölünür. `approve` ve `policy_set` onayın kalkmasıyla anlamını yitirir;
`approve`'un TikTok ekranı ve sistem kampanya önerisi için kalan kullanımı ilgili modüle geçer.
`ledger` kaydı tutulmaya devam eder; ekranı ve dışa aktarımı kalkar.

## Ek B — Platform araştırması

2026-11-10'da platformların resmi geliştirici belgelerinden derlendi. TikTok ve X'in belge
sitelerine (`developers.tiktok.com`, `business-api.tiktok.com`, `docs.x.com`, `api.x.com`) bu
makinenin ağından erişilemiyor, sayfa okuma aracına da 403 dönüyorlar. 2026-11-11'de o satırlar üç
yoldan denetlendi; her satır hangisine dayandığını söyler:

- **Belgeden doğrulandı (X).** X, `docs.x.com`'un kaynağını ve API tanımını kendi deposunda
  yayımlıyor (`github.com/xdevplatform/docs`). O deponun `2d88f2f6` commit'inden API tanımı
  (`openapi.json`, X API v2, sürüm 2.174), ölçü sayfası ve Reklam API'sinin kampanya ve kreatif
  başvuruları okundu. X'in üç satırı bunlara dayanır.
- **Resmi SDK deposundan (TikTok reklamları).** TikTok'un Business API SDK deposunun
  (`github.com/tiktok/tiktok-business-api-sdk`, commit `f809c396`) istek gövdeleri ve tanım
  dosyaları alan ve değer adlarını verir; değerlerin açıklaması orada boştur. Adlar buradan,
  anlamları arama sonucundandır.
- **Belgeden doğrulandı (TikTok gönderi ve ölçüleri).** Bu uçları taşıyan resmi bir depo yok;
  satırlar önce yalnızca arama aracıyla denetlenmişti. Aynı gün `developers.tiktok.com`'daki
  sayfaların kendisi bir sayfa okuma hizmetiyle okundu (istek bu makineden çıkmaz): doğrudan
  gönderi başvurusu, paylaşım kılavuzu, kullanıcı bilgisi, video listesi, video sorgusu ve video
  nesnesi. Satırlar sayfalarla aynıdır; sayfaların "son güncelleme" tarihleri Kaynaklar'da.
- **Arama ile doğrulandı (yalnızca TikTok reklam değerlerinin anlamı).** `business-api.tiktok.com`
  başvuru sayfaları tarayıcıda çizilen bir uygulamadır ve okunamadı; yalnızca belge sitesinin
  giriş sayfası ve oradaki duyuru okunabildi.

### B.1 Platformun kendi zamanlayıcısı (§7.3)

| Platform | Üçüncü taraf uygulama platformda zamanlayabilir mi | Ayrıntı |
|---|---|---|
| Facebook Sayfası | **Evet** | `published=false` ve `scheduled_publish_time` (gönderi, fotoğraf, video); Reels için `video_state=SCHEDULED`. En az 10 dakika sonrası; üst sınır için Meta'nın sayfaları 30 ve 75 gün diyor, Reels'te 29 gün. Tasarım 29 günü esas alır. Hikâye zamanlanamaz. Zamanlanmış gönderi API ile değiştirilebilir ve silinebilir (yalnızca uygulamanın kendi oluşturdukları) |
| Instagram | **Hayır** | Yayın ucunda zamanlama parametresi yok; belgeler yalnızca uygulama tarafında zamanlamadan söz ediyor |
| LinkedIn | **Hayır** | Oluştururken kabul edilen tek durum `PUBLISHED` |
| TikTok | **Hayır** (belgeden doğrulandı) | Doğrudan gönderinin (`POST /v2/post/publish/video/init/`, kapsam `video.publish`, kullanıcı belirteci başına dakikada 6 istek) istek gövdesinin tamamı: `post_info` {`privacy_level` (zorunlu; `creator_info/query` yanıtındaki seçeneklerden biri), `title`, `disable_duet`, `disable_stitch`, `disable_comment`, `video_cover_timestamp_ms`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc`} ve `source_info` {`source`, `video_url`, `video_size`, `chunk_size`, `total_chunk_count`}. Zamanlama alanı yok. Denetimden geçmemiş uygulama yalnızca `SELF_ONLY` görünürlüğünde, gizli hesaplara ve 24 saatte en çok 5 kullanıcı için gönderir; her uygulama için ortak olan hesap başına günlük gönderi sınırı vardır (genellikle yaklaşık 15). Paylaşım kılavuzu, görünürlüğü ve etkileşim ayarlarını kullanıcının varsayılansız, kendisinin seçmesini ve gönderimden önce açık onay vermesini zorunlu tutuyor (§7.4'ün dayanağı); "kendi yönettiğiniz hesaplara içerik yüklemeye yarayan araç"ı kabul edilmeyen kullanım sayıyor |
| X | **Hayır** (belgeden doğrulandı) | `POST /2/tweets` gövdesinin (`CreatePostsRequest`) API tanımındaki 17 alanının tamamı: `text`, `media`, `poll`, `reply`, `quote_tweet_id`, `reply_settings`, `community_id`, `card_uri`, `clip`, `direct_message_deep_link`, `edit_options`, `for_super_followers_only`, `geo`, `made_with_ai`, `nullcast`, `paid_partnership`, `share_with_followers`. Zamanlama alanı yok; tanımda zamanlanmış diye geçen yollar yalnızca canlı yayın ve arama içindir (`/2/broadcasts/scheduled`, `/2/calls/scheduled`). Zamanlanmış gönderi yalnızca Reklam API'sinde var (`POST accounts/:account_id/scheduled_tweets`; `scheduled_at` zorunlu, en çok bir yıl sonrası) |

Uygulama notu (2026-11-10, B47): kurulan ilk sürüm Facebook Sayfası'nın metin ve bağlantı
gönderilerini (`POST /{page}/feed`, Pages API "Posts" rehberi: `published=false`,
`scheduled_publish_time`, istekten 10 dakika ile 30 gün sonrası) ve tek görselli gönderisini
(`POST /{page}/photos`, aynı iki alan; başvuru sayfası dönüşte `post_id` veriyor) bırakır; Jeeta 15
dakika ile 29 gün arasını kullanır. Durum `GET /{post}?fields=id,is_published` ile okunur, geri çekme
`DELETE /{post}` ile yapılır. Başvuru sayfası gönderi silmeyi "yalnızca seçili geliştiriciler" diye
anıyor ve tek görselli zamanlamayı açıkça örneklemiyor: ikisi de gerçek Sayfa'da doğrulanmalı.

Sonuç: ilk sürümde yalnızca Facebook Sayfası paylaşımları "Platformda zamanlandı" olur; diğer
tümünü Jeeta'nın zamanlayıcısı yayınlar. Platform zamanlayıcısı bağlayıcıda isteğe bağlı bir
yetenek olarak tasarlanır ki sonradan destekleyen platform aynı yoldan eklensin.

### B.2 Hesap düzeyi ölçüler (§7.1)

| Platform | Takipçi ve değişimi | Erişim / görüntülenme | Etkileşim | Profil ziyareti | Sınır |
|---|---|---|---|---|---|
| Facebook Sayfası | `followers_count`; `page_follows`, `page_daily_follows` | `page_media_view`, `page_total_media_view_unique` | `page_post_engagements` | `page_views_total` | Sorgu başına 90 gün; 100 beğeninin altındaki sayfalarda ölçü yok |
| Instagram | `followers_count`; `follows_and_unfollows` (100 takipçinin altında yok) | `reach`, `views` | `accounts_engaged`, `total_interactions` | `profile_links_taps` | Veri 48 saate kadar gecikebilir |
| LinkedIn | Toplam takipçi ve günlük kazanım | `impressionCount`, `uniqueImpressionsCount` | `engagement`, tıklama, beğeni, yorum, paylaşım | Sayfa görüntülenmesi | Son 12 ay |
| TikTok | Yalnızca anlık: `follower_count` (`GET /v2/user/info/`, kapsam `user.info.stats`; ayrıca `following_count`, `likes_count`, `video_count`). Günlük değişim verilmez (belgeden doğrulandı) | Hesap düzeyinde yok; video başına `view_count` (`/v2/video/list/`, `/v2/video/query/`, kapsam `video.list`) | Hesap düzeyinde yalnızca toplam `likes_count`; video başına `like_count`, `comment_count`, `share_count` | — | Liste sayfa başına en çok 20 video (varsayılan 10); sorgu istek başına en çok 20 video kimliği |
| X | Yalnızca anlık: kullanıcının `public_metrics.followers_count` alanı (yanında `following_count`, `post_count`, `like_count`, `listed_count`, `media_count`). Günlük değişim verilmez (belgeden doğrulandı) | Hesap düzeyinde yok; gönderi başına `public_metrics.impression_count` | Gönderi başına `public_metrics` (`like_count`, `repost_count`, `reply_count`, `quote_count`, `bookmark_count`); `non_public_metrics`, `organic_metrics` ve `promoted_metrics` yalnızca kullanıcı yetkisiyle, kendi gönderileri için | — | Açık olmayan, organik ve tanıtılan ölçüler yalnızca son 30 günde oluşturulan gönderiler için |

Dikkat edilecekler:

- Meta 2025'te ölçü adlarını değiştirdi: `page_fans` → `page_follows`, `page_impressions` →
  `page_media_view`; Instagram'da `impressions` kalktı, yerine `views` geldi. Mevcut bağlayıcının
  okuduğu adlar Adım 2'nin planında bu listeyle karşılaştırılır.
- Platform takipçi değişimini vermiyorsa Jeeta kendi günlük okumalarından farkı hesaplayabilir;
  veremediği ölçüyü ekran boş gösterir.

### B.3 Reklam oluşturma izinleri ve kesin sınırlar (§8.2, §9.7)

**Meta (Instagram ve Facebook)** — Marketing API, 2026-11-04'te çıkan v27.0.

| Konu | Bulgu |
|---|---|
| Başkalarının reklam hesabı | `ads_management` için ileri düzey erişim gerekir; bu, uygulama incelemesi ve işletme doğrulamasıyla verilir |
| İnceleme öncesi | Standart erişim yalnızca uygulamada rolü olan kişilerden izin isteyebilir; kendi reklam hesabında denemek için yeterlidir |
| Bağlı izinler | `pages_read_engagement`, `pages_show_list`; sayfaya bağlı reklam için `pages_manage_ads`; form kişileri için `leads_retrieval` |
| Hız sınırı | Varsayılan "sınırlı" kademe çok dardır (reklam hesabı başına 60 puan; yazma 3 puan; saatlik 300 kota). "Tam" kademe için 15 günde 500+ çağrı ve düşük hata oranı gerekir. Oluşturma çağrıları buna göre yavaşlatılmalıdır |
| Oluşturma sırası | Kampanya (`objective`, `special_ad_categories` zorunlu) → reklam seti (kitle, yerleşim, bütçe, süre) → görsel ya da video yükleme → kreatif → reklam. `validate_only` ile kurmadan doğrulanabilir |
| Amaç değerleri | `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES` |
| Duraklatılmış kurma | Oluştururken yalnızca `ACTIVE` ya da `PAUSED` geçerlidir; yeni reklam `PENDING_REVIEW`'a girer |
| İnceleme durumu | `effective_status` (`PENDING_REVIEW`, `DISAPPROVED`, `WITH_ISSUES` …) ve `ad_review_feedback`. Meta incelemenin genellikle 24 saat içinde bittiğini söylüyor |
| Kesin sınırlar | Toplam bütçe (reklam seti ya da kampanya): "toplam bütçeden fazlası tahsil edilmez". Kampanya `spend_cap`: aşılmaz, alt sınırı yaklaşık 100 ABD doları. Hesap `spend_cap`: ulaşılınca tüm yayın durur |
| Kesin olmayan | Günlük bütçe: belgeler günde %25 ya da %75 aşım diyor; haftalık toplam günlük bütçenin 7 katını geçmez |
| Toplam bütçe koşulu | Toplam bütçe bir bitiş zamanı ister |
| En düşük bütçe | Hesabın `min_daily_budget` alanı ve optimizasyon türüne göre değişen alt sınırlar vardır |
| Önizleme | `generatepreviews`: yerleşim başına (`INSTAGRAM_STANDARD`, `INSTAGRAM_STORY`, `INSTAGRAM_REELS`, `MOBILE_FEED_STANDARD` …) 24 saat geçerli bir çerçeve döner; oluşturmadan önce de alınabilir |
| Reklam formu | `/{page-id}/leadgen_forms` ile oluşturulur; kişiler `leadgen` bildirimi ve `leads_retrieval` ile alınır (alma tarafı bugün var) |
| Sürüm | Sürümler yaklaşık bir yılda kapanır (v24.0 2026-11-10'da kapandı). Sunulmayan bir sürüme giden çağrı "başarısız olabilir ya da bir sonraki kullanılabilir sürüme yükseltilir"; yükseltme, o sürümde değişen uçlara uygulanmaz. Reklam hesabı çağrıları bu yüzden `v27.0`'dan eski bir sürümle gitmez (B54). v26.0 ve v27.0 değişiklik günlükleri 2026-11-11'de Jeeta'nın gönderdiği alanlarla karşılaştırıldı: bozan bir değişiklik yok; `advantage_audience` zaten açıkça gönderiliyor (v26.0 bunu zorunlu kıldı), yerleşim konumları hiç gönderilmiyor (v26.0 iki konumu kaldırdı), ürün vitrini varsayılanı reddediliyor (B55) |
| AB hedeflemesi | AB ülkelerine hedeflemede ödeyen ve yararlanan beyanı (`dsa_payor`, `dsa_beneficiary`) zorunludur |

**Diğer platformlar**

| Platform | Oluşturma için gereken | Kesin toplam sınır |
|---|---|---|
| TikTok | Geliştirici uygulaması incelemesi; reklamveren yetkilendirmesi (ikincil kaynaktan) | Kampanyada ve reklam grubunda `budget` ve `budget_mode`; değerleri `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DAY`, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`, `BUDGET_MODE_INFINITE`. Reklam grubunda `schedule_type` (`SCHEDULE_START_END`, `SCHEDULE_FROM_NOW`), `schedule_start_time`, `schedule_end_time`. Adlar resmi SDK deposundan; `BUDGET_MODE_TOTAL`'ın kampanyanın ya da reklam grubunun toplam sınırı olduğu arama ile doğrulandı (başvuru sayfası okunamadı). Belge sitesinin duyurusu: 2027-01-01'den başlayarak `/campaign/create/`, `/adgroup/create/` ve `/ad/create/`, satış, uygulama tanıtımı ve form amaçlarında eski elle kurulan (arama dışı) kampanyaları desteklemeyecek; bunlar "Upgraded Smart+" API'lerine taşınmalı. TikTok reklam adımı Smart+ uçlarıyla planlanmalıdır |
| LinkedIn | Reklam API'si başvurusu; geliştirme kademesinde en çok 5 reklam hesabı, sınırsızı ayrıca istenir | `totalBudget`: "toplam bütçeden fazlası harcanmaz"; günlük bütçe günde %150'ye kadar aşabilir |
| X | Uygulama başına reklam API'si erişim formu (ikincil kaynaktan) | Kampanyada `total_budget_amount_local_micro` ("kampanyaya ayrılan toplam bütçe") ve `daily_budget_amount_local_micro` (mikro birim; günlük, toplamdan büyük olamaz); satır öğesinin toplamı kampanyanınkini aşamaz. Genel bakış kampanyanın "bütçe harcanana kadar" sürebildiğini söylüyor; toplamdan fazlasının harcanmayacağını açıkça söyleyen bir cümle başvuruda da genel bakışta da yok (belgeden doğrulandı, kesinlik açık) |
| Google | Geliştirici belirteci kademeleri; üretim için en az "Explorer", sınırsızı için denetim | Toplam bütçe: "toplam bütçeden fazlası tahsil edilmez" |

Sonuç: "toplam bütçe" her platformda var; kesin sınır olduğu X dışında belgelerde açıkça yazıyor
(TikTok için bu, arama sonucuna dayanır). B32 bu yüzden platformdan bağımsız bir kuraldır; X
eklenirken kesinliği gerçek hesapta denenmeli, TikTok eklenirken Smart+ başvurusundan okunmalıdır.

### Kaynaklar

- https://developers.facebook.com/docs/pages-api/posts
- https://developers.facebook.com/docs/video-api/guides/reels-publishing
- https://developers.facebook.com/docs/instagram-platform/content-publishing
- https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
- https://developers.facebook.com/docs/platforminsights/page/deprecated-metrics
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
- https://developers.facebook.com/docs/graph-api/overview/access-levels
- https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
- https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group
- https://developers.facebook.com/docs/marketing-api/reference/ad-campaign
- https://developers.facebook.com/docs/marketing-api/reference/ad-account/generatepreviews/
- https://developers.facebook.com/docs/marketing-api/reference/adgroup-review-feedback/
- https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/
- https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
- https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- https://developers.google.com/google-ads/api/docs/campaigns/budgets/overview

X (2026-11-11, X'in kendi belge deposundan okundu: https://github.com/xdevplatform/docs, commit
`2d88f2f6bae07d8e887aaf0ef2ace0c113982143`; `docs.x.com` sayfalarının kaynağı):

- `openapi.json` (X API v2, sürüm 2.174): `POST /2/tweets`, `User` ve `Post` şemaları
- `x-api/fundamentals/metrics.mdx`
- `x-ads-api/campaign-management.mdx`, `x-ads-api/campaign-management/reference.mdx`
- `x-ads-api/creatives/reference.mdx` (zamanlanmış gönderiler)

TikTok reklamları (2026-11-11, TikTok'un resmi SDK deposundan okundu:
https://github.com/tiktok/tiktok-business-api-sdk, commit `f809c396520df2d7b201a9ccc5378d822b728ed3`):

- `README.md`, `java_sdk/docs/CampaignCreateBody.md`, `java_sdk/docs/AdgroupCreateBody.md`
- `yml_files/smart_plus_campaign_create.yml`, `yml_files/smart_plus_adgroup_create.yml` (değer listeleri)
- https://business-api.tiktok.com/portal/docs/create-an-ad-group/v1.3 (anlamlar; arama aracıyla)
- https://business-api.tiktok.com/portal/docs (giriş sayfası ve 2027-01-01 duyurusu; okundu)

TikTok gönderi ve ölçüleri (2026-11-11, sayfaların kendisi okundu; parantezde sayfanın son
güncelleme tarihi):

- https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post (2026-10-27)
- https://developers.tiktok.com/docs/en/content-sharing-guidelines (2026-08-04)
- https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info (2026-11-04)
- https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list (2026-08-04)
- https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query (2026-08-24)
- https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object (2026-08-24)
