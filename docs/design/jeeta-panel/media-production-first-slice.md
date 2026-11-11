# Üretim alanları — ilk çalışan dilim

Tarih: 2026-11-09. Kapsam, [uçtan uca planın](media-production-operating-plan.md) ilk uygulama adımıdır.

## Kullanıcı akışı

1. Büyüme stüdyosu → Üretim alanları üzerinden bir iş ve kısa hedef oluşturulur. Strateji onayı olmadan hazırlık yapılabilir.
2. Kütüphaneden kaynak seçilir veya dosya yüklenir. Materyaller iş içinde toplanır; başka işlerde de kullanılabilir.
3. Eksik çekimler talep olarak kaydedilir. Gerçek materyal teslim edilmeden talep tamamlanamaz.
4. Kaynaklar seçilip düzenleme talimatı verilir. İstek mevcut ajan kuyruğuna girer. İşlenmedikçe “ajan bekleniyor” durumunda kalır.
5. Tamamlanan düzenleme ayrı materyal olarak görünür. Geçerli çıktılar sonraki düzenlemeye kaynak olabilir; orijinal korunur.
6. Kanal çıktısı, format ve hedef tarih kaydedilir. Bunlar henüz yayın kaydı değildir.
7. Strateji, kanal ve materyal koşulları sağlanınca çıktı mevcut paylaşım motorunda gerçek takvim kaydına dönüştürülür. İçerik mevcut editörle aynı üretim alanında hazırlanır; mevcut onay ve yayın kuralları devam eder.

## Veri ve davranış

- İşletme çalışma alanı ile üretim alanı farklı kavramlardır. Yeni `studio_production_projects` tablosu işletme kapsamında FORCE RLS uygular.
- Proje değişiklikleri sürümlüdür. Arka planda veri değişirse açık form sessizce üzerine yazmaz. Üretim ve zamanlama istekleri aynı anahtarla tekrarlandığında çoğalmaz.
- Değişen kaynak sürümü açıkça yenilenir. Kaynak kaldırma veya brief değişikliği ilgili düzenleme işlerini geçersizleştirir; eski sonuçlar geçmişte korunur.
- Arşivleme devam eden düzenleme işlerinin yetkisini kaldırır. Daha önce mevcut paylaşım motoruna alınan yayınları iptal etmez; arayüz bunu açıklar.
- Üretilen materyal otomatik paylaşım izni kazanmaz. İçerik, kaynak, yetki ve zamanlama denetimleri mevcut motor üzerinden yapılır.
- Liste imleçle sayfalanır. HTTP/MCP sözleşmeleri ve araç envanterleri birlikte güncellenmiştir.

## Görsel işçisi

[Harici işçi](../../../rust/scripts/production-worker/README.md) statik görsel analizi ve tek kaynaklı dikdörtgen kırpmayı destekler. Jeeta anahtarı deterministik yöneticide kalır; modele araç veya yayın yetkisi verilmez. Video, serbest görsel düzenleme ve afiş istekleri bu işçi tarafından tamamlanmış sayılmaz.

Yerel denemede gerçek MCP, PostgreSQL ve dosya sunucusu üzerinden sabit bir test tarifiyle kırpma tamamlandı ve sonuç üretim alanına bağlandı. Bu, dosya ve piksel hattının kanıtıdır. Gerçek Codex model çağrısı kimlik doğrulama hatası verdi: kayıtlı oturum kullanılabilir çıkarım erişimi sağlamıyordu. Bu sürüm sürekli çalışan veya sunucuya kurulmuş bir ajan içerdiği iddiasında değildir.

## Doğrulama sınırı

- Sentetik yerel hesapla proje oluşturma, kaynak bağlama, gerçek teslimle talep kapatma, mükerrer iş önleme, eski sürüm reddi ve gerçek kırpılmış dosya kaydı denendi.
- Gerçek tarayıcıda hedef çıktı oluşturuldu; hedef tarih tek başına yayın kaydı oluşturmadı.
- Dört proje bölümü masaüstü ve mobilde incelendi; mobil sekme taşması düzeltildi.
- Takvim bağlantısı, yetkiler, strateji ve materyal denetimleri uygulama testlerinde; tenant izolasyonu ve migration geri dönüş koruması gerçek PostgreSQL testlerinde kapsanır.
- Yerel testte dış sosyal hesaba gönderi yapılmadı. Kalıcı model kimliği, sunucu işçisi kurulumu ve gerçek sağlayıcı kabul testi ayrı devreye alma adımlarıdır.

Sonraki dilimler: video kurgu/render, serbest görsel üretim/düzenleme, kalıcı işçi işletimi ve bütçe takibi, çoklu kanal varyantları, sonuç ölçümü.

## Yerel kontrol sonucu

- Panel TypeScript denetimi ve Vite derlemesi başarılı. Yeni proje testleri 12/12. Tam panel koşusunda 508/509; değişmeyen saniye bazlı heartbeat testi tek dosya tekrarında 23/23 başarılı.
- Tüm Rust workspace testleri çalıştırıldı. Bulunan sekiz hedefin sorunları giderildi: eksik üretim binary fixture yolu, proje testinin insan/ajan bağlamı, HTTP araç envanterleri ve tarihsel migration sıralaması. İlgili hedeflerin tekrar koşusu 414/414; migration tekrar koşusu 32/32 başarılı. İlk koşu tek başına tamamen yeşil değildi.
- `cargo clippy --locked --workspace --all-targets -- -D warnings`, biçim ve diff kontrolleri başarılı.
- Görsel işçisi 17/17 test. Gerçek MCP/dosya denemesinde 640×427 kaynak, sabit test tarifiyle 427×427 PNG çıktıya dönüştü; orijinal ve paylaşım kararı korundu.
- Dört bölüm × iki ekran genişliğinde (1440/390) tarayıcı hatası, başarısız HTTP yanıtı veya yatay taşma yok. Yerel HTTPS medya alanı tarayıcı proxy'si nedeniyle aynı yerel sunucuya yönlendirilerek test edildi.
- Bu dilim staging veya production ortamına dağıtılmadı; sürekli işçi servisi kurulmadı. Model çıkarımı kimlik doğrulama nedeniyle doğrulanamadı.
