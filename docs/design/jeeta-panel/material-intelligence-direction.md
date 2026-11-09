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

## Kaynak incelemesinde bulunan mevcut durum

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

Bu belge hedef ve teknik incelemedir. Burada tarif edilen yeni materyal otomasyonu henüz uygulanmadı veya yayına alınmadı.
