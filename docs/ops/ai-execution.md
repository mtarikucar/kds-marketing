# İş bazında yapay zekâ çalıştırma

Ayarlar → Yapay zekâ modelleri (`/settings/ai-models`) ekranında her maliyet kalemi etkin/pasif ve API/MCP/uygun işlerde Yerel olarak ayarlanır. Yalnızca `settings.manage` yetkili OWNER değiştirebilir; MANAGER okuyabilir. Ayarlar çalışma alanına özeldir; başka müşterinin seçimini değiştirmez.

- **API:** Çalışma alanının kendi Anthropic anahtarı varsa onu, yoksa platform anahtarını kullanır. Dış servislerin kendi anahtarları ayrı kalır.
- **MCP:** Kullanıcının Jeeta’ya bağladığı Claude istemcisi işi kendi modeliyle yapar. Bu seçim ücretli model API’sine otomatik dönmez. Claude aboneliği/kotası geçerlidir; bağlantı bir API anahtarı değildir ve sunucu kapalı istemciyi uyandıramaz.
- **Yerel:** Otomasyon metin sınıflandırması için çok dilli MiniLM, ses çözümleme için Whisper. Model API ücreti yoktur; sunucu, disk ve işlemci maliyeti vardır. Kurulum ve sınırlar: [Yerel model servisi](local-ai.md).

Görsel/video/ses üretimi, X paylaşımı ve platform web arama/okuma işlemleri dış servis kullanır. Claude bunları yönetse bile sağlayıcı ücreti devam ettiği için bu kalemlerde API seçeneği bulunur. Uygun olmayan işler yerel sınıflandırıcıya yönlendirilmez; örneğin marka güvenlik değerlendirmesi üretken modelde kalır.

## Mevcut ayarlarla ilişki

Eski kategori anahtarları korunur; kaydedilmiş iş bazındaki etkinlik tercihi kendi kategorisini geçersiz kılar. `Mevcut kural` yazan satır henüz yeni sağlayıcı seçimine sabitlenmemiştir. Eski genel `AUTO`/`MCP` kuralları gecikmeli API kullanımına izin verebilir. Açılır listeden API veya MCP seçip kaydetmek o iş için açık tercih oluşturur. MCP’yi açıkça seçmek eski bekleme süresi sonrasında API’ye geçişi kaldırır; kendi API anahtarı bulunması bunu değiştirmez.

Araştırma, strateji, panel asistanı ve komut işlemlerinde başlangıç maliyetiyle değerlendirme turları aynı çalıştırıcıyı kullanır. Birinin sağlayıcısını değiştirmek eşinin sağlayıcısını da günceller; tek kayıtta çelişen seçimler reddedilir. Etkinlik anahtarları ayrı kalır. Bir araştırma turunu kapatmak o turu içeren işi de durdurur.

MCP veya yerel model için model kredisi ayrılmaz. Hata iadesi seçimin o anki fiyatına değil, gerçekten ayrılmış kredi tutarına dayanır. Anthropic anahtarı getirmek fal/X/STT gibi platformun ödediği dış servis maliyetlerini ücretsiz yapmaz.

## Claude bağlantısı ve görevleri alma

Mevcut bağlantı ekranı `/settings/api-keys?tab=connector` adresindedir. Bağlantı durumundaki `Yakın zamanda MCP kullanılmış` sinyali geçmiş araç çağrılarını gösterir; aktif bir işçi garantisi değildir. Sürekli çalışma için kullanıcının istemcisi görevleri düzenli almalıdır.

- Müşteri yanıtları/takipleri: `jeeta.claim_reply_job`, mevcut mesaj gönderme araçları, ardından `jeeta.complete_reply_job`.
- Araştırma: mevcut araştırma talep/sonuç araçları.
- Diğer üretimler: `jeeta.claim_ai_task`, kendi modelinle dönen girdiyi değerlendir, `jeeta.complete_ai_task` ile yanıtı kaydet. Bu araçlar `settings.manage` kapsamı ister. Üretim yanıtındaki araç çağrılarını asistan ayrıca çalıştırmaz; asıl iş akışı kendi yetkileriyle uygular.

Araçlar ertelenmiş katalogdadır; gerektiğinde `jeeta.find_tools` ile bulunur. MCP istemcisi yoksa iş bekler. Kısa senkron bekleme süresini aşan istek `AI_MCP_WAITING` ile görünür; istemcinin tamamlamasından sonra aynı girdili işlem yeniden denenmelidir. Bu kuyruk uçtan uca sürekli çalışan bir Claude işçisi kurmaz.

Genel üretim sonuçları aynı işlem ve yetki bağlamında 30 dakika yeniden kullanılabilir. Bu süre içindeki çok turlu yeniden denemelerde tamamlanmış araçların kayıtlı sonuçları kullanılır. Araç çalışmış olabilirken sonuç kaydı kesinleşmemişse `AI_MCP_TOOL_UNCERTAIN` döner; süre dolması otomatik tekrara izin vermez. Operatör önce ilgili işlemin gerçekten uygulanıp uygulanmadığını incelemelidir. Bu koruma, farklı girdili yeni bir işlemin aynı dış etkiyi yapmasını önlemez.

MCP bekleyen çağrı analizleri aynı kayıt için önceden alınan transkripti yeniden kullanır. Araştırmaya devredilen strateji aksiyonları sonuç gelene kadar `RUNNING` kalır ve uygulanmış aksiyon sayısına girmez; aksiyon listesi okunurken kuyruk sonucu ile güncellenir.

## İşletim

`LOCAL_AI_URL` (repo variable), `LOCAL_AI_TOKEN` (repo secret) ve `LOCAL_AI_WHISPER_SIZE` (repo variable) üretim env dosyasına aktarılır. Boş değerler yerel servisi devreye almaz. Token tarayıcıya verilmez. Docker profilini açmak, model dosyalarını indirmek ve gerçek Türkçe örneklerle kalite/hız ölçmek ayrıca gereken kurulum adımlarıdır. Varsayılanlar API/MCP çalışması için model indirmez.

Bu değişiklik şema veya seed gerektirmez. Ayarlar mevcut çalışma alanı JSON alanında, MCP işleri mevcut `scheduled_jobs` tablosunda saklanır. Yerel servisi kaldırmak diğer servisleri durdurmaz; ilgili Yerel işleri önce kapatın veya bilerek başka bir sağlayıcı seçin.
