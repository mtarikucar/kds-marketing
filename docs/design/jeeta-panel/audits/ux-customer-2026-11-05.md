> Agent review snapshot. Final integrated verification, translation status and limitations are recorded in [the consolidated review](../ux-review-2026-11-05.md). References to temporary files are session artifacts. Earlier cross-family type errors in these notes were resolved before the final build.

# Müşteri ailesi UX gözden geçirmesi

Kapsam: Rust panelde Inbox*, PeoplePage, CallsPage, CallDetail ve CallsPolicy. Önceki84e85ed8 çağrı kuyrukları, arama, yön filtresi,10'lu sayfalama, yetki kontrolleri ve çağrı ayarı taslağı koruması başlangıç davranışı olarak korunuyor.

## Route ve sekme incelemesi

| Route / alan | Ana iş ve bulgu | Bu turdaki karar |
| --- | --- | --- |
| `/inbox` / kuyruklar | Konuşma seçme ve kişi bulma. Boş kuyruk yalnızca durum söylüyor; seçimsiz ana alan çok kısa yönerge içeriyor. | Kuyruk değiştirme/kişi aramasını anlatan boş durum ve ilk adım metni. |
| `/inbox` / onay kuyruğu | Bekleyen yanıt bağlantıları ve ayrı boş durum anlaşılır; hata/yeniden dene görünür. | Korundu. |
| `/inbox?person=…` | Kişinin konuşmalarını açmak. Telefonda kuyruk tarayıcısı seçilen kişinin önünde uzun yer tutuyor. | Seçim varken mobil tarayıcı başlangıçta kapalı; tekrar açılabilir ve arama taslağı korunur. |
| `/inbox?task=…` | Görevin doğru yolculuğuna ulaşma. Bulunamayan görev ve okuma hatası ayrı. | Aynı mobil tarayıcı kısaltması; gerçek görev ve tamamlama görünür kalır. |
| `/inbox/:conversationId` / özel konuşma | Yanıt yazma birincil iş. Masaüstü birleşik çalışma yüzeyi doğru; telefon kuyruğu konuşmayı aşağı itiyor. | Masaüstü rail değişmedi. Telefonda yalnızca kuyruk/kişi araması açıcı satırı kalır; mesaj ve yanıt gizlenmez. |
| `/inbox/:conversationId` / yorum-soru | Hedef öğe, görünürlük, karakter sınırı, moderasyon ve onay taslağına özel eylemler mevcut. Mesaj listesi kaydırmalı. | Var olan hedefli akış ve güvenli silme doğrulaması korundu. |
| Yolculuk / olay kaydı | Kişiyle konuşurken olay kaydı formu her zaman açık; takip görevleriyle yarışıyor. | Olay kaydı isteğe bağlı açılan bölüme taşındı. Kapatmak alanları sıfırlamaz. |
| Yolculuk / görevler | Mevcut görev ve Tamamla ana iştir; yeni görev formu boşken de üç alan gösteriyor. | Mevcut işler/tamamlama açık; yeni görev formu Görev ekle altında. Taslak koruması doğrulanıyor. |
| Yolculuk / notlar | Mevcut bağlam okunmalı; yeni not alanı sürekli yer kaplıyor. | Notlar açık; yeni not formu Not ekle altında. |
| Yolculuk / zaman çizelgesi ve sahip | Durum, sorumlu ve geçmiş olaylar gerçek takip bağlamı sunuyor. | Görünür kaldı; yeniden açma yetkisi ve tarihsel etiketler korundu. |
| Yolculuk / teklifler | Teklif geçmişi ve gönderme formu zaten kullanıcı açtığında gösteriliyor. Teslim belirsizliği ayrı uyarı. | Mevcut progressive disclosure, tutar/hassasiyet ve teslim davranışı korundu. |
| Yolculuk / randevular | Randevu açıldığında geçmiş, iç kayıt açıklaması ve takvim kontrolü sınırı görünür. | Korundu; rezervasyon ve bildirim sonucu ayrımı değişmedi. |
| İzinler / engeller / veri silme | İzinler zaten ikincil disclosure içinde; kayıtlı izinler ve engeller ayrı. Silme geri alınamaz açıklama+tam ifade gerektiriyor. | Bu tur ek iç sınıflandırma eklenmedi; mevcut güvenlik ve hata davranışı korundu. |
| `/inbox/merges` | Kaynak/hedef seçme, birleştirme kararı ve tam ifadeli geri alma. Gerçek kişi okuma hatası görünür. | Ayrı route eylemleri ve doğrulamaları korur. Konuşma içindeki özet başlık altında açılır; görevleri aşağı iten iki tam kart başlangıçta gösterilmez. |
| `/inbox/commissions` | Durum/alacaklı filtresi, sıradaki geçerli ödeme eylemi. Oran formu kısa ve ayrı margin içinde. | Korundu; ödenemez alacaklısız kayıt açıklaması ve role göre salt okunur görünüm değişmedi. |
| `/people` / liste ve arama | Mevcut kişiler konuşma açar; arama boşluğu temizlenebilir, boş sonraki sayfa Önceki ile kurtarılır. İlk gerçek boşlukta devam eylemi yok. | Yetkili kullanıcıya `/capabilities` kanal kurulumu bağlantısı; yalnızca gerçek boş ilk sayfada112px marka rehberi. Yetkisizde kurulum eylemi yok. |
| `/calls` / Görüşmeler | Gerçek açık/sonuçsuz kuyrukları, yüklenen kayıt kapsamı, arama ve10'lu sayfalama önceki turda çözülmüş. |84e85ed8 aynen korundu. Filtrede ilk sayfa ve veri küçülmesinde geçerli sayfa testleri devam ediyor. |
| `/calls` / Arama ayarları | Ayrı yönetici sekmesi doğru; sekme açılınca üç uzun alan grubunun hepsi aynı anda görünüyor. | İlk karşılama/bildirim grubu açık; bekletme ifadeleri ve süre/aktarma grupları açılır. Taslaklar ve tek Kaydet sözleşmesi korunur. |
| `/calls/:callId` | Görüşme özeti, akış ve yetkili sonuç kaydı birbirinden ayrılıyor; gecikme ayrıntıları yalnızca varsa çıkıyor. | Ana sonuç formunu gizlememek için ek sekme eklenmedi. Mevcut maskeleme, izin ve hata davranışı korundu. |

## Somut değişiklikler

1. **Yönlendirilmiş giriş ve daha erken ana içerik:** seçilmiş kayıtta mobil kuyruk tarayıcısı kapalı başlar; masaüstü rail açık kalır. Boş kuyruk/seçimsiz görünüm sonraki adımı söyler. Gerçek boş kişi rehberinde yetkili kanal kurulum eylemi bulunur.
2. **Takip işi ve yeni kayıt ayrımı:** var olan görev/notlar ile Tamamla görünür, olay/yeni görev/yeni not formları ayrı açılır bölümlerdedir. Native details çocukları mount'ta tuttuğu için kapatma taslak silmez.
3. **Arama ayarında bir bölüm:** karşılama grubu başlangıçta açık, diğer iki grup isteğe bağlı. Form tek parça ve Kaydet bütün değerleri birlikte gönderir; gizlenen bölüm taslakları aynı state içinde kalır.

Yeni metinler TR/EN `/tmp/ux-customer-locales.json` içinde. Shared CSS, App, ui primitive'leri ve locale JSON dosyaları değiştirilmedi. Görsel yalnızca gerçek boş People ilk sayfasındadır; yoğun konuşmada görsel yok.

## Doğrulama

- İlgili11 test dosyası /78 test geçti: Inbox, commissions, erasure, public, compliance, offers, People, CallsWorkbench, CallsPage, CallDetail ve CallsPolicy. Tek worker kullanıldı.
- Yeni anlamlı regresyonlar: mevcut görev/tamamlama/yanıt görünürlüğü; ikincil formların başlangıçta kapalı olması; görev taslağının kapanıp açılınca korunması; kuyruk tarayıcısının aria durumu, arama taslağı ve seçim sonrası kapanması; ayar gruplarının başlangıç görünürlüğü/taslak koruması; boş People kurulum eyleminin yetkisi.
-10 route/durum/sekme1440×1100 ve390×844'te kontrol edildi: inbox giriş, seçili konuşma, seçili kişi, merges, commissions, dolu People, boş People, Calls görüşmeler, Calls ayarlar ve CallDetail.20 ekran görüntüsünde yatay taşma yok, tarayıcı runtime hatası yok.
- Gerçek tarayıcı ayrıca masaüstü kuyruğun görünür, mobil seçili kayıtta kapalı olduğunu; açılabildiğini; görev ve ayar taslağının kapanıp açılınca korunduğunu; boş People rehberinde yetkili kurulum bağlantısı ve112px görseli doğruladı.
- Gözle açılıp incelenen örnekler: seçili konuşma390/1440, Arama ayarları390, boş People1440. Birleştirme kartlarının görevleri aşağı ittiği ilk görüntüden sonra inline özet kapatıldı ve son görünüm yeniden doğrulandı.
- Kanıt: `/tmp/ux-customer-final-browser.log`, `/tmp/ux-customer-review.cjs`; görseller `/tmp/ux-customer-{inbox,conversation,person,merges,commissions,people,people-empty,calls,calls-settings,call-detail}-{1440,390}.png`.
- Tarayıcı kontrolü0 mutasyon yaptı: POST/PUT/DELETE yok. Testlerin gönderimleri yalnızca mockFetch üzerindeydi; üretim verisi veya gerçek outbound mesaj kullanılmadı.
- `git diff --check` temiz. Son tam TypeScript kontrolü müşteri ailesi dışında `src/pages/materials/MaterialEditor.test.tsx:39:78` hatası bildirdi (`string`→`never`); bu dosya değiştirilmedi ve root'a iletildi. Müşteri dosyaları için TS hatası bildirilmedi. Root entegrasyonu tam suite/build'in son durumunu sahiplenir.
