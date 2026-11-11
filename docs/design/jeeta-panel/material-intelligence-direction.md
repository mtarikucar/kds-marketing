# Materyalden içeriğe: ürün hedefi

Kullanıcının 9 Kasım2026 tarif ettiği hedef: işletmenin yüklediği fotoğraf ve videoları anlayan, kendiliğinden düzenleyen ve stratejiye uygun yeni içerik üretiminde kullanabilen bir kütüphane. Kullanıcı materyal sağlar ve gerektiğinde düzeltir; sisteme her dosya için sınıflandırma yaptırmak zorunda kalmaz.

## İstenen davranış

1. **Yükleme:** olay/etiket formu zorunlu olmadan dosyaları kabul et. Yükleme zamanını gerçek çekim zamanı olarak sunma; EXIF/MP4 tarihi, saat dilimi, yükleme zamanı ve çıkarılan olay tarihinin kaynağını ayrı tut.
2. **Anlama:** içerik açıklaması, nesne/konu, kalite, kişi/mahremiyet işaretleri ve işletmeye özgü serbest etiketler çıkar. Figürünica sözlüğünü diğer işletmelere dayatma.
3. **Düzenleme:** mevcut gruba kat veya anlamlı yeni grup oluştur. Benzer görsel kümesi ile tarih/yer iddiası taşıyan bir olay aynı şey değildir. Güvensiz tarih/olay çıkarımını gerçek bilgi gibi kaydetme.
4. **Manuel kontrol:** başlık, tarih, etiket ve grubu düzelt; grup birleştir/ayır. Kullanıcının düzeltmesini sonraki analiz sessizce değiştirmesin. Analiz sonucunun kaynağı ve durumu görülebilsin.
5. **Kullanılabilirlik:** kullanıcının isteğine göre yeni materyaller varsayılan olarak paylaşım üretiminde kullanılabilsin. Bu, ayrıca onaylanmış bir gönderi veya yapılmış yayın demek değildir. İzin kaynağı işletme politikası olarak kaydedilsin; sistem kararı kullanıcı onayıymış gibi yazılmasın.
6. **Üretim:** özgün fotoğrafı aynen kullanma zorunluluğu yok. Kırpma, düzenleme, kolaj, metinli afiş ve farklı kanal formatları yeni türev materyaller olarak oluşturulabilsin. Özgün dosya korunmalı; kaynaklar, işlemler ve türevler birbirine bağlanmalı.
7. **Yayın:** kullanılacak materyal/türev, metin, kanal ve zaman stratejiyle ilişkilensin. Mevcut onay/yayın akışı ayrıca çalışsın.

## Uygulama öncesi kaynak incelemesi

- `MaterialsUpload.tsx::pick` dosya tarihi okuyor; `File.lastModified` yedeği gerçek çekim tarihiyle karışabiliyor. `library/items.rs::material_add` tarihi tekrar inceliyor. `olay_suggestions` yalnız mevcut olayların tarih aralıklarıyla eşleşiyor. Görsel anlama ve otomatik olay oluşturma yok.
- Sabit `ProductGroup`, `Door`, `ContentType` enumları domain `material.rs`, panel `api/materials.ts` ve MCP schema içinde. `SlotNeed::from_keys/matches` de bunları kullanıyor. DB etiketleri JSONB olduğundan yalnız SQL enum değiştirmek sorunu çözmez.
- MCP materyal ekleme/etiketleme ve olay oluşturma araçları var, fakat `work.pending` içinde materyal analiz işi yok. Ajanı başlatmak mevcut tasarımda dış istemcinin işi. Codex bağlantısı tek başına yükleme tetikleyicisi değildir.
- `material_get` yalnız metadata sunuyor. FileStore okuma altyapısı var; yetkili materyal önizlemesi ve ajan dosya erişimi için tenant/izin/silinmiş-kayıt kontrolleri olan usecase gerekiyor.
- Mevcut paylaşım izni gerçek materyallerde sahip/yöneticiye bağlı. Kalite ve doğrulanmış olay uygunluğu da paylaşım seçimini etkiliyor. Varsayılan izin, yalnız arayüzde bir radio seçerek çözülemez.
- `MaterialTagInput` başlık/çekim tarihi düzenlemiyor. Kaynak→türev ilişkisi yok; köken yalnız `real|ai_generated`. Düzenlenmiş gerçek fotoğrafı bütün kurallarda sıradan yapay görsele çevirmek yanlış uygunluk sonuçları doğurabilir.

## Uygulama sırası ve tamamlanma ölçütü

- İşletmeye ait dinamik etiketler, tarih kaynağı ve manuel alan sahipliği; eski etiketleri kayıpsız taşıyan uyumluluk; ilgili materyal seçme kuralları.
- Gerçek dosya önizlemesi ve yetkili ajan okuması; olay seçimi beklemeden yükleme; güvenilir varsayılan izin politikası.
- Dosya/sürüm başına tekilleşen analiz işi, claim/lease, başarı/hata/tekrar deneme ve ajan sonuç teslimi. Otomatik çalışmayı sağlayan dış Codex runner bağlantısı ayrıca kurulmalı ve çalışır halde doğrulanmalı.
- Dinamik küme/olay önerisi ve güvenli otomatik bağlama; düzeltme ve yeniden analizde kullanıcı tercihini koruma.
- Kaynak revizyonlarını ve işlemi kaydeden türev üretim isteği; yeni çıktı dosyası; önizleme, kullanım ve silme/izin etkilerini izleme.

Bir iş akışı, yalnız ekranda “analiz ediliyor” yazdığı için otomatik sayılmaz. Tamamlanma ölçütü: yükleme sonrasında gerçekten çalışan ajan dosyayı okuyup sonucu kaydeder; materyal/grup/etiket ve gerekirse türev, kullanıcının dosya başına form doldurmasına gerek olmadan görünür olur; başarısız işler açıkça tekrar denenebilir.

## 9 Kasım uygulaması

Geliştirme dalına eklenen akış:

- İşletmeye özgü serbest `labels`; eski ürün/kapı/içerik sınıfları mevcut kayıtlarla uyumlu kalır. Yeni yüklemede bu sabit sınıflar zorunlu değildir. Stratejinin cadence içerik tipi anahtarındaki `label:<etiket>` açık eşleşme talebidir; eski bilinmeyen segment anahtarları anlam değiştirmez.
- Sahip/yönetici yüklemesinde genel kütüphane ve paylaşılabilir seçili gelir; izin seçimi görünürdür ve yükleme isteğinde açıkça gönderilir. Bu bir işletme genelinde otomatik izin politikası veya yayın onayı değildir. Diğer rollerin mevcut izin sınırları korunur.
- Dosyanın gömülü tarihi, elle düzeltilen tarih ve ajan çıkarımı ayrılır. `File.lastModified` gerçek çekim tarihi olarak kullanılmaz. Elle temizlenen tarih de sonraki analize karşı korunur.
- Her yeni materyal analiz için sıraya alınır. Eski canlı materyaller de ajan iş listesinde analiz için bulunabilir. Ajan işi süreli olarak alır, yetkili kısa ömürlü önizlemeden dosyayı inceler ve açıklama/etiket/grup/kalite sonucunu teslim eder. Başka ajanın veya eski revizyonun sonucu kabul edilmez.
- Grup adları kütüphanede dinamik bölüm ve filtre oluşturur. Görsel kümesi, doğrulanmış olay/tarih iddiasından ayrı tutulur. Mevcut olay araçları çalışmaya devam eder; analiz görselden kesin olmayan bir etkinliği doğrulanmış gibi yaratmaz.
- Başlık, tarih, etiket, açıklama ve grup düzeltilebilir. Açık insan düzeltmeleri sonraki analizde korunur. Bekleyen/çalışan/başarılı/hatalı durumlar ve yeniden analiz isteği görünürdür.
- Düzenleme, kırpma ve afiş üretimi kaynak revizyonlarına bağlı ayrı iş istekleridir. Ajan kendi görsel araçlarıyla çıktı üretip yeni materyal olarak kaydeder; orijinal dosya değişmez. Tamamlanan çıktı kaynaklarıyla ilişkilendirilir, kişi/mahremiyet işaretlerini korur ve ayrıca paylaşım değerlendirmesi gerektirir. Kaynak izin kaldırma/silme işlemi türevlerine de yansır.

### Çalıştırma sınırı

MCP bağlantısı dış ajana araç erişimi verir; kendi başına sürekli çalışan bir işlem değildir. `work.checkin` çağıran Codex/Claude yeni analiz ve üretim işlerini alır. Sunucu model, görüntü üretim servisi veya ajan başlatıcı çalıştırmaz. Gerçek otomatik yürütme için dosyayı görebilen/görsel üretebilen dış ajan istemcisinin çalışması ve düzenli kontrol yapması gerekir. Çalışmıyorsa panel işi bekliyor gösterir. Bu değişiklikle herhangi bir dış ajan zamanlayıcısı kurulmadı veya staging üzerinde gerçek model çağrısı doğrulanmadı.

Önizleme adresleri 10 dakika geçerli imzalı erişim bağlantılarıdır; verilmeden önce çalışma alanı, izin, materyal ve dosya kontrol edilir. Mevcut dosya sunucusu bağlantıyı yeniden DB yetkilendirmesiyle kontrol etmez; süre dolması veya fiziksel dosya temizliği erişimi sonlandırır. Silinen materyaller yayın denemelerinin mevcut güvenli dosya temizleme akışını kullanır.

### Yayın durumu

Bu değişiklikler geliştirme dalındadır; staging veya production yayını yapılmadı. Yeni `0029_material_intelligence` ve `0030_material_productions` migration dosyaları uygulamayla birlikte kurulmalıdır. Önceki çağrı ayarları değişikliği de aynı dalda yer alır.

### Doğrulama kaydı

- `cargo fmt --all -- --check` ve çalışma alanının tüm hedeflerinde `cargo clippy --locked --workspace --all-targets -- -D warnings`.
- Materyal kütüphanesi 22, analiz 9, türev üretim 7, ajan iş listesi/MCP/HTTP 8 test; mevcut gönderi/iş akışı testleri de geçti.
- Gerçek izole PostgreSQL üzerinde analiz/üretim saklama, tenant sınırı, claim kilidi ve dolu tabloda veri kaybettiren rollback engeli 4 test. Migration envanteri, tam up/down/up ve ilgili eski migration döngüleri ayrıca doğrulandı.
- Katalog/registry, izin ve mimari kontrolleri geçti; kayıt sayıları yeni ajan araçlarına göre güncellendi.
- Panelin ilgili 54 testi geçti; son UI değişikliklerinden sonra ilgili 19 test tekrar geçti. TypeScript ve Vite üretim derlemesi başarılı; mevcut büyük chunk uyarısı sürüyor.
- Masaüstü ve mobilde 5 görünüm / 10 ekran görüntüsü: taşma ve tarayıcı çalışma zamanı hatası yok. `/workspace/jeeta-materials-review/index.html` örnek verili yerel inceleme galerisidir.
- Dış Codex/Claude süreci ile gerçek görsel analizi/üretim çağrısı ve staging yayını bu doğrulamanın kapsamında değildir.
