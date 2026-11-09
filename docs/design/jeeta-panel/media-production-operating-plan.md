# Jeeta: uçtan uca medya üretimi ve yayın planı

Tarih: 9 Kasım 2026 · Durum: ürün ve uygulama önerisi; bu belge yeni bir özellik yayını değildir.

## 1. Hedef ve temel karar

İşletme bir hedef, bir yayın zamanı veya bir materyal seti verir. Jeeta bunları üretim işine dönüştürür; uygun materyali bulur, eksikleri ister, kurgular, düzenler, kanal çıktılarını hazırlar, işletmenin yayın politikasına göre kontrol eder ve zamanında yayınlar. Sonuçlar sonraki üretim kararlarına geri döner.

Merkezde **üretim çalışma alanı** bulunur. Bir çalışma alanı tek bir içerik fikrini, çekimi veya küçük kampanyayı taşır; birden fazla paylaşım çıkarabilir. Örneğin “yeni ürün tanıtımı” alanından bir Reels, iki Story ve bir carousel hazırlanabilir. Büyük kampanya birden fazla üretim alanını bir araya getirir.

Mevcut `workspace_id` işletmenin veri ve yetki sınırı olarak kalır. Kullanıcının istediği içerik workspace'i bunun altında `production_project` olur. Böylece yeni bir içerik üretmek yeni bir işletme/üyelik oluşturmaz.

Üç farklı kavram ayrı tutulur:

| Kavram | Görevi |
| --- | --- |
| Materyal grubu | Kütüphanedeki ilgili fotoğraf, video ve sesleri bir araya getirir. |
| Üretim çalışma alanı | Hedefi, seçilen kaynakları, görevleri, kurguyu, revizyonları ve eksikleri taşır. |
| Kanal çıktısı | Belirli hesapta, belirli formatta ve zamanda yayınlanacak içeriktir. |

Bir materyal birden fazla grupta ve üretim alanında kullanılabilir. Dosya her kullanımda kopyalanmaz; kaynak sürümüne referans verilir. Kaynağın işletme sınırı değişmez.

## 2. Mevcut durum ve geliştirme boşluğu

9 Kasım staging sürümü `19093007` esas alınmıştır. Önceki materyal hedef belgesindeki “henüz staging'e alınmadı” notu tarihsel durumdur; yayın kanıtı `ops/release-dd66e8dc` dalındaki `ops/staging-19093007.md` dosyasındadır.

| Alan | Şu an var | Bu planla eklenecek |
| --- | --- | --- |
| Materyal | Yükleme, metadata, paylaşım izni, önizleme, serbest etiket/grup, elle düzeltme koruması | Büyük dosyada sürdürülebilir yükleme, klip/konuşma analizi, gelişmiş gruplar ve proje kaynak setleri |
| Ajan işleri | Kalıcı analiz ve türev üretim talepleri, claim/lease, MCP üzerinden teslim | Gerçek çalışan runner, bağımlı görevler, heartbeat, maliyet ve zaman yönetimi |
| Üretim | Edit/crop/poster işi; dış araçla oluşturulan çıktıyı kaynakla ilişkilendirme | Kurgu belgesi, gerçek render, video/ses işleme, sürümler ve kanal varyantları |
| Talep | Çekim/yükleme taleplerinin temeli | Projeye ve eksik sahneye bağlı, atanabilir ve teslimatı doğrulanan talepler |
| Yayın | Planlanan gönderiler, slotlar, politika, yayın denemeleri ve sonuç kaydı | Üretim bağımlılıklarından beslenen hazırlık takvimi ve proje görünümü |
| Otomasyon | Dış ajan `work.checkin` çağırırsa iş bulur | Sürekli çalışan ve gözlemlenen yürütücü; yalnızca MCP bağlamak yeterli değildir |

Mevcut üretim isteği insan tarafından açılıyor; API 1–5 kaynak kabul ediyor, panel tek materyalden başlatıyor. Bu, çok klipli bir kurgu alanı değildir. Ajanın yeni alt görev/talep açabilmesi ve geniş kaynak setleri için ayrı sözleşmeler gerekir.

Mevcut türev tesliminde paylaşım izni sıfırlanıyor. Tam otonom yayın için bu davranışın yerine geçecek açık bir işletme politikası tasarlanmalıdır; ajan kendi çıktısına kendiliğinden izin veremez.

TikTok mevcut kodda insanın kullandığı paylaşım ekranına bağlıdır. Kanal/format desteği güncel API, hesap yetkisi ve çalışan adaptör üzerinden doğrulanmadan bütün kanallara otomatik yayın sözü verilmez.

## 3. Kullanıcının yaşayacağı akış

### İki giriş, tek üretim süreci

**Materyalden başlama:** Dosyaları yükle → sistem analiz eder ve gruplar → uygun mevcut üretim alanına ekleme veya yeni içerik önerisi sunar → etkin otomasyon politikasına göre üretim başlar.

**Plandan başlama:** “Cuma 19.00'da yeni ürünü tanıt” → hedef, hesap ve format belirlenir → takvimde hedef yer ayrılır → kütüphaneden kaynaklar bulunur → eksik kaynaklar istenir → üretim başlar.

Takvimde yer ayrılması, içeriğin yayına hazır olması anlamına gelmez. Kullanıcı “planlandı, iki çekim eksik” durumunu açıkça görür.

Sistem her yükleme için ayrı bir proje açmaz. Etkin plan, konu ve mevcut açık projelerle eşleştirir; ilgisiz materyal kütüphanede kalabilir. Yeni projeler kullanıcı isteğiyle veya açıkça etkinleştirilmiş içerik üretim politikasıyla oluşturulur.

### Örnek uçtan uca senaryo

1. İşletme altı fotoğraf ve üç video yükler; “yeni ürün tanıtımı” hedefi ve cuma 19.00 yayın zamanı verir.
2. Sistem dosyaları analiz eder, tekrarları işaretler, kullanılabilir bölümleri çıkarır ve ilgili materyalleri aynı üretim alanında toplar.
3. Bir Reels ve iki Story önerir. Her biri için hedef hesap, mesaj, CTA, süre, format ve hazırlık son tarihi belirlenir.
4. Ajan açılış sahnesi, ürün detayı ve kapanıştan oluşan bir kurgu hazırlar. Ürün detayının eksik olduğunu görür.
5. “Ürünü dikey, sabit ve yakın planda 5–8 saniye çek” talebi oluşturur; teslim tarihi ve bağlanacağı sahne görünür.
6. Bu sırada metin, kapak ve mevcut kliplerin düzenlemesi devam eder. Eksik tek sahne bütün işleri durdurmaz.
7. Kullanıcı talebin içinden yeni videoyu yükler. Sistem uygunluğunu kontrol eder, eksikliği kapatır ve bağlı sahnenin üretimini sürdürür.
8. Önizleme üzerinde kullanıcı “ilk sahneyi kısalt, müziği azalt” der. Yeni sürüm oluşur; önceki sürüm korunur.
9. Kanal varyantları, altyazı, kapak ve paylaşım metni hazırlanır; teknik ve içerik kontrollerinden geçer.
10. Yayın politikası izin veriyorsa otomatik hazır olur; inceleme gerekiyorsa kullanıcıya tek bir karar kartı gelir.
11. Saatinde her uygun kanal çıktısı ayrı yayınlanır. Dış platformdan sonuç doğrulanınca yayın bağlantısı kaydedilir.
12. Sonuçlar aynı alana döner: izlenme, etkileşim ve mevcutsa tıklama/dönüşüm. Bir sonraki içerik için öneri üretilir.

Bu bir örnek akıştır; örnekteki zaman ve çekim talebi gerçek bir yayın emri değildir.

## 4. Üretim çalışma alanının içeriği ve UX

Üst bölümde yalnız şu bilgiler görünür: **hedef, durum, sonraki iş, sorumlu, en yakın yayın zamanı**. Birincil düğme duruma göre değişir: “Materyal ekle”, “Eksikleri tamamla”, “Önizlemeyi incele”, “Devam et” veya “Yayın planını aç”.

| Görünüm | Ana içerik | İlk açılışta gösterilmeyecek ayrıntı |
| --- | --- | --- |
| Özet | Kısa brief, çıktılar, engeller, sonraki karar | Tam ajan günlüğü, teknik metadata |
| Materyaller | Kullanılan/önerilen/eksik kaynaklar, çekim grupları | Bütün işletme kütüphanesi ve her dosyanın tüm etiketleri |
| Üretim | Büyük önizleme, sahne kartları veya zaman çizelgesi, düzenleme talimatı | Bütün gelişmiş render parametreleri |
| Yayınlar | Kanal varyantları, metin, kontrol, onay ve takvim | Teknik sağlayıcı yanıtları |

Sürümler, yorumlar ve işlem geçmişi gerektiğinde açılan yan panelde bulunur. Performans, yayınlanan çıktının detayında görünür; ayrı bir zorunlu adım oluşturmaz.

Stüdyo girişinde “Benden beklenenler”, “Üretilenler” ve “Yaklaşan yayınlar” kısa listeleri bulunur. Filtreler kampanya, konu, kanal ve durum üzerinden çalışır. Her şeyi tek ekranda gösteren uzun form kullanılmaz.

Masaüstünde önizleme ile düzenleme yan yana; mobilde önizleme ve sıradaki işlem önde olur. Mobil ilk sürüm yükleme, çekim talepleri, yorum ve incelemeyi tamamlayabilir. Ayrıntılı çok kanallı zaman çizelgesi masaüstünde önceliklidir. Klavye, odak, altyazı, okunabilir kontrast ve yükleme/boş/hata durumları tasarımın parçasıdır.

Görsel zenginlik gerçek materyal küçük resimleri, video kareleri, storyboard, dalga biçimi ve kanal önizlemelerinden gelir. Süreci açıklamayan dekoratif kartlar ekranı doldurmaz.

## 5. Modüller ve sorumlulukları

| Modül | Temel sorumluluk | Somut çıktı / tamamlanma ölçütü |
| --- | --- | --- |
| Marka ve içerik brief'i | Hedef, kitle, mesaj, dil, ton, CTA, doğru ürün bilgisi, görsel kurallar | Sürümlü brief; varsayım ile doğrulanmış bilginin ayrılması |
| İçeri alma | Fotoğraf/video/ses yükleme, kaldığı yerden devam, dosya doğrulama, metadata, önizleme | Yeniden yüklemeden sürdürülebilen, sağlıklı ve izlenebilir dosya |
| Materyal zekâsı | İçerik, kalite, OCR, konuşma dökümü, sahne ve kullanılabilir klip analizi | Zaman kodlu bulgular, kaynak ve güven düzeyi; insan düzeltmesi korunur |
| Kütüphane ve gruplar | İşletmeye özgü etiketler, koleksiyonlar, akıllı gruplar, tekrar ve kullanım geçmişi | Grupla/birleştir/ayır; bir dosyanın farklı işlerde tekrar kullanılabilmesi |
| Planlama ve prodüksiyon | Hedeften çıktı listesi, görevler, kaynak ihtiyacı, süre ve maliyet çıkarma | Bağımlılıkları ve teslim tarihleri olan uygulanabilir üretim planı |
| Materyal talepleri | Eksik çekim, ses, logo, ürün bilgisi veya izin belgesi isteme | Sorumlusu, açıklaması, örneği, son tarihi ve teslim kontrolü olan talep |
| Görsel üretim | Kırpma, yeniden boyutlandırma, düzenleme, afiş/kapak, kompozisyon | Yeni, sürümlü ve kaynakları belli görsel dosya |
| Video ve ses üretimi | Klip seçimi, kesme/birleştirme, ses seviyesi, altyazı, kapak, render | Oynatılabilir gerçek çıktı; önizleme ile finalin aynı kurguya dayanması |
| İnceleme ve revizyon | Zaman kodlu yorum, sürüm karşılaştırma, insan düzenlemesi, inceleme kararları | Kararın belirli çıktı sürümüne ve kapsamına bağlı olması |
| Kanal paketleme | Görsel/video varyantı, açıklama, kapak, alt metin, etiket ve gerekli platform seçimleri | Her hesap/format için teknik olarak uygun yayın paketi |
| Yayın operasyonu | Zamanlama, bağlantı kontrolü, gönderim, sonuç doğrulama, tekrar deneme | Gerçek platform kimliği ve yayın kaydı; çift paylaşımın önlenmesi |
| Ölçüm ve öğrenme | Mevcut metrikleri toplama, hedeflerle karşılaştırma, sonraki öneriler | Eksik veriyi sıfır saymadan, öneriyi kanıtından ayıran değerlendirme |

### Materyal zekâsının sınırları

- Yükleme tarihi, çekim tarihi ve olay tarihi ayrı alanlardır. Görüntü benzerliği gerçek bir etkinliğin kanıtı sayılmaz.
- Aynı dosya hash ile bulunur; benzer kareler ayrı değerlendirilir. Benzer diye farklı çekimler silinmez.
- Video analizinde hangi sahne/kare/ses aralığının incelendiği kaydedilir. Örneklenen birkaç kareden “videonun tamamı incelendi” sonucu çıkarılmaz.
- Otomatik gruplar “ürün”, “mekân”, “çekim serisi”, “konu” gibi farklı boyutlar taşıyabilir. İşletmeye özel sabit bir marka sözlüğü herkese uygulanmaz.
- İnsan bir materyali gruptan çıkardığında veya etiketini düzelttiğinde aynı analiz bu kararı sessizce geri almaz.

## 6. Kurgu ve edit modeli

Kurgu, sohbet geçmişine bırakılmayan **sürümlü bir üretim belgesi** olmalıdır. İlk sürüm sahne kartlarıyla yönetilebilir; ayrıntılı zaman çizelgesi bunun üzerine kurulur.

Video kurgusu en az şunları taşır: kaynak dosya/sürüm, giriş-çıkış zamanları, sahne sırası, kadraj, metin katmanı, altyazı zamanları, ses/müzik, ses seviyesi, geçiş, çıktı oranı ve hedef süre. Görsel kompozisyon da kaynaklar, katmanlar, yerleşim, metin, marka şablonu ve çıktı boyutunu taşır.

“İlk sahneyi iki saniye kısalt” talimatı bu belge üzerinde doğrulanmış bir değişiklik önerisine dönüşür. Kullanıcı değişikliği önizlemede görür; kaydedilen insan düzenlemeleri sonraki ajan çalışmasına girdi olur. Sohbet mesajı tek başına yayınlanacak dosya kabul edilmez.

Her sürüm için kaynak sürümleri, kurgu sürümü, kullanılan model/araç, üretim ayarları ve çıktı hash'i kaydedilir. Hızlı önizleme için düşük çözünürlüklü proxy; yayın için aynı kurgudan final render kullanılır. Orijinaller korunur.

Köken modeli gerçek çekim, gerçek çekimin düzenlenmiş türevi, üretilmiş medya ve karma kompozisyonu ayırt etmelidir. Fotoğrafın kırpılması onun gerçek olayla ilişkisini yok etmez; yeni nesne/sahne üretimi de gerçek çekilmiş gibi sunulmaz. Mevcut `real|ai_generated` ayrımı bu daha ayrıntılı kaynak ilişkisiyle uyumlu genişletilir.

Temel video hattı: metadata/proxy → sahne ve konuşma analizi → storyboard → kurgu belgesi → önizleme → düzeltme → final render → kanal kontrolü. FFmpeg benzeri bir medya işleyici kesme, birleştirme, altyazı ve ses işlemlerini yürütür; ajan kurguyu planlar. Serbest model metni doğrudan sunucuda shell komutu olarak çalıştırılmaz.

Sıfırdan video üretimi, dublaj, gelişmiş görüntü temizleme ve otomatik yaratıcı geçişler ayrı araç yetenekleridir. Temel kurgu hattı bunlar olmadan da çalışır. Seçilen sağlayıcı, bütçe, lisans ve kalite doğrulanınca aynı iş sözleşmesine eklenir.

## 7. Eksik materyal ve devam etme döngüsü

Bir talep yalnız “video yükle” demez: ihtiyaç duyulan sahneyi, neden gerektiğini, önerilen çekim yönünü/süresini, kalite beklentisini, sorumluyu ve son tarihi gösterir. Dosya dışında ürün fiyatı, kampanya bitiş tarihi, konuşma metni veya kullanım izni de talep edilebilir.

Kullanıcı dört yoldan ilerleyebilir: yeni materyal yükle, kütüphaneden alternatif seç, üretim aracından yeni içerik iste veya brief'i/sahneyi değiştir. İzin gerektiren gerçek kişi/ürün beyanı, model üretimiyle otomatik doğru hale getirilmez.

Teslimat talebe bağlanır ve gerçekten ihtiyacı karşılayıp karşılamadığı kontrol edilir. “Bir dosya geldi” diye her talep tamamlanmış sayılmaz. Reddedilen teslimatın nedeni ve düzeltme yolu görünür.

Gerekirse yalnız bu talebe dosya eklemeye yetkili, süreli bir yükleme bağlantısı oluşturulur. Başka projeler veya işletme kütüphanesi paylaşılmaz. Bildirim kanalları kullanıcı tarafından yapılandırılır; uygulama içi görev listesi ilk sürümde yeterlidir.

“Devam et” mevcut sürümden ilerler. Yeni kaynak, brief değişikliği veya insan düzeltmesi yalnız etkilenen görevleri geçersiz kılar. Metin üretimi ilerleyebilirken eksik çekimi bekleyen render görevleri durur. İptal/duraklatma, henüz gönderilmemiş yayınlara kadar yayılır.

## 8. Gerçek otomasyon ve ajanların çalışma biçimi

Roller: planlayıcı/prodüktör, materyal analisti, editör, metin yazarı, kalite kontrol, yayın operatörü ve performans analisti. Bunlar yedi ayrı sürekli sohbet zorunluluğu değildir; tek bir yürütücü uygun model ve aracı işe göre seçebilir.

Kalıcı süreç yöneticisi görev bağımlılıklarını tutar. Örnek: final render hem geçerli kurguya hem bütün zorunlu kaynaklara bağlıdır; kapak hazırlığı eksik ses dosyasını beklemez. Her işin girdisi, beklenen çıktısı, kabul ölçütü, son tarihi ve maliyet sınırı vardır.

Gerekli yürütme altyapısı:

1. Veritabanına kaydedilen iş ile çalıştırma bildirimi arasında kayıp olmaması için transaction/outbox veya eşdeğer dayanıklı mekanizma.
2. Gerçek ajan/medya worker süreci; periyodik kontrol ve gerekiyorsa hızlı uyandırma. “Bağlı” ve “şu anda çalışabilir” ayrı sağlık bilgileri.
3. Claim, süreli sahiplik, uzun işler için heartbeat, kaldığı yerden devam, kontrollü tekrar deneme ve sonuç teslimi.
4. Kaynak/sürüm/işlem üzerinden tekilleştirme; eski görevin yeni insan düzenlemesini ezmesini engelleyen revizyon kontrolü.
5. Harici render/üretim işinin sağlayıcı kimliğini saklama; yanıt kaybında körlemesine ikinci ücretli üretim başlatmama.
6. Workspace/proje bütçesi, ön maliyet tahmini, ayrılmış harcama, gerçekleşen maliyet, sınırlı eşzamanlılık ve iptal davranışı.
7. Kimlik bilgileri modele verilmeden yetkili araç kullanımı; yüklenen içerikteki talimatların sistem yetkisine dönüşmemesi.
8. Log, olay geçmişi ve hata nedeni. “Ajan çevrimdışı”, “render sırada”, “kaynak bekleniyor” açıkça ayrılır.

MCP mevcut araç yüzeyi olarak korunur. Yeni runner bu yüzeye bağlanır; panelden bir düğmeye basmak çalışmayan bir ajanı çalışıyormuş gibi göstermemelidir.

## 9. Kontrol, izin ve otonomi

Hedef, işletmenin belirlediği sınırlar içinde **otomatik üretim ve zamanında yayın**dır. Her gönderi için zorunlu insan onayı eklenmez; mevcut yayın politikası korunur ve yeni üretim türlerine açıkça genişletilir.

İşletme üç çalışma biçiminden birini kullanabilir: yalnız öner, üret ve incelemeye getir, kurallara uygun olanı otomatik üret/yayınla. Politikalar kanal, format, kampanya ve üretim türüne göre daraltılabilir. İlk entegrasyonun testleri gözetimli yapılır; bu ürünün kalıcı varsayılanını değiştirmez.

Materyal kullanım izni, türevin kullanım izni ve gönderinin yayın yetkisi ayrı kavramlardır. Tam otonomi için türevlere hangi şartlarda izin verileceği işletme tarafından açıkça tanımlanır. Kaynak haklarını genişleten veya izin kısıtını kaldıran bir AI kararı kabul edilmez.

Kontrol noktaları: kaynak/kişi/müzik hakları ve süreleri, doğrulanmamış ticari bilgi, marka kuralları, teknik dosya şartları, altyazı/okunabilirlik, yanlış hesap, eskimiş kampanya ve bütçe. Gerekli bilgi eksikse yalnız ilgili çıktı engellenir; kullanıcıya sebep ve çözüm gösterilir.

Bir inceleme kararı belirli medya, metin, kanal hesabı ve kapsamla eşleşir. İlgili içerik değişince karar geçersizleşir. Yayın zamanındaki değişiklik kampanya süresini veya izinleri etkiliyorsa yeniden kontrol gerekir.

## 10. Takvim ve yayın operasyonu

Yayın zamanından geriye doğru üretim, materyal teslimi, render ve gerekiyorsa inceleme son tarihleri hesaplanır. Sabit “iki gün önce” kuralı yerine iş süresi, kuyruk ve yeniden üretim payı kullanılır. Kullanıcıya gecikme riski zamanında gösterilir.

Kanal başına çıktı kaydı ayrı ilerler: taslak → hazırlanıyor → gerekiyorsa inceleme → hazır → zamanlandı → gönderiliyor → doğrulanıyor → yayınlandı. Bekleme nedeni, başarısızlık, iptal ve zamanı geçme ayrıca tutulur. Proje durumu bu çıktılardan türetilir; bir kanalın başarısı hepsini “yayınlandı” yapmaz.

Planlanan zaman workspace'in saat dilimiyle girilir; an UTC olarak ve yerel zaman/saat dilimi bilgisiyle saklanır. Saat dilimi değişimi, yaz/kış saati ve sessiz saatler için açık davranış bulunur. Bu planın kullanıcı örnekleri Europe/Istanbul kullanır.

Yayın öncesinde doğru hesap bağlantısı, içerik sürümü, kaynak izinleri, platform format şartları, günlük sınırlar ve yayın penceresi yeniden kontrol edilir. Yayın denemesi bu içeriğin değişmez kopyasını kullanır.

Platformdan yanıt gelmezse durum “sonucu doğrulanıyor” olur; hemen yeniden gönderilip çift paylaşım oluşturulmaz. Kesin başarısızlık ile belirsiz sonuç ayrılır. Kanal desteği uygunsa sağlayıcı durumu sorgulanır. Kısmi başarısızlıkta yalnız başarısız kanal tekrar ele alınır.

Yayın saati kaçarsa işletme politikasına göre süreli gecikme, başka zamana öneri veya iptal uygulanır. Bitmiş kampanya sessizce daha sonra yayınlanmaz. İnsan adımı zorunlu kanalda görev önceden görünür; otomatik tamamlanmış sayılmaz.

Yayın sonrası düzenleme/silme ayrı dış platform işlemidir. Kaynağı kütüphaneden kaldırmak, daha önce yayınlanmış gönderiyi otomatik silmiş sayılmaz; ilgili yayınlar için müdahale durumu kaydedilir.

## 11. Önerilen veri modeli ve mevcut sisteme bağlanma

| Kayıt | Taşıdığı bilgi |
| --- | --- |
| `ProductionProject` | İşletme, kampanya bağlantısı, brief sürümü, sorumlu, hedefler, bütçe ve otomasyon politikası |
| `AssetCollection` / üyelik | Dinamik gruplar, elle/otomatik üyelik ve manuel hariç tutma |
| `ProjectSource` | Projeye seçilen materyal, sabit kaynak sürümü, rol ve zaman aralığı |
| `Deliverable` | Hedef hesap/format, mesaj, planlanan zaman, hazırlık ve yayın durumu |
| `CompositionRevision` | Görsel yerleşim veya video/ses kurgu belgesi ve revizyon geçmişi |
| `ProductionTask` / bağımlılık | İş türü, girdiler, kabul ölçütü, ön koşullar, lease, checkpoint ve maliyet |
| `MaterialRequest` / teslimat | Eksik ihtiyaç, sorumlu, süre, sunulan dosya/bilgi ve değerlendirme |
| `RenderArtifact` | Önizleme/final dosya, kurgu ve kaynak bağı, teknik analiz, araç/sağlayıcı bilgisi |
| `ReviewDecision` / yorum | Hangi çıktı sürümüne, hesaba ve kapsama ilişkin karar verildiği |
| `Publication` / deneme | Mevcut yayın modeline bağlı dış kimlik, sonuç, hata ve belirsizlik |
| `PerformanceSnapshot` | Sağlayıcının sunduğu metrikler, ölçüm zamanı ve veri kapsamı |

Mevcut materyal, FileStore, izin, posting policy, slot ve yayın denemesi kayıtları tekrar oluşturulmaz. Yeni proje katmanı bunları bağlar. `material_productions` ilk üretim alt görevlerine köprü olur; bütün iş akışı tek bir `instructions` alanına sığdırılmaz.

Her kanal çıktısı mevcut planlanan gönderi/slot ile açık ilişki kurar; zaman ve yayın durumunun iki bağımsız kopyası tutulmaz. Eski olay temelli planlayıcı ile yeni proje planlayıcısı aynı içerik işini iki kez açmamalıdır: ortak iş kimliği, takvim rezervasyonu ve aşamalı sahiplik devri gerekir.

Bütün yeni tablolar işletme sınırını ve mevcut yetkileri uygular. Analiz yapan ajan yayın yetkisi kazanmaz. API/MCP/panel davranışları aynı usecase kurallarını kullanır. Yükleme dosya boyutu, süre ve kaynak sayısı sınırları ürün paketine göre açıkça belirlenir.

Ham dosyalar, önizlemeler ve final çıktılar için ayrı saklama politikaları gerekir. Render önbelleği temizlenebilir; aktif projelerin kaynakları ve referans verilen final dosyaları kullanıcıdan habersiz temizlenmez. Geçici erişim bağlantılarının süresi, indirilen dış kopyalar ve silmenin yayınlanmış içerik üzerindeki sınırları açıkça ele alınır.

Eski materyaller kütüphanede kalır; hepsine otomatik boş proje açılmaz. Eski planlanmış/yayınlanmış gönderiler çalışmayı sürdürür. Eski bir gönderiyi yeni projeye bağlamak yayın kimliğini veya geçmişini değiştirmez. Migration ve feature flag'ler aşamalı devreye alma ve geri dönüş sınırlarıyla tasarlanır.

## 12. Baştan ele alınacak aksaklıklar

| Durum | Beklenen davranış |
| --- | --- |
| Yükleme kesildi | Kaldığı yerden devam; yarım dosya üretime girmez. |
| Aynı dosya yeniden geldi | Yeni üretim/ücretli analiz gerekip gerekmediği sürüm ve hash üzerinden belirlenir. |
| Yeni dosya birden çok projeye uyuyor | Dosya ortak kullanılabilir; özgün olay iddiası otomatik taşınmaz. |
| Eksik veya düşük kaliteli çekim | Somut talep/alternatif; bağımsız işler devam eder. |
| Ajan çevrimdışı | İş bekler, son çalışma/yeniden deneme bilgisi görünür; sahte ilerleme yüzdesi verilmez. |
| Worker/render yarıda durdu | Lease sona erer, checkpoint/sağlayıcı işi incelenerek sürdürülür. |
| Kullanıcı kurgu sırasında edit yaptı | Eski ajan sonucu yeni sürümü ezmez; yalnız bağlı işler tekrar üretilir. |
| Kaynak izni kalktı veya silindi | Bağlı bekleyen çıktılar tekrar değerlendirilir, uygun olmayan yayın engellenir. |
| Üretim bütçesi doldu | Yeni ücretli işler durur; kalan bütçe ve alternatif kullanıcıya sunulur. |
| Ürün bilgisi/fiyat değişti | İlgili metin ve görsel varyantlar yeniden hazırlanır; eski onaylar kontrol edilir. |
| Kanal bağlantısı koptu | Yeniden bağlama görevi; diğer kanallar bağımsız devam edebilir. |
| Platform kabul etti ama yanıt kayboldu | Sonuç sorgulanır; körlemesine ikinci paylaşım yapılmaz. |
| Yayın saati/kampanya süresi geçti | Açık gecikme/iptal politikası; otomatik geçmiş kampanya yayını yok. |
| Paylaşımların biri başarısız | Çıktı bazında durum ve tekrar; başarılı olan yeniden gönderilmez. |
| Yayınlanmış içerikte hata bulundu | Düzeltme/geri çekme görevi; dış platformdaki gerçek sonuç ayrıca doğrulanır. |
| Metrik sağlayıcıda yok | “Veri yok” gösterilir; uydurma performans veya sıfır sonucu üretilmez. |

## 13. Uygulama sırası: önce çalışan bir tam zincir

Takvim tahmini, araç/hesap erişimi ve ilk gerçek render/yayın denemesi görülmeden kesinleştirilmez. Aşağıdaki sıra bağımlılıklara ve somut çıkış ölçütlerine dayanır.

| Aşama | Kapsam | Bitmiş sayılma ölçütü |
| --- | --- | --- |
| 0 — Sözleşmeler ve yetenek doğrulaması | Proje/çıktı modeli, mevcut kayıtlarla köprü, otonomi/izin kuralları, kanal format matrisi, runner ve medya araçlarının seçimi | Bir test dosyası gerçekten analiz edilir; desteklenen bir hesap/formatta gönderim yolu, maliyet ve erişim doğrulanır. |
| 1 — İlk tam zincir | Bir üretim alanı, fotoğraf yükleme, gerçek ajan düzenlemesi, önizleme/revizyon, bir kanal çıktısı, zamanlama ve sonuç kaydı | Test hesabında yüklemeden doğrulanmış yayına kadar gerçek uçtan uca akış; yeniden başlatma ve çift gönderim senaryosu dahil. |
| 2 — Materyal operasyonu | Dinamik koleksiyonlar, proje kaynakları, otomatik eşleştirme, eksik materyal talepleri ve teslimatla devam | Eksik çekim isteyen iş, yükleme sonrası doğru adımdan kendiliğinden sürer; manuel sınıflandırma korunur. |
| 3 — Gerçek video/ses hattı | Proxy, konuşma/sahne analizi, sahne kartları, kesme/birleştirme, altyazı, ses seviyesi, kapak ve final render | Birden çok gerçek klipten oynatılabilir video; zaman kodlu düzeltme sonrası yeni render ve uygun kanalda doğrulanmış yayın. |
| 4 — Çoklu çıktı ve ekip | Aynı projeden kanal varyantları, sürüm karşılaştırma, görev sahipliği, inceleme politikaları ve hazırlık takvimi | Birden fazla çıktı bağımsız yayınlanır; birinin eksikliği/hatası diğerlerini bozmaz, değişen sürüm eski kararla yayınlanamaz. |
| 5 — Ölçüm ve ölçek | Performans geri beslemesi, yeniden kullanım önerileri, kapasite/maliyet optimizasyonu, gelişmiş edit ve isteğe bağlı video üretim araçları | Yayınların metrikleri projeye bağlanır; üretim maliyeti ve kuyruk sağlığı ölçülür; önerilerin etkisi izlenebilir. |

İzin kontrolleri, sürüm bağı, iş kalıcılığı, temel maliyet sınırı ve yayın tekilleştirmesi ilk tam zincirin parçasıdır; son aşamaya bırakılmaz. Her aşama staging'de gerçek araçlarla doğrulanır. Canlıya geçiş ayrı yayın kararıdır.

## 14. Ürün başarı ölçütleri ve nihai kabul

Ölçülecekler: yüklemeden ilk önizlemeye süre, müdahalesiz tamamlanan işler, kullanıcıdan istenen karar sayısı, materyal talebinin tamamlanma süresi, zamanında yayın oranı, çıktı başına maliyet, başarısız/tekrar üretilen render oranı, belirsiz/çift yayın sayısı, tekrar kullanılan materyal oranı ve hedefe ilişkin gerçek kanal metrikleri. Sayısal hedefler ilk pilot ölçümünden sonra belirlenir.

“Uçtan uca medya operasyonu” ancak şu senaryolar gerçekten çalışınca tamamlanmış sayılır:

- Kullanıcı dosya yükleyerek veya yayın hedefi vererek aynı üretim sürecini başlatabilir.
- Dosyalar anlamlı gruplara ve ilgili üretim alanlarına bağlanır; başka işletmenin verisi kullanılamaz.
- Ajan gerçek dosyayı analiz eder ve gerçek görsel/video çıktısı üretir.
- Eksik materyal istenir, doğru teslimatla süreç kaldığı yerden devam eder.
- Kullanıcı kurguya müdahale edebilir, önceki sürüme dönebilir ve değişikliğinin korunduğunu görür.
- Kanal çıktıları teknik, içerik ve izin kontrollerinden geçer; yayın yetkisi politika üzerinden belirlenir.
- Doğru zamanda doğru hesaba yayın yapılır; gerçek dış kimlik doğrulanır ve tekrar deneme çift paylaşım yaratmaz.
- Kesinti, kaynak değişikliği, bütçe bitişi ve platform hataları veri kaybı veya sahte başarı üretmez.
- Sonuçlar aynı çalışma alanında görülür ve sonraki planı besler.

Panelin güzel görünmesi, işin kuyruğa yazılması veya bir modelin “tamamladım” demesi tek başına bu kabul ölçütlerini karşılamaz.
