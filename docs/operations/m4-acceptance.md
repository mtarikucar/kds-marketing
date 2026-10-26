M4 sahibi kabul kaydı

Bu listedeki canlı ödeme ve sağlayıcı adımlarını yalnızca sistem sahibi, kendi
yetkilendirdiği hesaplarla yürütür. Otomatik `make smoke-productisation` sonucu
canlı kabul yerine geçmez. Buradaki örnekler sentetiktir; gerçek ödeme belgesi,
kod, parola, anahtar, müşteri içeriği ve özel kayıtlar bu herkese açık depoya girmez.
Tarih, tam revizyon ve sonuç özel operasyon kaydında tutulur. Çözülmemiş sağlayıcı
uygulama onayı veya başarısız geri dönüş testi M4 kabulünü açık bırakır.

## Kayıt

Adımlar: İncelenen sürümü açın; `owner@example.test` benzeri sentetik bir hesapla
yeni çalışma alanı oluşturun ve yeniden oturum açın.

Beklenen: Alan `pending_payment` durumundadır. Sahip üyeliği oluşur; etkin hak,
doğrulanmış bağlayıcı ve bağlanmış ajan kendiliğinden oluşmaz.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Ödeme beklerken strateji

Adımlar: Strateji görüşmesini başlatın, taslak bölümleri yazın ve yeniden yükleyin.
Ekip daveti, API anahtarı oluşturma ve bağlayıcı eklemeyi deneyin.

Beklenen: Strateji hazırlığı kalıcıdır; ekip, anahtar ve bağlayıcı işlemleri ödeme
beklerken reddedilir. Strateji onayı ve ödeme iki ayrı koşuldur.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Havale bildirimi ve işletmen onayı

Adımlar: Panelde kurulumdan gelen tutar, para birimi, banka talimatı ve sabit
referansı kontrol edin. Sahip tarafından yetkilendirilmiş havaleyi bildirin;
işletmen ayrı oturumla banka kanıtını karşılaştırıp onaylasın. Aynı bildirimi
aynı istek anahtarıyla yineleyin ve işletmen onayını tekrar deneyin.

Beklenen: Bildirim tek başına erişim açmaz; tekrarda çift ödeme/hak oluşmaz.
İşletmen onayı etkinleştirilmemiş hak ve tek sefer gösterilen kod üretir.
Tekrar onay kodu geri getirmez; kayıp kod için açık yeniden üretim gerekir.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Panelde etkinleştirme kodu

Adımlar: İşletmen kodu güvenli özel kanaldan mevcut sahibe iletsin. Sahip panelde
kodu kullansın; ardından aynı kodu tekrar deneyin. Yetkisiz üyeyle ve başka
çalışma alanıyla kullanmayı deneyin. Süre/deneme sınırını sentetik alanda doğrulayın.

Beklenen: Yalnızca mevcut sahip panelden kullanabilir; ajan kod alamaz/kullanamaz.
Kod 8 alfanümerik karakter, 72 saat ve en çok 5 yanlış deneme ile sınırlıdır.
Tekrar kullanım reddedilir; kod URL, önbellek, depolama veya loga girmez.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Kalıcı açılış

Adımlar: Başarılı etkinleştirme sonrası sayfayı yenileyin, çıkış/giriş yapın ve
kontrollü servis yeniden başlatması gerçekleştirin. Hak ve ödeme durumunu okuyun.

Beklenen: Etkin erişim ve hakkın kaynağı korunur; otomatik süre sonu, abonelik veya
kredi bakiyesi yoktur. Strateji onayı, bağlayıcı doğrulaması ve ajan teması ayrıdır.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Yetkisiz erişimin reddi

Adımlar: Oturumsuz çağrı, başka alanın nesne kimliği, sınırlı kapsamlı anahtar,
kiracı oturumuyla işletmen API'si ve işletmen oturumuyla kiracı API'sini deneyin.

Beklenen: Yetki yükseltme ve alanlar arası veri erişimi reddedilir. İşletmen mesaj,
not, ham webhook gövdesi veya mühürlü kimlik bilgilerine erişemez.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Askıya alma ve yeniden açma

Adımlar: İşletmen gerekçe ile askıya alsın; strateji/işlemleri deneyin. Yeniden açın.
Etkinleştirmeyi gerekçe ile geri alın, aynı ödemeyi yeniden onaylayıp yeni kodu kullanın.

Beklenen: Askıda hak korunur, işlemler reddedilir; yeniden açma hakkı korur. Geri
alma ödeme beklemeye döndürür. Aynı ödeme yeni hak/kod üretir; eski hak ve denetim
geçmişi korunur, eski kod açılamaz. İade uygulama dışında yürütülür.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Panel/MCP kapıları

Adımlar: Ekip davetini kabul edin, dar kapsamlı ajan anahtarı üretin. Panel ve
kimliği doğrulanmış MCP üzerinden eş işlemleri karşılaştırın. Strateji onaysızken
yayınlamayı, kapsam dışı ekip yönetimini ve MCP ile etkinleştirmeyi deneyin.
İşletmen sağlık ekranını ve korumalı metrik erişimini denetlesin.

Beklenen: Panel/MCP aynı kuralları uygular; ödeme bildirimi eş davranır. Onaysız
strateji iş başlatamaz; kapsam dışı çağrı reddedilir. Etkinleştirme, platform ve
operasyon araçları MCP'de yoktur. Sağlık eski/bilinmeyen yedek durumunu açık gösterir.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Örnek bağlayıcı

Adımlar: Yeni ve onaylanmış sağlayıcı uygulamasıyla sahibi tarafından izin verilen
örnek hesabı bağlayın; hesap, kapsam, callback ve webhook eşleşmesini doğrulayın.
Sentetik mesaj → kişi → ajan yanıtı → yayın → ölçüm akışını çalıştırın; yeniden
bağlanma ve belirsiz gönderim sonucunu inceleyin. [Geçiş planını](v1-cutover.md) izleyin.

Beklenen: Doğrulama kanıta dayanır, tek gönderici vardır; belirsiz gönderim körlemesine
tekrarlanmaz. CI yalnızca kayıt tutan sahte sağlayıcı kullanır. Eksik uygulama onayı
canlı kabulü açık bırakır; eski v1 sırları/verileri içe aktarılmaz.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______

## Yedekten geri dönüş

Adımlar: [Geri dönüş prosedürü](backup-restore.md) ile aynı revizyon, veritabanı,
dosyalar ve kasadan alınan özgün anahtarın mantıksal ve PITR dönüşünü yalıtılmış
hedefte yapın. Yanlış anahtar/eksik dosya/yanlış şema reddini, sıradan rol ile RLS'yi,
ödeme/hak/mesaj/yayın/defter kanıtını ve belirsiz gönderimleri doğrulayın.

Beklenen: Sağlayıcı trafiği sıfırdır, işler kapalıdır; RPO 24 saat/RTO 1 saat
sağlanır. Yedek/WAL göstergeleri doğrulanmış başarıyı gösterir. Mesajlar, yayın
kanıtı ve defter süresiz; ham gövdeler/probe kayıtları 30 gün korunur. Günlük kontrol
ve aylık iki dönüş kaydedilir. Başarısız dönüş M4 kabulünü açık bırakır.

Kayıt: Tarih ______ / Revizyon ______ / Sonuç ______
