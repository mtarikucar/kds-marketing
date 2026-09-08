# Jeeta Masaüstü

Bir telefonu çalışma alanınıza bağlayan köprü. Jeeta sunucuda çalışır, telefon
sizin masanızdadır; arada bu uygulama vardır.

## Neden bir köprü var

Sunucu telefona ulaşamaz ve hiçbir zaman ulaşamayacak — arada bir dizüstü, bir
kablo ve bir insan var. Bu yüzden hiçbir komut telefona *gönderilmez*: Jeeta
komutu kuyruğa yazar, bu uygulama onu **alır**, yapar ve sonucu geri yazar.

Bunun pratik sonucu: **kuyruğa yazılmış bir komut olmuş bir komut değildir.**
Dizüstü kapalı olabilir, kablo çıkmış olabilir, siz "hayır" demiş olabilirsiniz.

## Kurulum

1. Android telefonda **Geliştirici seçenekleri → USB hata ayıklama**'yı açın.
2. Bilgisayara **Android Platform Tools**'u kurun (`adb` PATH'te olmalı).
3. Telefonu USB ile bağlayın ve ekranda çıkan **"Bu bilgisayara izin ver"**
   uyarısını onaylayın. (Onaylamazsanız uygulama telefonu "yetkisiz" olarak
   gösterir — liste boş görünmez, ne yapmanız gerektiğini söyler.)
4. Jeeta'da **Ayarlar → API ve bağlayıcı → API anahtarları**'ndan bir anahtar
   üretin. Anahtar yalnızca bir kez gösterilir.
5. Aynı sayfanın **Eşleşmiş telefonlar** sekmesinde telefonu ekleyin ve çıkan
   **cihaz kimliğini** kopyalayın. Telefon önce orada var olmalı: kimliği üreten
   şey o kayıttır.
6. Uygulamaya sunucu adresini, anahtarı ve cihaz kimliğini girin, telefonu
   seçin, **Başlat**'a basın.

Kimlik doğru girildiğinde o sayfadaki rozet birkaç saniye içinde **"Köprü
çevrimiçi"**ye döner — dönmüyorsa bakılacak yer bu uygulamadır, kuyruk değil.

## Bir yapay zekâ telefonu nasıl sürer

Ekranı okumadan dokunmak, karanlıkta düğme aramaktır. Akış şu:

1. `UI_DUMP` — ekrandaki **dokunulabilir/okunabilir** öğelerin listesi döner.
   Ham XML değil: uiautomator'ın birkaç yüz kilobaytlık ağacı, birkaç kilobaytlık
   düğme listesine indirgenir (metin, id, açıklama, sınıf ve **dokunulacak nokta**).
2. `TAP_ON` — gördüğün etiketle bas. Öğeyi **aynı komut içinde** yeniden bulup
   basar; okuman ile dokunman arasında liste oturursa, bildirim düşerse ya da
   klavye açılırsa yanlış yere basmazsın. Ham koordinatlı `TAP` yalnızca hiç
   etiketi olmayan yerler için.

Tam eşleşme kısmi eşleşmeyi yener — "Sil", "Silinenler"e basmaz — ve aynı yazan
satırlar için `occurrence` vardır.

`TEXT` yalnızca düz ASCII kabul eder ve Türkçe karakterde **reddeder**. Sebebi
sessiz olması: `adb shell input text` harfleri ASCII tuş kodlarına eşler, yani
"Ayşe" yavaş ya da eksik değil, **yanlış** yazılır ve telefon yine de "oldu" der.
Mesaj metni için `?text=` URL-kodlu bir wa.me bağlantısı, listeden seçim için
`TAP_ON` doğru yollardır.

`SCREENSHOT` ekran görüntüsünü base64 döndürmez: sunucuda yüklenir, sonuçta bir
bağlantı gelir. Depolama yapılandırılmamışsa resim atılır ve sonuç bunu söyler —
megabaytlarca metni bir modelin bağlamına dökmek, resmi hiç göndermemekten kötüdür.

**Kesintisiz çalışma:** cihaz `AUTO` moddayken bu döngüde kimseye sorulmaz.
`MANUAL`'de her adım için bu pencerede onay istenir — yavaştır ama izlenebilir.

## Güvenlik — niyet değil, yapı

- **Cihaz varsayılan olarak `MANUAL`.** Her komut için siz onaylarsınız. Bu bir
  ayar dosyasında değil, **sunucuda** tutulur: kuyruk, cihazın yapmayacağı bir
  şeyi vaat edemez.
- **Reddetmek bir hata değildir.** "Hayır" dediğinizde sonuç `REFUSED` olarak
  kaydedilir — döngüde bir insan olduğunu kanıtlayan tek sinyal, arıza gibi
  görünmez.
- **`SHELL` komutu yoktur ve bilerek yoktur.** Birinin kişisel telefonuna
  uzaktan kabuk erişimi, "şu linki aç"tan başka bir risk sınıfıdır.
- **Sadece `https` ve `tel` açılır.** `intent:` bir bileşeni ve parametrelerini
  adlandırabildiği için dışarıda bırakıldı.
- **API anahtarı iptal edilirse uygulama durur**, yeniden denemez.
- **Duraklatmak kuyruğu BOŞALTIR**, beklemeye almaz. Ayarlardaki "Duraklat" bir
  tutma değil, durdurma düğmesidir; bekleyen ne varsa düşer.
- **Komutların ömrü vardır.** Bir hafta sonra takılan telefon, bir günlük
  dokunuşu peş peşe tekrar etmez: o komutların yazıldığı ekran çoktan yok.

## Paketleme

```
npm run pack     # taşınabilir klasör + zip  → release/
npm run dist     # imzalı NSIS kurulumu (aşağıya bakın)
```

`npm run pack` hiçbir ayrıcalık istemez: Electron çalışma zamanını kopyalar,
uygulamayı içine koyar, `JeetaMasaustu.exe` olarak adlandırır ve zip'ler.
Açıp çalıştırmak yeterlidir.

`npm run dist` (electron-builder) **düz bir Windows hesabında çalışmaz**: indirdiği
kod imzalama araç zinciri macOS sembolik bağları içerir ve Windows'ta sembolik bağ
oluşturmak Geliştirici Modu ya da yükseltilmiş bir kabuk ister. Bunu açmak makine
sahibinin kararıdır, bir derleme adımının değil — o yüzden `pack` yanında duruyor.

Zaten ikisi de **imzasız**: elimizde sertifika yok, ve imzasız bir NSIS kurulumu
Windows'ta zip'ten daha yüksek sesle uyarmaz. Kayıp olan Başlat menüsü girdisi,
otomatik güncelleme ve .exe'nin kendi ikonu/sürüm bilgisidir.

## Geliştirme

```
npm install
npm run typecheck
npm test
```

`src/adb.ts` cihaz katmanı, `src/bridge.ts` döngü. Her `adb` çağrısı argümanları
**dizi** olarak geçer — asla kabuk dizesi olarak. Komutlar bir yabancının web
sitesinden gelen URL'ler ve bir LLM'in yazdığı metin taşır.
